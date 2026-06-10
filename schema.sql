CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT UNIQUE NOT NULL,
  password TEXT NOT NULL,
  plan TEXT NOT NULL DEFAULT 'free',
  api_key TEXT UNIQUE NOT NULL,
  dest_email TEXT,
  slack_webhook TEXT,
  discord_webhook TEXT,
  webhook_url TEXT,
  stripe_customer_id TEXT,
  stripe_subscription_id TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  name TEXT,
  action TEXT NOT NULL,            -- 'notify' | 'webhook'
  payload TEXT NOT NULL,          -- JSON
  run_at INTEGER NOT NULL,        -- next run, epoch ms
  repeat_every INTEGER,            -- seconds; null/0 = one-time
  status TEXT NOT NULL DEFAULT 'pending', -- pending|done|canceled|error
  runs INTEGER NOT NULL DEFAULT 0,
  last_run_at INTEGER,
  last_result TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_jobs_due ON jobs(status, run_at);
CREATE INDEX IF NOT EXISTS idx_jobs_user ON jobs(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS runs_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  job_id INTEGER NOT NULL,
  at INTEGER NOT NULL,
  result TEXT
);
CREATE INDEX IF NOT EXISTS idx_runs_user ON runs_log(user_id, at);

CREATE TABLE IF NOT EXISTS rate_limits (
  k TEXT PRIMARY KEY,
  count INTEGER NOT NULL,
  reset_at INTEGER NOT NULL
);
