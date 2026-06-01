import type { DB } from "../runs/db.ts";
import { parseRepoUrl } from "../config.ts";

/**
 * Repositories: the canonical list NEST surfaces on the Routing page and
 * groups SDM agents under. A row with jira_project_key set doubles as the
 * webhook routing target for that project; rows without one are
 * "list-only" entries that appear in SDMs but never receive webhooks.
 */
export interface Repo {
  id: number;
  owner: string;
  name: string;
  url: string;
  jira_project_key: string | null;
  description: string | null;
  created_at: string;
  updated_at: string;
}

export interface UpsertRepoInput {
  // Either pass a github URL (we'll parse owner/name out of it) or pass
  // owner+name explicitly. URL is canonicalised before insert.
  url: string;
  jira_project_key?: string | null;
  description?: string | null;
}

export interface ReposRepo {
  list(): Repo[];
  get(id: number): Repo | null;
  getByOwnerName(owner: string, name: string): Repo | null;
  getByJiraProjectKey(projectKey: string): Repo | null;
  upsert(input: UpsertRepoInput): Repo;
  remove(id: number): boolean;
}

const PROJECT_KEY_RE = /^[A-Z][A-Z0-9_]{0,15}$/;

export function normalizeProjectKey(input: string): string {
  const upper = input.trim().toUpperCase();
  if (!PROJECT_KEY_RE.test(upper)) {
    throw new Error(
      `Invalid Jira project key: ${JSON.stringify(input)}. Expected uppercase alphanumeric, e.g. "PAY".`,
    );
  }
  return upper;
}

/** Validate URL + canonicalise to "https://github.com/owner/name". */
export function canonicaliseRepoUrl(url: string): {
  owner: string;
  name: string;
  url: string;
} {
  const trimmed = url.trim();
  const { owner, repo: name } = parseRepoUrl(trimmed);
  return { owner, name, url: `https://github.com/${owner}/${name}` };
}

export function projectKeyFromIssueKey(issueKey: string): string | null {
  const m = issueKey.match(/^([A-Z][A-Z0-9_]+)-\d+$/);
  return m ? m[1]! : null;
}

export function createReposRepo(db: DB): ReposRepo {
  const listStmt = db.prepare(
    "SELECT * FROM repos ORDER BY owner ASC, name ASC",
  );
  const getStmt = db.prepare("SELECT * FROM repos WHERE id = ?");
  const getByOwnerNameStmt = db.prepare(
    "SELECT * FROM repos WHERE owner = ? AND name = ?",
  );
  const getByJiraStmt = db.prepare(
    "SELECT * FROM repos WHERE jira_project_key = ?",
  );
  // (owner, name) is unique, so we use it as the conflict target. Updates
  // the URL/description/jira project key. We separately enforce that
  // jira_project_key is unique across rows via the partial index.
  const upsertStmt = db.prepare(`
    INSERT INTO repos (owner, name, url, jira_project_key, description, created_at, updated_at)
    VALUES (@owner, @name, @url, @jira_project_key, @description, @now, @now)
    ON CONFLICT(owner, name) DO UPDATE SET
      url               = excluded.url,
      jira_project_key  = excluded.jira_project_key,
      description       = excluded.description,
      updated_at        = excluded.updated_at
    RETURNING *
  `);
  const removeStmt = db.prepare("DELETE FROM repos WHERE id = ?");
  // Used to clear jira_project_key on another row before we set it here —
  // partial unique index would otherwise reject the move.
  const clearOtherJiraKeyStmt = db.prepare(
    "UPDATE repos SET jira_project_key = NULL, updated_at = ? WHERE jira_project_key = ? AND NOT (owner = ? AND name = ?)",
  );

  return {
    list() {
      return listStmt.all() as Repo[];
    },
    get(id) {
      return (getStmt.get(id) as Repo | undefined) ?? null;
    },
    getByOwnerName(owner, name) {
      return (
        (getByOwnerNameStmt.get(owner, name) as Repo | undefined) ?? null
      );
    },
    getByJiraProjectKey(projectKey) {
      return (
        (getByJiraStmt.get(projectKey) as Repo | undefined) ?? null
      );
    },
    upsert(input) {
      const { owner, name, url } = canonicaliseRepoUrl(input.url);
      const jiraKey =
        input.jira_project_key == null || input.jira_project_key === ""
          ? null
          : normalizeProjectKey(input.jira_project_key);
      const now = new Date().toISOString();
      // If reassigning a jira_project_key that's currently held by another
      // row, clear it there first so the partial unique index doesn't trip.
      if (jiraKey) {
        clearOtherJiraKeyStmt.run(now, jiraKey, owner, name);
      }
      return upsertStmt.get({
        owner,
        name,
        url,
        jira_project_key: jiraKey,
        description: input.description?.trim() || null,
        now,
      }) as Repo;
    },
    remove(id) {
      const r = removeStmt.run(id);
      return r.changes > 0;
    },
  };
}
