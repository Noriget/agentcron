<h1 align="center">AgentCron</h1>

<p align="center">
  <b>Let your AI agent schedule tasks for later — reminders, delayed callbacks, and recurring jobs.</b><br>
  A hosted, remote <a href="https://modelcontextprotocol.io">MCP</a> server. Tools: <code>schedule_task</code>, <code>list_tasks</code>, <code>cancel_task</code>.
</p>

<p align="center">
  <a href="https://cron.mgm-llc.org">Website</a> ·
  <a href="https://cron.mgm-llc.org/docs">Docs</a> ·
  <a href="https://cron.mgm-llc.org/signup">Get an API key (free)</a>
</p>

<p align="center">
  <a href="https://cron.mgm-llc.org/signup"><b>▶ Get your free API key → cron.mgm-llc.org/signup</b></a>
</p>

---

## What it does

Agents can't sleep, wait, or run on a schedule. AgentCron gives them time:

- ⏰ **Remind later** — "Notify me in 2 hours to review the PR."
- 🔁 **Recurring** — "Email me a summary every weekday at 9am."
- 🪝 **Delayed webhook** — "POST this URL in 30 minutes to resume the workflow."
- 🔍 **Poll** — "Every 10 minutes, hit the status webhook."

A scheduled task either **notifies you** (email / Slack / Discord / webhook) or **POSTs to a webhook** at the chosen time. One-off or recurring.

> 🔒 **Read-only by design.** AgentCron only runs the tasks your agent schedules. No access to your inbox, files, or accounts.

## Connect it

**Remote URL** (Cursor, Streamable-HTTP clients):

```json
{
  "mcpServers": {
    "agentcron": {
      "url": "https://cron.mgm-llc.org/mcp",
      "headers": { "Authorization": "Bearer YOUR_API_KEY" }
    }
  }
}
```

**Stdio bridge** (Cline, Claude Desktop, every client):

```json
{
  "mcpServers": {
    "agentcron": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "https://cron.mgm-llc.org/mcp", "--header", "Authorization: Bearer YOUR_API_KEY"]
    }
  }
}
```

Get a free key at [cron.mgm-llc.org](https://cron.mgm-llc.org/signup). See the [docs](https://cron.mgm-llc.org/docs).

## Tools

| Tool | Purpose |
|---|---|
| `schedule_task` | Schedule a `notify` or `webhook` task. Timing: `in_seconds` or `run_at` (ISO 8601 UTC); add `repeat_every_seconds` to recur. |
| `list_tasks` | List pending and recent tasks. |
| `cancel_task` | Cancel a pending task by id. |

## Pricing

- **Free** — 5 active tasks, runs as often as every 5 min, 1,000 runs/month.
- **Pro** — $9/mo or $90/yr — 200 tasks, 60s min interval, 100,000 runs/month.

Timing is best-effort on a 1-minute tick (no sub-minute scheduling).

## Self-hosting

Cloudflare Workers + D1 + Hono. The scheduler uses a [Cron Trigger](https://developers.cloudflare.com/workers/configuration/cron-triggers/) (every minute) — available on the **free** Workers plan.

```bash
npm install
npm run db:local
npm run dev
```

```bash
npx wrangler login
npx wrangler d1 create agentcron      # put database_id in wrangler.jsonc
npm run db:remote
npx wrangler secret put APP_SECRET
npx wrangler secret put RESEND_API_KEY
npx wrangler deploy
```

## License

MIT · Operated by MGM LLC.
