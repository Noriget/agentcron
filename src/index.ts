import { Hono } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';

type Env = {
  DB: D1Database;
  APP_SECRET: string;
  FROM_EMAIL: string;
  APP_URL: string;
  RESEND_API_KEY?: string;
  STRIPE_SECRET_KEY?: string;
  STRIPE_PRICE_ID?: string;
  STRIPE_PRICE_ID_ANNUAL?: string;
  STRIPE_WEBHOOK_SECRET?: string;
};

const app = new Hono<{ Bindings: Env; Variables: { uid: number } }>();

// plan limits
const FREE_MAX_TASKS = 5, PRO_MAX_TASKS = 200;
const FREE_MIN_INTERVAL = 300, PRO_MIN_INTERVAL = 60; // seconds
const FREE_RUNS_MONTH = 1000, PRO_RUNS_MONTH = 100000;
const TICK_LIMIT = 25; // jobs processed per minute tick

// ---------- helpers ----------
const enc = new TextEncoder();
const b64url = (buf: ArrayBuffer | Uint8Array) =>
  btoa(String.fromCharCode(...new Uint8Array(buf as ArrayBuffer))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromB64url = (s: string) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
const hex = (buf: ArrayBuffer) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');

async function pbkdf2(password: string, salt: Uint8Array) {
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  return b64url(await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' }, key, 256));
}
async function hashPassword(p: string) { const s = crypto.getRandomValues(new Uint8Array(16)); return `${b64url(s)}.${await pbkdf2(p, s)}`; }
async function verifyPassword(p: string, stored: string) { const [s, h] = stored.split('.'); if (!s || !h) return false; return (await pbkdf2(p, fromB64url(s))) === h; }
async function hmac(secret: string, data: string) {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return b64url(await crypto.subtle.sign('HMAC', key, enc.encode(data)));
}
async function makeToken(secret: string, uid: number) { const p = b64url(enc.encode(JSON.stringify({ uid, exp: Date.now() + 30 * 864e5 }))); return `${p}.${await hmac(secret, p)}`; }
async function readToken(secret: string, t?: string) {
  if (!t) return null; const [p, sig] = t.split('.'); if (!p || !sig) return null;
  if ((await hmac(secret, p)) !== sig) return null;
  try { const { uid, exp } = JSON.parse(new TextDecoder().decode(fromB64url(p))); if (!uid || Date.now() > exp) return null; return uid as number; } catch { return null; }
}
const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
async function newApiKey() { return 'ac_' + hex(await crypto.subtle.digest('SHA-256', crypto.getRandomValues(new Uint8Array(20)))).slice(0, 40); }
const isoOrDash = (ms: any) => (ms ? new Date(Number(ms)).toISOString() : '—');

function layout(title: string, body: string, user?: boolean, jsonLd?: string) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${esc(title)} · AgentCron</title>
  <meta name="description" content="${esc(title)} — AgentCron: let your AI agent schedule tasks, reminders and recurring jobs via MCP. Run later, run on a schedule.">
  ${jsonLd ? `<script type="application/ld+json">${jsonLd}</script>` : ''}
  <style>
    :root{--brand:#0d9488;--ink:#0f172a;--muted:#64748b;--border:#e2e8f0;--bg:#f6faf9}
    *{box-sizing:border-box}body{margin:0;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:var(--ink);background:var(--bg);line-height:1.6}
    a{color:var(--brand);text-decoration:none}.wrap{max-width:880px;margin:0 auto;padding:0 18px}
    header.nav{background:#fff;border-bottom:1px solid var(--border)}header.nav .wrap{display:flex;justify-content:space-between;align-items:center;height:58px}
    .logo{font-weight:800;font-size:20px;color:var(--ink)}.logo b{color:var(--brand)}
    .btn{display:inline-block;background:var(--brand);color:#fff;border:none;border-radius:8px;padding:10px 16px;font-weight:700;cursor:pointer;font-size:14px}
    .btn.ghost{background:#eef2f7;color:var(--ink)}
    .card{background:#fff;border:1px solid var(--border);border-radius:14px;padding:20px;margin:16px 0}
    input,textarea{width:100%;padding:10px;border:1px solid var(--border);border-radius:8px;font-size:14px;font-family:inherit;margin:6px 0 12px}
    label{font-size:13px;color:var(--muted);font-weight:600}
    h1{font-size:28px}h2{font-size:20px;margin-top:28px}.muted{color:var(--muted);font-size:14px}
    table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:8px;border-bottom:1px solid var(--border);font-size:13px;vertical-align:top}
    code,pre{background:#0f172a;color:#e2e8f0;border-radius:8px;font-size:13px}code{padding:2px 6px}pre{padding:14px;overflow:auto;white-space:pre}
    main{padding:24px 0 60px}
  </style></head><body>
  <header class="nav"><div class="wrap"><a class="logo" href="/">Agent<b>Cron</b></a><nav><a href="/docs">Docs</a> &nbsp; ${user ? '<a href="/dashboard">Dashboard</a> &nbsp; <a href="/logout">Log out</a>' : '<a href="/login">Log in</a> &nbsp; <a class="btn" href="/signup">Sign up free</a>'}</nav></div></header>
  <main><div class="wrap">${body}</div></main>
  <footer style="border-top:1px solid var(--border);background:#fff"><div class="wrap" style="padding:18px;font-size:13px;color:var(--muted)"><a href="/">Home</a> · <a href="/docs">Docs</a> · <a href="/signup">Sign up</a> · <a href="/terms">Terms</a> · <a href="/privacy">Privacy</a> · © ${new Date().getFullYear()} AgentCron · MGM LLC</div></footer>
  </body></html>`;
}

async function requireAuth(c: any, next: any) {
  const uid = await readToken(c.env.APP_SECRET, getCookie(c, 'ac_session'));
  if (!uid) return c.redirect('/login');
  c.set('uid', uid); await next();
}
const getUser = (env: Env, uid: number) => env.DB.prepare('SELECT * FROM users WHERE id=?').bind(uid).first<any>();

// ---------- delivery ----------
async function sendEmail(env: Env, to: string, subject: string, text: string) {
  if (!env.RESEND_API_KEY || !to) return false;
  try {
    const r = await fetch('https://api.resend.com/emails', { method: 'POST', headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ from: env.FROM_EMAIL, to, subject, html: `<p>${esc(text).replace(/\n/g, '<br>')}</p>` }) });
    return r.ok;
  } catch { return false; }
}
async function postJson(url: string, payload: any) { try { const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }); return r.ok; } catch { return false; } }

async function deliverNotify(env: Env, user: any, title: string, message: string, channel: string) {
  const text = message ? `${title}\n\n${message}` : title;
  const sent: string[] = [];
  const want = (ch: string) => channel === 'all' || channel === ch;
  if (want('email') && user.dest_email) { if (await sendEmail(env, user.dest_email, `⏰ ${title}`, message || title)) sent.push('email'); }
  if (want('slack') && user.slack_webhook) { if (await postJson(user.slack_webhook, { text })) sent.push('slack'); }
  if (want('discord') && user.discord_webhook) { if (await postJson(user.discord_webhook, { content: text })) sent.push('discord'); }
  if (want('webhook') && user.webhook_url) { if (await postJson(user.webhook_url, { title, message, at: Date.now() })) sent.push('webhook'); }
  return sent;
}

// ---------- stripe ----------
async function hmacHex(secret: string, data: string) {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hex(await crypto.subtle.sign('HMAC', key, enc.encode(data)));
}
async function stripeApi(env: Env, path: string, params: Record<string, string>) {
  const r = await fetch('https://api.stripe.com/v1/' + path, { method: 'POST', headers: { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(params) });
  return r.json() as any;
}

async function runsThisMonth(env: Env, uid: number) {
  const r = await env.DB.prepare('SELECT COUNT(*) AS n FROM runs_log WHERE user_id=? AND at>?').bind(uid, Date.now() - 30 * 864e5).first<any>();
  return (r && r.n) || 0;
}
async function activeTaskCount(env: Env, uid: number) {
  const r = await env.DB.prepare("SELECT COUNT(*) AS n FROM jobs WHERE user_id=? AND status='pending'").bind(uid).first<any>();
  return (r && r.n) || 0;
}

// =================== MARKETING / AUTH / DASHBOARD ===================
app.get('/', async (c) => {
  if (await readToken(c.env.APP_SECRET, getCookie(c, 'ac_session'))) return c.redirect('/dashboard');
  return c.html(layout('Let your AI agent schedule tasks & reminders', `
    <h1>Give your AI agent a sense of time.</h1>
    <p class="muted" style="font-size:17px">AgentCron is an MCP server that lets your AI agent <strong>schedule things for later</strong> — a one-off reminder, a delayed webhook callback, or a recurring job. Agents can't wait or run on a schedule. Now they can.</p>
    <p><a class="btn" href="/signup">Get your MCP key — free</a> &nbsp; <a href="/docs">Read the docs →</a></p>
    <div class="card"><strong>Add it to your MCP client</strong>
      <pre>{
  "mcpServers": {
    "agentcron": {
      "url": "${esc(c.env.APP_URL)}/mcp",
      "headers": { "Authorization": "Bearer YOUR_API_KEY" }
    }
  }
}</pre>
      <p class="muted">Then your agent has <code>schedule_task</code>, <code>list_tasks</code>, and <code>cancel_task</code>. Works with Claude, Cursor, Cline, and any MCP client.</p>
    </div>
    <h2>What it's for</h2>
    <ul class="muted"><li>"Remind me in 2 hours to review the PR." → notification later</li><li>"Check the deploy every 10 minutes and ping me if it fails." → recurring webhook</li><li>"Email me a summary every weekday at 9am." → recurring notification</li><li>"Call this webhook in 30 minutes to resume the workflow." → delayed callback</li></ul>
    <h2>Why AgentCron</h2>
    <ul class="muted"><li>Tools: <code>schedule_task</code> · <code>list_tasks</code> · <code>cancel_task</code></li><li>Deliver to email, Slack, Discord, webhook — or POST any webhook</li><li>One-off or recurring (repeat interval)</li></ul>
    <h2>Pricing</h2>
    <div class="card"><strong>Free</strong> — <span class="muted">${FREE_MAX_TASKS} active tasks · runs as often as every ${FREE_MIN_INTERVAL / 60} min · ${FREE_RUNS_MONTH.toLocaleString()} runs/month.</span></div>
    <div class="card"><strong>Pro — $9/mo or $90/yr</strong><ul class="muted" style="margin:6px 0 0"><li><strong>${PRO_MAX_TASKS} active tasks</strong> (vs ${FREE_MAX_TASKS})</li><li>Schedule as often as <strong>every ${PRO_MIN_INTERVAL}s</strong> (vs ${FREE_MIN_INTERVAL / 60} min)</li><li><strong>${PRO_RUNS_MONTH.toLocaleString()} runs/month</strong> (vs ${FREE_RUNS_MONTH.toLocaleString()})</li><li>Priority email support</li></ul></div>
    <p><a class="btn" href="/signup">Get started free</a></p>
  `));
});

app.get('/signup', (c) => c.html(layout('Sign up', `
  <h1>Create your account</h1>
  <form method="POST" action="/signup" class="card" style="max-width:420px">
    <label>Email</label><input name="email" type="email" required>
    <label>Password (12+ characters)</label><input name="password" type="password" minlength="12" required>
    <label style="display:flex;gap:6px;align-items:flex-start;font-weight:400;font-size:13px"><input type="checkbox" name="agree" value="1" required style="width:auto;margin-top:3px"> <span>I agree to the <a href="/terms" target="_blank">Terms</a> and <a href="/privacy" target="_blank">Privacy Policy</a>.</span></label>
    <button class="btn" type="submit">Sign up free</button>
    <p class="muted">Have an account? <a href="/login">Log in</a></p>
  </form>`)));

app.post('/signup', async (c) => {
  const b = await c.req.parseBody();
  const email = String(b.email || '').trim().toLowerCase();
  const password = String(b.password || '');
  if (!email || password.length < 12) return c.html(layout('Sign up', `<div class="card">Password must be at least 12 characters. <a href="/signup">Back</a></div>`));
  if (!b.agree) return c.html(layout('Sign up', `<div class="card">You must agree to the Terms and Privacy Policy. <a href="/signup">Back</a></div>`));
  if (await c.env.DB.prepare('SELECT id FROM users WHERE email=?').bind(email).first()) return c.html(layout('Sign up', `<div class="card">Email already registered. <a href="/login">Log in</a></div>`));
  const key = await newApiKey();
  const res = await c.env.DB.prepare('INSERT INTO users (email,password,api_key,dest_email,created_at) VALUES (?,?,?,?,?)').bind(email, await hashPassword(password), key, email, Date.now()).run();
  setCookie(c, 'ac_session', await makeToken(c.env.APP_SECRET, res.meta.last_row_id as number), { httpOnly: true, secure: c.env.APP_URL.startsWith('https'), sameSite: 'Lax', path: '/', maxAge: 30 * 864e2 });
  return c.redirect('/dashboard');
});

app.get('/login', (c) => c.html(layout('Log in', `
  <h1>Log in</h1>
  <form method="POST" action="/login" class="card" style="max-width:420px">
    <label>Email</label><input name="email" type="email" required>
    <label>Password</label><input name="password" type="password" required>
    <button class="btn" type="submit">Log in</button>
    <p class="muted">No account? <a href="/signup">Sign up</a></p>
  </form>`)));

app.post('/login', async (c) => {
  const b = await c.req.parseBody();
  const user = await c.env.DB.prepare('SELECT * FROM users WHERE email=?').bind(String(b.email || '').trim().toLowerCase()).first<any>();
  if (!user || !(await verifyPassword(String(b.password || ''), user.password))) return c.html(layout('Log in', `<div class="card">Invalid email or password. <a href="/login">Back</a></div>`));
  setCookie(c, 'ac_session', await makeToken(c.env.APP_SECRET, user.id), { httpOnly: true, secure: c.env.APP_URL.startsWith('https'), sameSite: 'Lax', path: '/', maxAge: 30 * 864e2 });
  return c.redirect('/dashboard');
});
app.get('/logout', (c) => { deleteCookie(c, 'ac_session', { path: '/' }); return c.redirect('/'); });

app.get('/dashboard', requireAuth, async (c) => {
  const u = await getUser(c.env, c.get('uid'));
  const isPro = u.plan === 'pro';
  const maxTasks = isPro ? PRO_MAX_TASKS : FREE_MAX_TASKS;
  const runsCap = isPro ? PRO_RUNS_MONTH : FREE_RUNS_MONTH;
  const active = await activeTaskCount(c.env, u.id);
  const usedRuns = await runsThisMonth(c.env, u.id);
  const jobs = await c.env.DB.prepare("SELECT * FROM jobs WHERE user_id=? ORDER BY (status='pending') DESC, run_at ASC LIMIT 30").bind(u.id).all();
  const rows = (jobs.results || []).map((j: any) => {
    const p = (() => { try { return JSON.parse(j.payload); } catch { return {}; } })();
    const what = j.action === 'webhook' ? `webhook → ${esc(p.url || '')}` : `notify: ${esc(p.title || '')}`;
    const rep = j.repeat_every ? `every ${j.repeat_every}s` : 'once';
    const cancel = j.status === 'pending' ? `<form method="POST" action="/tasks/cancel" style="display:inline"><input type="hidden" name="id" value="${j.id}"><button class="btn ghost" style="padding:4px 10px">Cancel</button></form>` : '';
    return `<tr><td>${j.id}</td><td>${esc(j.name || '')}<br><span class="muted">${what}</span></td><td>${esc(j.status)}</td><td>${esc(rep)}</td><td>${esc(isoOrDash(j.run_at))}</td><td>${j.runs}</td><td>${cancel}</td></tr>`;
  }).join('') || `<tr><td colspan="7" class="muted">No tasks yet. Your agent creates them with schedule_task.</td></tr>`;
  const billing = isPro
    ? `<form method="POST" action="/billing/portal" style="margin-top:8px"><button class="btn ghost">Manage billing</button></form>`
    : `<p class="muted" style="margin:10px 0 4px"><strong>Upgrade to Pro ($9/mo or $90/yr) for:</strong></p>
       <ul class="muted" style="margin:0 0 10px"><li><strong>${PRO_MAX_TASKS} active tasks</strong> (vs ${FREE_MAX_TASKS} on Free)</li><li>Run as often as <strong>every ${PRO_MIN_INTERVAL}s</strong> (vs ${FREE_MIN_INTERVAL / 60} min on Free)</li><li><strong>${PRO_RUNS_MONTH.toLocaleString()} runs/month</strong> (vs ${FREE_RUNS_MONTH.toLocaleString()})</li><li>Priority email support</li></ul>
       <form method="POST" action="/billing/checkout" style="display:inline-block"><button class="btn">Upgrade to Pro — $9/mo</button></form> <form method="POST" action="/billing/checkout?plan=annual" style="display:inline-block;margin-left:8px"><button class="btn ghost">Annual $90/yr</button></form>`;
  return c.html(layout('Dashboard', `
    <h1>Dashboard</h1>
    <div class="card"><strong>Plan: ${isPro ? 'Pro' : 'Free'}</strong> <span class="muted">— ${active}/${maxTasks} active tasks · ${usedRuns}/${runsCap} runs (30d) · min interval ${(isPro ? PRO_MIN_INTERVAL : FREE_MIN_INTERVAL)}s</span><br>${billing}</div>
    <div class="card"><strong>Your MCP key</strong>
      <pre>${esc(u.api_key)}</pre>
      <form method="POST" action="/regenerate-key" onsubmit="return confirm('Regenerate key? Old key stops working.')"><button class="btn ghost" type="submit">Regenerate key</button></form>
      <p class="muted" style="margin-top:10px"><strong>Cursor</strong> & clients with native Streamable HTTP:</p>
      <pre>{
  "mcpServers": {
    "agentcron": {
      "url": "${esc(c.env.APP_URL)}/mcp",
      "headers": { "Authorization": "Bearer ${esc(u.api_key)}" }
    }
  }
}</pre>
      <p class="muted" style="margin-top:10px"><strong>Cline, Claude Desktop</strong> & others (stdio bridge, needs Node.js):</p>
      <pre>{
  "mcpServers": {
    "agentcron": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "${esc(c.env.APP_URL)}/mcp", "--header", "Authorization: Bearer ${esc(u.api_key)}"]
    }
  }
}</pre>
      <p class="muted" style="font-size:13px">See the <a href="/docs">docs</a> for per-client steps.</p>
    </div>
    <div class="card" style="max-width:560px"><strong>Where to notify you</strong> <span class="muted">(used by notify tasks)</span>
      <form method="POST" action="/settings">
        <label>Email</label><input name="dest_email" type="email" value="${esc(u.dest_email)}">
        <label>Slack webhook URL</label><input name="slack_webhook" value="${esc(u.slack_webhook)}">
        <label>Discord webhook URL</label><input name="discord_webhook" value="${esc(u.discord_webhook)}">
        <label>Custom webhook URL</label><input name="webhook_url" value="${esc(u.webhook_url)}">
        <button class="btn" type="submit">Save</button>
      </form>
    </div>
    <h2>Scheduled tasks</h2>
    <div class="card"><table><thead><tr><th>ID</th><th>Task</th><th>Status</th><th>Repeat</th><th>Next run (UTC)</th><th>Runs</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>
  `, true));
});

app.post('/settings', requireAuth, async (c) => {
  const b = await c.req.parseBody();
  await c.env.DB.prepare('UPDATE users SET dest_email=?,slack_webhook=?,discord_webhook=?,webhook_url=? WHERE id=?')
    .bind(String(b.dest_email || ''), String(b.slack_webhook || ''), String(b.discord_webhook || ''), String(b.webhook_url || ''), c.get('uid')).run();
  return c.redirect('/dashboard');
});
app.post('/regenerate-key', requireAuth, async (c) => {
  await c.env.DB.prepare('UPDATE users SET api_key=? WHERE id=?').bind(await newApiKey(), c.get('uid')).run();
  return c.redirect('/dashboard');
});
app.post('/tasks/cancel', requireAuth, async (c) => {
  const b = await c.req.parseBody();
  await c.env.DB.prepare("UPDATE jobs SET status='canceled' WHERE id=? AND user_id=? AND status='pending'").bind(Number(b.id), c.get('uid')).run();
  return c.redirect('/dashboard');
});

// ----- legal -----
app.get('/terms', (c) => c.html(layout('Terms of Service', `
  <h1>Terms of Service</h1><p class="muted">Last updated: 2026-06-10. Operated by MGM LLC (MGM合同会社).</p>
  <p class="muted">AgentCron is provided "AS IS" without warranties of any kind. We do not guarantee the timing, execution, or delivery of scheduled tasks, nor uninterrupted service. Scheduled times are best-effort and may be delayed. To the maximum extent permitted by law, our total liability is limited to the greater of fees you paid in the prior 12 months or USD 100, and we are not liable for indirect or consequential damages. You are responsible for your use, your configured destinations, and any webhooks you ask us to call. Governed by the laws of Japan; exclusive jurisdiction: Tokyo District Court. Contact: contact@mgm-llc.org</p>`)));
app.get('/privacy', (c) => c.html(layout('Privacy Policy', `
  <h1>Privacy Policy</h1><p class="muted">Last updated: 2026-06-10.</p>
  <p class="muted">We store your account email, a hashed password, your API key, your notification destinations, and the scheduled tasks you create (including their payloads and run history). We do not sell data. Sub-processors: Cloudflare (hosting/DB) and Resend (email). Contact: contact@mgm-llc.org for access or deletion.</p>`)));

// =================== MCP (Streamable HTTP, stateless) ===================
const TOOLS = [
  {
    name: 'schedule_task',
    description: 'Schedule a task to run in the future, once or repeatedly. Use it to wait, remind, poll, or resume work later — agents cannot sleep or run on a schedule, so delegate timing here. The task either sends a notification to the account owner (action="notify") or POSTs to a webhook (action="webhook") at the scheduled time. Provide exactly one of in_seconds (delay from now) or run_at (ISO 8601 UTC time). Add repeat_every_seconds to make it recurring.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['notify', 'webhook'], description: 'notify = send the owner a message; webhook = POST to a URL. Default notify.' },
        title: { type: 'string', description: '(notify) Short title/subject.' },
        message: { type: 'string', description: '(notify) Body text.' },
        channel: { type: 'string', enum: ['all', 'email', 'slack', 'discord', 'webhook'], description: '(notify) Which destination. Default all configured.' },
        url: { type: 'string', description: '(webhook) HTTPS URL to POST to at the scheduled time.' },
        body: { type: 'object', description: '(webhook) Optional JSON body to send. A default body with task info is sent if omitted.' },
        in_seconds: { type: 'number', description: 'Run this many seconds from now (one of in_seconds / run_at required).' },
        run_at: { type: 'string', description: 'ISO 8601 UTC time to run (e.g. 2026-06-11T09:00:00Z).' },
        repeat_every_seconds: { type: 'number', description: 'If set, repeat the task every N seconds after the first run.' },
        name: { type: 'string', description: 'Optional human-readable label.' },
      },
      required: [],
    },
  },
  {
    name: 'list_tasks',
    description: 'List your scheduled tasks (pending and recent), including next run time and how many times each has run.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'cancel_task',
    description: 'Cancel a pending scheduled task by its id (from schedule_task or list_tasks).',
    inputSchema: { type: 'object', properties: { id: { type: 'number', description: 'Task id to cancel.' } }, required: ['id'] },
  },
];

const rpcOk = (id: any, result: any) => ({ jsonrpc: '2.0', id, result });
const rpcErr = (id: any, code: number, message: string) => ({ jsonrpc: '2.0', id, error: { code, message } });
const toolText = (id: any, text: string, isError = false) => rpcOk(id, { content: [{ type: 'text', text }], isError });

async function toolSchedule(c: any, user: any, id: any, args: any) {
  const isPro = user.plan === 'pro';
  const minInterval = isPro ? PRO_MIN_INTERVAL : FREE_MIN_INTERVAL;
  const maxTasks = isPro ? PRO_MAX_TASKS : FREE_MAX_TASKS;
  if ((await activeTaskCount(c.env, user.id)) >= maxTasks)
    return toolText(id, `Task limit reached (${maxTasks} active). Cancel a task or upgrade to Pro at ${c.env.APP_URL}/dashboard.`, true);

  const action = args.action === 'webhook' ? 'webhook' : 'notify';
  let payload: any;
  if (action === 'notify') {
    const title = String(args.title || '').slice(0, 200);
    if (!title) return toolText(id, 'Error: title is required for action="notify".', true);
    const channel = ['all', 'email', 'slack', 'discord', 'webhook'].includes(args.channel) ? args.channel : 'all';
    payload = { title, message: String(args.message || '').slice(0, 4000), channel };
  } else {
    const url = String(args.url || '');
    if (!/^https:\/\//.test(url)) return toolText(id, 'Error: a valid https url is required for action="webhook".', true);
    payload = { url, body: args.body && typeof args.body === 'object' ? args.body : null };
  }

  // first run time
  let runAt: number;
  if (typeof args.in_seconds === 'number') runAt = Date.now() + Math.max(args.in_seconds, minInterval) * 1000;
  else if (args.run_at) { const t = Date.parse(String(args.run_at)); if (isNaN(t)) return toolText(id, 'Error: run_at must be an ISO 8601 date-time.', true); runAt = Math.max(t, Date.now() + minInterval * 1000); }
  else return toolText(id, 'Error: provide either in_seconds or run_at.', true);

  let repeat: number | null = null;
  if (typeof args.repeat_every_seconds === 'number' && args.repeat_every_seconds > 0) repeat = Math.max(Math.floor(args.repeat_every_seconds), minInterval);

  const name = String(args.name || '').slice(0, 120);
  const res = await c.env.DB.prepare('INSERT INTO jobs (user_id,name,action,payload,run_at,repeat_every,status,runs,created_at) VALUES (?,?,?,?,?,?,?,0,?)')
    .bind(user.id, name, action, JSON.stringify(payload), runAt, repeat, 'pending', Date.now()).run();
  const jid = res.meta.last_row_id;
  return toolText(id, `Scheduled task #${jid} (${action}${repeat ? `, repeats every ${repeat}s` : ''}). First run at ${new Date(runAt).toISOString()}.`);
}

async function toolList(c: any, user: any, id: any) {
  const jobs = await c.env.DB.prepare("SELECT * FROM jobs WHERE user_id=? ORDER BY (status='pending') DESC, run_at ASC LIMIT 50").bind(user.id).all();
  const list = (jobs.results || []).map((j: any) => {
    const p = (() => { try { return JSON.parse(j.payload); } catch { return {}; } })();
    const what = j.action === 'webhook' ? `webhook ${p.url || ''}` : `notify "${p.title || ''}"`;
    return `#${j.id} [${j.status}] ${what}${j.repeat_every ? ` every ${j.repeat_every}s` : ''} — next ${isoOrDash(j.run_at)} (runs: ${j.runs})`;
  }).join('\n') || 'No tasks.';
  return toolText(id, list);
}

async function toolCancel(c: any, user: any, id: any, args: any) {
  const jid = Number(args.id);
  if (!jid) return toolText(id, 'Error: id is required.', true);
  const r = await c.env.DB.prepare("UPDATE jobs SET status='canceled' WHERE id=? AND user_id=? AND status='pending'").bind(jid, user.id).run();
  return toolText(id, r.meta.changes ? `Canceled task #${jid}.` : `No pending task #${jid} found.`, !r.meta.changes);
}

async function handleRpc(c: any, user: any, msg: any): Promise<any | null> {
  const { id, method, params } = msg || {};
  if (method === 'initialize') return rpcOk(id, { protocolVersion: (params && params.protocolVersion) || '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'AgentCron', version: '0.1.0' } });
  if (method === 'ping') return rpcOk(id, {});
  if (method === 'tools/list') return rpcOk(id, { tools: TOOLS });
  if (method === 'tools/call') {
    const name = params?.name; const args = params?.arguments || {};
    if (name === 'schedule_task') return toolSchedule(c, user, id, args);
    if (name === 'list_tasks') return toolList(c, user, id);
    if (name === 'cancel_task') return toolCancel(c, user, id, args);
    return rpcErr(id, -32602, `Unknown tool: ${name}`);
  }
  if (id === undefined || id === null) return null;
  return rpcErr(id, -32601, `Method not found: ${method}`);
}

async function authMcp(c: any) {
  const auth = c.req.header('Authorization') || '';
  const bearer = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  const key = bearer || c.req.query('key') || '';
  if (!key) return null;
  return c.env.DB.prepare('SELECT * FROM users WHERE api_key=?').bind(key).first<any>();
}

app.post('/mcp', async (c) => {
  const user = await authMcp(c);
  if (!user) return c.json({ jsonrpc: '2.0', id: null, error: { code: -32001, message: 'Unauthorized: missing or invalid API key' } }, 401);
  let body: any;
  try { body = await c.req.json(); } catch { return c.json(rpcErr(null, -32700, 'Parse error'), 400); }
  if (Array.isArray(body)) {
    const out: any[] = [];
    for (const m of body) { const r = await handleRpc(c, user, m); if (r) out.push(r); }
    return out.length ? c.json(out) : c.body(null, 202);
  }
  const r = await handleRpc(c, user, body);
  if (!r) return c.body(null, 202);
  return c.json(r);
});
app.get('/mcp', (c) => c.text('AgentCron MCP endpoint. Use POST (Streamable HTTP) with Authorization: Bearer <key>.', 405));

// ----- billing (Stripe) -----
app.post('/billing/checkout', requireAuth, async (c) => {
  if (!c.env.STRIPE_SECRET_KEY || !c.env.STRIPE_PRICE_ID) return c.html(layout('Billing', `<div class="card">Billing is not configured yet. <a href="/dashboard">Back</a></div>`, true));
  const u = await getUser(c.env, c.get('uid'));
  const price = c.req.query('plan') === 'annual' && c.env.STRIPE_PRICE_ID_ANNUAL ? c.env.STRIPE_PRICE_ID_ANNUAL : c.env.STRIPE_PRICE_ID;
  const s = await stripeApi(c.env, 'checkout/sessions', {
    mode: 'subscription', 'line_items[0][price]': price, 'line_items[0][quantity]': '1',
    success_url: `${c.env.APP_URL}/billing/success`, cancel_url: `${c.env.APP_URL}/dashboard`,
    client_reference_id: String(u.id), customer_email: u.email, allow_promotion_codes: 'true',
  });
  if (s && s.url) return c.redirect(s.url, 303);
  return c.html(layout('Billing', `<div class="card">Could not start checkout. <a href="/dashboard">Back</a></div>`, true));
});
app.post('/billing/portal', requireAuth, async (c) => {
  const u = await getUser(c.env, c.get('uid'));
  if (!c.env.STRIPE_SECRET_KEY || !u?.stripe_customer_id) return c.redirect('/dashboard');
  const p = await stripeApi(c.env, 'billing_portal/sessions', { customer: u.stripe_customer_id, return_url: `${c.env.APP_URL}/dashboard` });
  return c.redirect(p && p.url ? p.url : '/dashboard', 303);
});
app.get('/billing/success', requireAuth, (c) => c.html(layout('Welcome to Pro', `<div class="card"><h1>🎉 You're on Pro!</h1><p class="muted">Activation may take a few seconds.</p><a class="btn" href="/dashboard">Dashboard</a></div>`, true)));
app.post('/stripe/webhook', async (c) => {
  const secret = c.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) return c.text('webhook not configured', 503);
  const body = await c.req.text();
  const parts = Object.fromEntries((c.req.header('Stripe-Signature') || '').split(',').map((p) => p.split('=')));
  if (!parts.v1 || parts.v1 !== (await hmacHex(secret, `${parts.t}.${body}`))) return c.text('bad signature', 400);
  let ev: any; try { ev = JSON.parse(body); } catch { return c.text('bad json', 400); }
  const o = ev?.data?.object || {};
  try {
    if (ev.type === 'checkout.session.completed' && o.client_reference_id) {
      await c.env.DB.prepare('UPDATE users SET plan=?,stripe_customer_id=?,stripe_subscription_id=? WHERE id=?').bind('pro', o.customer || '', o.subscription || '', Number(o.client_reference_id)).run();
    } else if (ev.type === 'customer.subscription.deleted') {
      await c.env.DB.prepare('UPDATE users SET plan=? WHERE stripe_customer_id=?').bind('free', o.customer || '').run();
    } else if (ev.type === 'customer.subscription.updated') {
      await c.env.DB.prepare('UPDATE users SET plan=? WHERE stripe_customer_id=?').bind(['active', 'trialing', 'past_due'].includes(o.status) ? 'pro' : 'free', o.customer || '').run();
    }
  } catch {}
  return c.json({ received: true });
});

// ----- docs -----
app.get('/docs', (c) => {
  const url = `${c.env.APP_URL}/mcp`;
  return c.html(layout('Docs — set up AgentCron', `
    <h1>AgentCron documentation</h1>
    <p class="muted">Give your AI agent the ability to schedule work for later: <code>schedule_task</code>, <code>list_tasks</code>, <code>cancel_task</code>.</p>

    <h2>Quickstart</h2>
    <ol class="muted">
      <li><a href="/signup">Sign up</a> and copy your API key from the <a href="/dashboard">dashboard</a>.</li>
      <li>Set at least one notification destination (email is set by default) for <code>notify</code> tasks.</li>
      <li>Add AgentCron to your MCP client (below).</li>
    </ol>

    <h2>Connect your MCP client</h2>
    <p><strong>A. Remote URL</strong> (Cursor, Streamable HTTP clients):</p>
    <pre>{
  "mcpServers": {
    "agentcron": {
      "url": "${esc(url)}",
      "headers": { "Authorization": "Bearer YOUR_API_KEY" }
    }
  }
}</pre>
    <p><strong>B. Stdio bridge</strong> (Cline, Claude Desktop, every client; needs Node.js):</p>
    <pre>{
  "mcpServers": {
    "agentcron": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "${esc(url)}", "--header", "Authorization: Bearer YOUR_API_KEY"]
    }
  }
}</pre>

    <h2>Tools</h2>
    <div class="card"><strong>schedule_task(...)</strong>
      <ul class="muted">
        <li><code>action</code> — <code>notify</code> (default) or <code>webhook</code>.</li>
        <li><code>in_seconds</code> <em>or</em> <code>run_at</code> (ISO 8601 UTC) — when to run.</li>
        <li><code>repeat_every_seconds</code> — optional; makes it recurring.</li>
        <li>notify: <code>title</code> (required), <code>message</code>, <code>channel</code> (all/email/slack/discord/webhook).</li>
        <li>webhook: <code>url</code> (https, required), <code>body</code> (optional JSON).</li>
      </ul>
    </div>
    <div class="card"><strong>list_tasks()</strong><p class="muted">List pending and recent tasks with next run time and run count.</p></div>
    <div class="card"><strong>cancel_task(id)</strong><p class="muted">Cancel a pending task.</p></div>

    <h2>Examples</h2>
    <pre>schedule_task(action="notify", title="Review the PR", in_seconds=7200)
schedule_task(action="notify", title="Daily standup summary", run_at="2026-06-11T00:00:00Z", repeat_every_seconds=86400)
schedule_task(action="webhook", url="https://example.com/resume", in_seconds=1800)</pre>

    <h2>FAQ</h2>
    <div class="card"><strong>How precise is the timing?</strong><p class="muted">Tasks run on a 1-minute tick, so a task fires within ~1 minute of its scheduled time. Sub-minute scheduling isn't supported.</p></div>
    <div class="card"><strong>What does it cost?</strong><p class="muted">Free: ${FREE_MAX_TASKS} active tasks, min interval ${FREE_MIN_INTERVAL / 60} min, ${FREE_RUNS_MONTH} runs/month. Pro ($9/mo or $90/yr): ${PRO_MAX_TASKS} tasks, ${PRO_MIN_INTERVAL}s min interval, ${PRO_RUNS_MONTH} runs/month.</p></div>
    <div class="card"><strong>Can it read my data?</strong><p class="muted">No. AgentCron only runs the tasks you schedule (notify or webhook). It has no read access to your accounts.</p></div>
    <p><a class="btn" href="/signup">Get your API key — free</a></p>
  `));
});

app.get('/robots.txt', (c) => c.text(`User-agent: *\nAllow: /\nSitemap: ${c.env.APP_URL}/sitemap.xml\n`));
app.get('/sitemap.xml', (c) => {
  const urls = ['/', '/docs', '/signup', '/terms', '/privacy'];
  return c.body(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.map((u) => `  <url><loc>${c.env.APP_URL}${u}</loc></url>`).join('\n')}\n</urlset>`, 200, { 'Content-Type': 'application/xml' });
});

// =================== SCHEDULED (cron tick, every minute) ===================
async function runJob(env: Env, job: any) {
  const now = Date.now();
  let result = '';
  try {
    const user = await getUser(env, job.user_id);
    if (!user) { await env.DB.prepare("UPDATE jobs SET status='error',last_result=? WHERE id=?").bind('owner missing', job.id).run(); return; }
    const cap = user.plan === 'pro' ? PRO_RUNS_MONTH : FREE_RUNS_MONTH;
    const used = await runsThisMonth(env, job.user_id);
    if (used >= cap) {
      result = 'skipped: monthly run limit reached';
    } else {
      const p = JSON.parse(job.payload || '{}');
      if (job.action === 'webhook') {
        const ok = await postJson(p.url, p.body || { task: job.name || `task#${job.id}`, scheduledAt: job.run_at, firedAt: now });
        result = ok ? 'webhook 200' : 'webhook failed';
      } else {
        const sent = await deliverNotify(env, user, p.title || 'Reminder', p.message || '', p.channel || 'all');
        result = sent.length ? `notified: ${sent.join(',')}` : 'no destination configured';
      }
      await env.DB.prepare('INSERT INTO runs_log (user_id,job_id,at,result) VALUES (?,?,?,?)').bind(job.user_id, job.id, now, result).run();
    }
  } catch (e: any) { result = 'error: ' + (e?.message || 'unknown'); }

  // advance schedule
  if (job.repeat_every && !String(result).startsWith('error')) {
    const stepMs = Number(job.repeat_every) * 1000;
    let next = Number(job.run_at) + stepMs;
    if (next <= now) { // skip missed runs in O(1) (no backlog, no CPU-heavy loop)
      next = Number(job.run_at) + Math.ceil((now - Number(job.run_at)) / stepMs) * stepMs;
      if (next <= now) next += stepMs;
    }
    await env.DB.prepare("UPDATE jobs SET run_at=?,runs=runs+1,last_run_at=?,last_result=? WHERE id=?").bind(next, now, result, job.id).run();
  } else {
    await env.DB.prepare("UPDATE jobs SET status='done',runs=runs+1,last_run_at=?,last_result=? WHERE id=?").bind(now, result, job.id).run();
  }
}

async function tick(env: Env, ctx: ExecutionContext) {
  const due = await env.DB.prepare("SELECT * FROM jobs WHERE status='pending' AND run_at<=? ORDER BY run_at ASC LIMIT ?").bind(Date.now(), TICK_LIMIT).all();
  for (const job of (due.results || [])) ctx.waitUntil(runJob(env, job));
}

export default {
  fetch: app.fetch,
  scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext) { ctx.waitUntil(tick(env, ctx)); },
};
