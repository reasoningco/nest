import { Hono } from "hono";
import { z } from "zod";
import type { Logger } from "../log.ts";
import type { ReposRepo } from "../repos/repo.ts";
import { timingSafeEqual } from "node:crypto";

export interface ReposDeps {
  log: Logger;
  repos: ReposRepo;
  adminToken: string | undefined;
  corsOrigins: string[];
}

const upsertBody = z.object({
  url: z.string().min(1),
  jira_project_key: z.string().nullable().optional(),
  description: z.string().nullable().optional(),
});

function authOk(authHeader: string | undefined, expected: string): boolean {
  if (!authHeader) return false;
  const m = authHeader.match(/^Bearer\s+(.+)$/i);
  if (!m) return false;
  const provided = m[1]!.trim();
  if (provided.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(provided), Buffer.from(expected));
}

export function reposRoutes(deps: ReposDeps) {
  const { log, repos, adminToken, corsOrigins } = deps;
  const app = new Hono();

  // CORS allowlist for direct browser access. NEST proxies server-side
  // and so doesn't need to be on this list — but the policy stays in
  // case the admin UI ever talks to the bridge directly. The trailing
  // glob form `/api/repos*` covers both the bare list endpoint and
  // `/api/repos/:id`, unlike `/api/repos/*` which would skip the bare path.
  app.use("/api/repos*", async (c, next) => {
    const origin = c.req.header("origin") ?? "";
    if (origin && corsOrigins.includes(origin)) {
      c.header("Access-Control-Allow-Origin", origin);
      c.header("Vary", "Origin");
      c.header(
        "Access-Control-Allow-Methods",
        "GET, POST, PUT, DELETE, OPTIONS",
      );
      c.header(
        "Access-Control-Allow-Headers",
        "Authorization, Content-Type",
      );
      c.header("Access-Control-Max-Age", "600");
    }
    if (c.req.method === "OPTIONS") {
      return c.body(null, 204);
    }
    await next();
  });

  app.use("/api/repos*", async (c, next) => {
    if (!adminToken) {
      return c.json(
        {
          error:
            "BRIDGE_ADMIN_TOKEN is not configured on this bridge; admin API is disabled.",
        },
        503,
      );
    }
    if (!authOk(c.req.header("authorization"), adminToken)) {
      return c.json({ error: "unauthorized" }, 401);
    }
    await next();
  });

  app.get("/api/repos", (c) => {
    return c.json({ repos: repos.list() });
  });

  // POST = create-or-update by (owner, name) derived from the URL.
  // Same handler as PUT for caller convenience; the natural key is the
  // URL, not a server-assigned id.
  const upsert = async (c: any) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid JSON body" }, 400);
    }
    const parsed = upsertBody.safeParse(body);
    if (!parsed.success) {
      return c.json(
        { error: "invalid body", issues: parsed.error.issues },
        400,
      );
    }
    try {
      const row = repos.upsert({
        url: parsed.data.url,
        jira_project_key: parsed.data.jira_project_key ?? null,
        description: parsed.data.description ?? null,
      });
      log.info(
        { id: row.id, owner: row.owner, name: row.name, jira: row.jira_project_key },
        "repo upserted",
      );
      return c.json({ repo: row });
    } catch (e: any) {
      return c.json({ error: e?.message ?? "upsert failed" }, 400);
    }
  };

  app.post("/api/repos", upsert);
  app.put("/api/repos/:id", upsert);

  app.delete("/api/repos/:id", (c) => {
    const id = Number(c.req.param("id"));
    if (!Number.isInteger(id) || id <= 0) {
      return c.json({ error: "invalid id" }, 400);
    }
    const removed = repos.remove(id);
    log.info({ id, removed }, "repo deleted");
    return c.json({ removed });
  });

  return app;
}
