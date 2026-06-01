-- Repositories: the canonical list NEST shows on the Routing page and
-- groups SDM agents under. Replaces the previous repo_mappings concept —
-- a row with jira_project_key set IS a routing mapping; a row without it
-- is a repo we just want visible (e.g. for the SDMs kanban columns).
--
-- The actual data move out of repo_mappings happens in JS at boot
-- (parsing URLs in pure SQLite is gnarly) — see migrateMappingsToRepos
-- in src/repos/migrate.ts.
CREATE TABLE IF NOT EXISTS repos (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  owner            TEXT NOT NULL,
  name             TEXT NOT NULL,
  url              TEXT NOT NULL,
  -- Optional. When set, jira webhooks for tickets in that project route
  -- their spawned agents to this repo. NULL = repo is visible in SDMs only.
  jira_project_key TEXT,
  description      TEXT,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  UNIQUE(owner, name)
);

-- Partial unique index so multiple rows can have NULL jira_project_key
-- (most repos won't have one) but a given project key maps to at most one repo.
CREATE UNIQUE INDEX IF NOT EXISTS repos_jira_project_key_unique
  ON repos(jira_project_key)
  WHERE jira_project_key IS NOT NULL;
