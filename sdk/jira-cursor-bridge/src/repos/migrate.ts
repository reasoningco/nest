import type { DB } from "../runs/db.ts";
import type { Logger } from "../log.ts";
import { canonicaliseRepoUrl, type ReposRepo } from "./repo.ts";

/**
 * One-shot data migration: copy any rows in repo_mappings into the new
 * repos table, then drop repo_mappings. Idempotent — if repo_mappings is
 * already gone (deploy ran before), this no-ops.
 *
 * Lives outside the SQL migration runner because parsing
 * "https://github.com/owner/name" out of a URL is much cleaner in JS than
 * in pure SQLite string functions.
 */
export function migrateMappingsToRepos(
  db: DB,
  repos: ReposRepo,
  log: Logger,
): void {
  const tableExists = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='repo_mappings'",
    )
    .get();
  if (!tableExists) return;

  const rows = db
    .prepare("SELECT * FROM repo_mappings")
    .all() as Array<{
      jira_project_key: string;
      repo_url: string;
      description: string | null;
      created_at: string;
      updated_at: string;
    }>;

  let copied = 0;
  let skipped = 0;
  for (const r of rows) {
    try {
      const parsed = canonicaliseRepoUrl(r.repo_url);
      // INSERT OR IGNORE on (owner, name); jira key handled by upsert path.
      const existing = repos.getByOwnerName(parsed.owner, parsed.name);
      if (existing) {
        skipped++;
        continue;
      }
      repos.upsert({
        url: r.repo_url,
        jira_project_key: r.jira_project_key,
        description: r.description,
      });
      copied++;
    } catch (e) {
      log.warn(
        {
          err: e instanceof Error ? e.message : String(e),
          repo_url: r.repo_url,
          jira_project_key: r.jira_project_key,
        },
        "skipped repo_mappings row that failed to parse",
      );
      skipped++;
    }
  }

  db.exec("DROP TABLE repo_mappings");
  log.info(
    { copied, skipped },
    "migrated repo_mappings → repos and dropped legacy table",
  );
}
