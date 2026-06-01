-- Per-Jira-project routing for spawned Cursor agents.
--
--   A webhook for issue PAY-412 looks up project key "PAY" in this table and
--   spawns the agent against the mapped repo. If no row matches, the bridge
--   falls back to TARGET_REPO_URL so existing single-repo deployments keep
--   working without migration.
CREATE TABLE IF NOT EXISTS repo_mappings (
  jira_project_key  TEXT PRIMARY KEY,
  repo_url          TEXT NOT NULL,
  -- Free-form note shown next to the row in the SDM NEST UI; useful for
  -- "Backend services" / "iOS app" etc. so the table reads at a glance.
  description       TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);
