import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { createRunsRepo } from "../src/runs/repo.ts";

function makeDb() {
  const db = new Database(":memory:");
  db.exec(readFileSync("./migrations/0001_init.sql", "utf-8"));
  return db;
}

describe("RunsRepo", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = makeDb();
  });

  it("inserts a row and returns it", () => {
    const repo = createRunsRepo(db);
    const r = repo.insert({
      jira_issue_key: "ABC-1",
      jira_delivery_id: "d1",
      prompt: "p",
    });
    expect(r).not.toBeNull();
    expect(r?.status).toBe("queued");
    expect(r?.jira_issue_key).toBe("ABC-1");
  });

  it("dedupes via UNIQUE constraint without throwing", () => {
    const repo = createRunsRepo(db);
    const a = repo.insert({
      jira_issue_key: "ABC-1",
      jira_delivery_id: "d1",
      prompt: "p",
    });
    const b = repo.insert({
      jira_issue_key: "ABC-1",
      jira_delivery_id: "d1",
      prompt: "p",
    });
    expect(a).not.toBeNull();
    expect(b).toBeNull();
  });

  it("update touches updated_at and persists fields", async () => {
    const repo = createRunsRepo(db);
    const r = repo.insert({
      jira_issue_key: "ABC-1",
      jira_delivery_id: "d1",
      prompt: "p",
    })!;
    const beforeUpdated = r.updated_at;
    await new Promise((res) => setTimeout(res, 5));
    repo.update(r.id, {
      cursor_agent_id: "agent-1",
      status: "running",
    });
    const after = repo.get(r.id)!;
    expect(after.cursor_agent_id).toBe("agent-1");
    expect(after.status).toBe("running");
    expect(after.updated_at).not.toBe(beforeUpdated);
  });

  it("listNonTerminal excludes terminal rows", () => {
    const repo = createRunsRepo(db);
    const a = repo.insert({
      jira_issue_key: "A",
      jira_delivery_id: "1",
      prompt: "",
    })!;
    const b = repo.insert({
      jira_issue_key: "B",
      jira_delivery_id: "2",
      prompt: "",
    })!;
    const c = repo.insert({
      jira_issue_key: "C",
      jira_delivery_id: "3",
      prompt: "",
    })!;
    repo.update(a.id, { status: "running" });
    repo.update(b.id, { status: "merged" });
    repo.update(c.id, { status: "conflict" });
    const open = repo.listNonTerminal();
    expect(open.map((r) => r.id)).toEqual([a.id]);
  });
});
