import { serve } from "@hono/node-server";
import { join } from "node:path";
import { loadConfig } from "./config.ts";
import { createLogger } from "./log.ts";
import { openDb, runMigrations } from "./runs/db.ts";
import { createRunsRepo } from "./runs/repo.ts";
import { createReposRepo } from "./repos/repo.ts";
import { migrateMappingsToRepos } from "./repos/migrate.ts";
import { createCursorClient } from "./cursor/client.ts";
import { createGitHubClient } from "./github/client.ts";
import { createJiraClient } from "./jira/client.ts";
import { createServer } from "./server.ts";
import { tick } from "./watcher/tick.ts";

async function main() {
  const startedAt = Date.now();
  const config = loadConfig();
  const log = createLogger({
    level: config.LOG_LEVEL,
    pretty: config.NODE_ENV !== "production",
  });

  const dbPath = join(config.DATA_DIR, "runs.db");
  const db = openDb(dbPath);
  runMigrations(db, "./migrations");
  const runs = createRunsRepo(db);
  const repos = createReposRepo(db);
  // One-shot copy from the legacy repo_mappings table; safe to leave in
  // place forever (idempotent — the table is dropped after the copy).
  migrateMappingsToRepos(db, repos, log);

  const cursor = createCursorClient({ apiKey: config.CURSOR_API_KEY });
  const github = createGitHubClient({
    token: config.GITHUB_TOKEN,
    onRateLimit: (msg) => log.warn({ msg }, "github rate limit"),
  });
  const jira = createJiraClient({
    baseUrl: config.JIRA_BASE_URL,
    email: config.JIRA_EMAIL,
    apiToken: config.JIRA_API_TOKEN,
  });

  const corsOrigins = config.BRIDGE_CORS_ORIGINS.split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const app = createServer({
    db,
    startedAt,
    webhook: { log, config, runs, repos, cursor, jira },
    repos: {
      log,
      repos,
      adminToken: config.BRIDGE_ADMIN_TOKEN,
      corsOrigins,
    },
  });

  const server = serve(
    { fetch: app.fetch, port: config.PORT },
    (info) => {
      log.info({ port: info.port }, `ready on :${info.port}`);
    },
  );

  // Watcher loop with single-tick mutex.
  let tickInFlight = false;
  let shuttingDown = false;
  let timer: NodeJS.Timeout | null = null;

  const runTick = async () => {
    if (shuttingDown) return;
    if (tickInFlight) {
      log.debug("tick: skipped (previous still running)");
      schedule();
      return;
    }
    tickInFlight = true;
    try {
      await tick({
        log,
        runs,
        cursor,
        github,
        jira,
        prTimeoutMs: config.PR_TIMEOUT_MS,
        targetRepoUrl: config.TARGET_REPO_URL,
      });
    } catch (e: any) {
      log.error({ err: e?.message ?? String(e) }, "watcher tick failed");
    } finally {
      tickInFlight = false;
      schedule();
    }
  };

  const schedule = () => {
    if (shuttingDown) return;
    timer = setTimeout(() => void runTick(), config.POLL_INTERVAL_MS);
  };

  // Kick off the first tick immediately (handles recovery sweep on boot).
  void runTick();

  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info({ signal }, "shutting down");
    if (timer) clearTimeout(timer);

    server.close();

    const start = Date.now();
    while (tickInFlight && Date.now() - start < 10_000) {
      await new Promise((r) => setTimeout(r, 100));
    }

    try {
      db.close();
    } catch (e: any) {
      log.warn({ err: e?.message }, "db close failed");
    }
    log.info("bye");
    process.exit(0);
  };

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
