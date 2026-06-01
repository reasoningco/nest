import { Hono } from "hono";
import type { DB } from "../runs/db.ts";

export function healthRoutes(db: DB, startedAt: number) {
  const app = new Hono();
  app.get("/healthz", (c) => {
    let dbOk: "ok" | "error" = "ok";
    try {
      db.prepare("SELECT 1").get();
    } catch {
      dbOk = "error";
    }
    return c.json({
      status: dbOk === "ok" ? "ok" : "degraded",
      db: dbOk,
      uptime_ms: Date.now() - startedAt,
    });
  });
  return app;
}
