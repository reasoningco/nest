import { Hono } from "hono";
import type { DB } from "./runs/db.ts";
import { healthRoutes } from "./routes/health.ts";
import { webhookRoutes, type WebhookDeps } from "./routes/webhook.ts";
import { reposRoutes, type ReposDeps } from "./routes/repos.ts";

export function createServer(opts: {
  db: DB;
  startedAt: number;
  webhook: WebhookDeps;
  repos: ReposDeps;
}) {
  const app = new Hono();
  app.route("/", healthRoutes(opts.db, opts.startedAt));
  app.route("/", webhookRoutes(opts.webhook));
  app.route("/", reposRoutes(opts.repos));
  app.notFound((c) => c.json({ error: "not found" }, 404));
  return app;
}
