import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import {
  createReposRepo,
  normalizeProjectKey,
  projectKeyFromIssueKey,
  canonicaliseRepoUrl,
} from "../src/repos/repo.ts";
import { resolveRepoUrl } from "../src/routes/webhook.ts";
import { migrateMappingsToRepos } from "../src/repos/migrate.ts";
import type { Logger } from "../src/log.ts";

function makeDb({ withLegacy = false }: { withLegacy?: boolean } = {}) {
  const db = new Database(":memory:");
  db.exec(readFileSync("./migrations/0001_init.sql", "utf-8"));
  if (withLegacy) {
    db.exec(readFileSync("./migrations/0002_repo_mappings.sql", "utf-8"));
  }
  db.exec(readFileSync("./migrations/0003_repos.sql", "utf-8"));
  return db;
}

const silentLog: Logger = {
  // Logger only needs info/warn/error/debug here; the migration uses info+warn.
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
} as unknown as Logger;

describe("normalizeProjectKey", () => {
  it("uppercases + trims", () => {
    expect(normalizeProjectKey(" pay ")).toBe("PAY");
    expect(normalizeProjectKey("Mob")).toBe("MOB");
  });
  it("rejects garbage", () => {
    expect(() => normalizeProjectKey("")).toThrow();
    expect(() => normalizeProjectKey("1PAY")).toThrow();
    expect(() => normalizeProjectKey("PAY-123")).toThrow();
    expect(() => normalizeProjectKey("a".repeat(40))).toThrow();
  });
});

describe("projectKeyFromIssueKey", () => {
  it("extracts the prefix", () => {
    expect(projectKeyFromIssueKey("PAY-412")).toBe("PAY");
    expect(projectKeyFromIssueKey("MOB_X-1")).toBe("MOB_X");
  });
  it("returns null for non-matches", () => {
    expect(projectKeyFromIssueKey("PAY")).toBeNull();
    expect(projectKeyFromIssueKey("pay-1")).toBeNull();
    expect(projectKeyFromIssueKey("")).toBeNull();
  });
});

describe("canonicaliseRepoUrl", () => {
  it("parses https + ssh + .git suffix", () => {
    expect(canonicaliseRepoUrl("https://github.com/acme/backend")).toEqual({
      owner: "acme",
      name: "backend",
      url: "https://github.com/acme/backend",
    });
    expect(canonicaliseRepoUrl("https://github.com/acme/backend.git")).toEqual({
      owner: "acme",
      name: "backend",
      url: "https://github.com/acme/backend",
    });
    expect(canonicaliseRepoUrl("git@github.com:acme/backend.git")).toEqual({
      owner: "acme",
      name: "backend",
      url: "https://github.com/acme/backend",
    });
  });
  it("rejects non-github urls", () => {
    expect(() => canonicaliseRepoUrl("https://example.com/x/y")).toThrow();
  });
});

describe("ReposRepo", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = makeDb();
  });

  it("upsert + list + get + lookups", () => {
    const r = createReposRepo(db);
    const inserted = r.upsert({
      url: "https://github.com/acme/backend",
      jira_project_key: "PAY",
      description: "Backend services",
    });
    expect(r.list()).toHaveLength(1);
    expect(r.getByOwnerName("acme", "backend")?.id).toBe(inserted.id);
    expect(r.getByJiraProjectKey("PAY")?.id).toBe(inserted.id);
  });

  it("upsert without jira_project_key allows multiple list-only repos", () => {
    const r = createReposRepo(db);
    r.upsert({ url: "https://github.com/acme/a" });
    r.upsert({ url: "https://github.com/acme/b" });
    r.upsert({ url: "https://github.com/acme/c" });
    expect(r.list()).toHaveLength(3);
  });

  it("upsert reassigns jira_project_key from one repo to another atomically", () => {
    const r = createReposRepo(db);
    r.upsert({ url: "https://github.com/acme/old", jira_project_key: "PAY" });
    r.upsert({ url: "https://github.com/acme/new", jira_project_key: "PAY" });
    // Old row should still exist but with jira_project_key cleared.
    const old = r.getByOwnerName("acme", "old");
    const next = r.getByOwnerName("acme", "new");
    expect(old?.jira_project_key).toBeNull();
    expect(next?.jira_project_key).toBe("PAY");
    expect(r.getByJiraProjectKey("PAY")?.id).toBe(next!.id);
  });

  it("rejects invalid project keys + non-github urls at write time", () => {
    const r = createReposRepo(db);
    expect(() =>
      r.upsert({
        url: "https://github.com/acme/backend",
        jira_project_key: "1bad",
      }),
    ).toThrow(/Invalid Jira project key/);
    expect(() =>
      r.upsert({ url: "https://example.com/foo" }),
    ).toThrow(/Cannot parse GitHub repo url/);
  });

  it("remove returns true only when something was deleted", () => {
    const r = createReposRepo(db);
    const row = r.upsert({ url: "https://github.com/acme/backend" });
    expect(r.remove(row.id)).toBe(true);
    expect(r.remove(row.id)).toBe(false);
  });
});

describe("resolveRepoUrl", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = makeDb();
  });

  it("uses the repo when one claims that project key", () => {
    const r = createReposRepo(db);
    r.upsert({
      url: "https://github.com/acme/payments",
      jira_project_key: "PAY",
    });
    expect(
      resolveRepoUrl("PAY-412", r, "https://github.com/acme/fallback"),
    ).toEqual({
      repoUrl: "https://github.com/acme/payments",
      source: "mapping",
    });
  });

  it("falls back when no repo claims the project key", () => {
    const r = createReposRepo(db);
    expect(
      resolveRepoUrl("MOB-99", r, "https://github.com/acme/fallback"),
    ).toEqual({
      repoUrl: "https://github.com/acme/fallback",
      source: "fallback",
    });
  });

  it("falls back on malformed issue keys", () => {
    const r = createReposRepo(db);
    expect(
      resolveRepoUrl("notakey", r, "https://github.com/a/b").source,
    ).toBe("fallback");
  });
});

describe("migrateMappingsToRepos", () => {
  it("copies legacy rows + drops repo_mappings, idempotently", () => {
    const db = makeDb({ withLegacy: true });
    const now = new Date().toISOString();
    db.prepare(
      "INSERT INTO repo_mappings (jira_project_key, repo_url, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
    ).run("PAY", "https://github.com/acme/backend", "old desc", now, now);

    const repo = createReposRepo(db);
    migrateMappingsToRepos(db, repo, silentLog);

    expect(repo.list()).toHaveLength(1);
    expect(repo.getByJiraProjectKey("PAY")?.url).toBe(
      "https://github.com/acme/backend",
    );
    // Table is gone — second call is a no-op.
    expect(
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name='repo_mappings'",
        )
        .get(),
    ).toBeUndefined();
    migrateMappingsToRepos(db, repo, silentLog); // no throw
  });
});
