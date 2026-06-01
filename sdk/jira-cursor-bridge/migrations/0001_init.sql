CREATE TABLE IF NOT EXISTS runs (
  id                TEXT PRIMARY KEY,
  jira_issue_key    TEXT NOT NULL,
  jira_delivery_id  TEXT NOT NULL UNIQUE,
  cursor_agent_id   TEXT,
  pr_url            TEXT,
  pr_node_id        TEXT,
  status            TEXT NOT NULL CHECK (status IN ('queued','running','pr_open','merged','conflict','failed')),
  prompt            TEXT NOT NULL,
  error             TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_runs_status ON runs(status);
CREATE INDEX IF NOT EXISTS idx_runs_issue_key ON runs(jira_issue_key);
