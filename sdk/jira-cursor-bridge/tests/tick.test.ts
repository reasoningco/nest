import { describe, it, expect, beforeEach, vi } from "vitest";
import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import pino from "pino";
import { createRunsRepo } from "../src/runs/repo.ts";
import { tick } from "../src/watcher/tick.ts";
import type { CursorClient } from "../src/cursor/client.ts";
import type { GitHubClient } from "../src/github/client.ts";
import type { JiraClient } from "../src/jira/client.ts";

function makeDb() {
  const db = new Database(":memory:");
  db.exec(readFileSync("./migrations/0001_init.sql", "utf-8"));
  return db;
}

const log = pino({ level: "silent" });

function mocks(overrides?: {
  cursor?: Partial<CursorClient>;
  github?: Partial<GitHubClient>;
  jira?: Partial<JiraClient>;
}) {
  const cursor: CursorClient = {
    createAgent: vi.fn(),
    getAgent: vi.fn(async (id: string) => ({ id })),
    listAgents: vi.fn(async () => []),
    agentUrl: (id) => `https://cursor.com/agents/${id}`,
    ...overrides?.cursor,
  };
  const github: GitHubClient = {
    parsePrUrl: (url) => ({
      owner: "o",
      repo: "r",
      number: Number(url.split("/").pop()),
    }),
    getPull: vi.fn(),
    enableAutoMerge: vi.fn(async () => ({ ok: true } as const)),
    findOpenPrByBranchSuffix: vi.fn(async () => null),
    listCursorOpenPrs: vi.fn(async () => []),
    squashMergeNow: vi.fn(async () => ({ ok: true } as const)),
    markReadyForReview: vi.fn(async () => ({ ok: true } as const)),
    ...overrides?.github,
  };
  const jira: JiraClient = {
    postComment: vi.fn(async () => {}),
    getLabels: vi.fn(async () => []),
    ...overrides?.jira,
  };
  return { cursor, github, jira };
}

describe("watcher tick", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = makeDb();
  });

  it("running -> pr_open when cursor reports a PR; auto-merge enabled; jira commented", async () => {
    const repo = createRunsRepo(db);
    const r = repo.insert({
      jira_issue_key: "ABC-1",
      jira_delivery_id: "d1",
      prompt: "p",
    })!;
    repo.update(r.id, { status: "running", cursor_agent_id: "a1" });

    const m = mocks({
      cursor: {
        getAgent: vi.fn(async () => ({
          id: "a1",
          prUrl: "https://github.com/o/r/pull/1",
        })),
      },
      github: {
        getPull: vi.fn(async () => ({
          url: "https://github.com/o/r/pull/1",
          nodeId: "PR_1",
          merged: false,
          draft: false,
          mergeable: true,
          mergeableState: "clean",
        })),
      },
    });

    await tick({
      log,
      runs: repo,
      cursor: m.cursor,
      github: m.github,
      jira: m.jira,
      prTimeoutMs: 1_800_000,
      targetRepoUrl: "https://github.com/o/r",
    });

    const after = repo.get(r.id)!;
    expect(after.status).toBe("pr_open");
    expect(after.pr_url).toBe("https://github.com/o/r/pull/1");
    expect(after.pr_node_id).toBe("PR_1");
    expect(m.github.enableAutoMerge).toHaveBeenCalledWith("PR_1");
    expect(m.jira.postComment).toHaveBeenCalledOnce();
  });

  it("pr_open -> merged when PR is merged", async () => {
    const repo = createRunsRepo(db);
    const r = repo.insert({
      jira_issue_key: "ABC-1",
      jira_delivery_id: "d1",
      prompt: "p",
    })!;
    repo.update(r.id, {
      status: "pr_open",
      cursor_agent_id: "a1",
      pr_url: "https://github.com/o/r/pull/1",
      pr_node_id: "PR_1",
    });

    const m = mocks({
      github: {
        getPull: vi.fn(async () => ({
          url: "https://github.com/o/r/pull/1",
          nodeId: "PR_1",
          merged: true,
          draft: false,
          mergeable: true,
          mergeableState: "clean",
        })),
      },
    });

    await tick({
      log,
      runs: repo,
      cursor: m.cursor,
      github: m.github,
      jira: m.jira,
      prTimeoutMs: 1_800_000,
      targetRepoUrl: "https://github.com/o/r",
    });

    expect(repo.get(r.id)!.status).toBe("merged");
    expect(m.jira.postComment).toHaveBeenCalledOnce();
  });

  it("pr_open -> conflict on dirty mergeable_state", async () => {
    const repo = createRunsRepo(db);
    const r = repo.insert({
      jira_issue_key: "ABC-1",
      jira_delivery_id: "d1",
      prompt: "p",
    })!;
    repo.update(r.id, {
      status: "pr_open",
      pr_url: "https://github.com/o/r/pull/1",
      pr_node_id: "PR_1",
      cursor_agent_id: "a1",
    });

    const m = mocks({
      github: {
        getPull: vi.fn(async () => ({
          url: "https://github.com/o/r/pull/1",
          nodeId: "PR_1",
          merged: false,
          draft: false,
          mergeable: false,
          mergeableState: "dirty",
        })),
      },
    });

    await tick({
      log,
      runs: repo,
      cursor: m.cursor,
      github: m.github,
      jira: m.jira,
      prTimeoutMs: 1_800_000,
      targetRepoUrl: "https://github.com/o/r",
    });

    const after = repo.get(r.id)!;
    expect(after.status).toBe("conflict");
    expect(m.jira.postComment).toHaveBeenCalledWith(
      "ABC-1",
      expect.stringContaining("Merge conflict"),
    );
  });

  it("running -> failed after timeout when no PR appears", async () => {
    const repo = createRunsRepo(db);
    const r = repo.insert({
      jira_issue_key: "ABC-1",
      jira_delivery_id: "d1",
      prompt: "p",
    })!;
    // Backdate created_at to be older than the timeout.
    db.prepare("UPDATE runs SET status = 'running', cursor_agent_id = 'a1', created_at = ? WHERE id = ?")
      .run(new Date(Date.now() - 60 * 60 * 1000).toISOString(), r.id);

    const m = mocks({
      cursor: { getAgent: vi.fn(async () => ({ id: "a1" })) },
    });

    await tick({
      log,
      runs: repo,
      cursor: m.cursor,
      github: m.github,
      jira: m.jira,
      prTimeoutMs: 30 * 60 * 1000,
      targetRepoUrl: "https://github.com/o/r",
    });

    expect(repo.get(r.id)!.status).toBe("failed");
  });

  it("pr_open with mergeable=null leaves state unchanged", async () => {
    const repo = createRunsRepo(db);
    const r = repo.insert({
      jira_issue_key: "ABC-1",
      jira_delivery_id: "d1",
      prompt: "p",
    })!;
    repo.update(r.id, {
      status: "pr_open",
      pr_url: "https://github.com/o/r/pull/1",
      pr_node_id: "PR_1",
      cursor_agent_id: "a1",
    });

    const m = mocks({
      github: {
        getPull: vi.fn(async () => ({
          url: "https://github.com/o/r/pull/1",
          nodeId: "PR_1",
          merged: false,
          draft: false,
          mergeable: null,
          mergeableState: "unknown",
        })),
      },
    });

    await tick({
      log,
      runs: repo,
      cursor: m.cursor,
      github: m.github,
      jira: m.jira,
      prTimeoutMs: 1_800_000,
      targetRepoUrl: "https://github.com/o/r",
    });

    expect(repo.get(r.id)!.status).toBe("pr_open");
    expect(m.jira.postComment).not.toHaveBeenCalled();
  });

  it("discovers and adopts kanban-spawned PRs, then merges", async () => {
    const repo = createRunsRepo(db);

    const agentId = "bc-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaae70a";
    const m = mocks({
      cursor: {
        listAgents: vi.fn(async () => [
          {
            id: agentId,
            name: "chaos: tweak login text",
            repos: ["github.com/reasoningco/chaos"],
          },
        ]),
      },
      github: {
        listCursorOpenPrs: vi.fn(async () => [
          {
            url: "https://github.com/reasoningco/chaos/pull/1",
            nodeId: "PR_X",
            branch: "cursor/login-chaos-text-e70a",
            title: "Update login page branding text",
          },
        ]),
        getPull: vi.fn(async () => ({
          url: "https://github.com/reasoningco/chaos/pull/1",
          nodeId: "PR_X",
          merged: false,
          draft: true,
          mergeable: true,
          mergeableState: "clean",
        })),
      },
    });

    await tick({
      log,
      runs: repo,
      cursor: m.cursor,
      github: m.github,
      jira: m.jira,
      prTimeoutMs: 1_800_000,
      targetRepoUrl: "https://github.com/o/r",
    });

    const open = repo.listNonTerminal();
    expect(open.length).toBe(0); // adopted then merged in same tick
    expect(m.github.markReadyForReview).toHaveBeenCalledWith("PR_X");
    expect(m.github.squashMergeNow).toHaveBeenCalled();
    // KANBAN-keyed runs must NOT post Jira comments
    expect(m.jira.postComment).not.toHaveBeenCalled();
  });

  it("one row's failure does not block others", async () => {
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
    repo.update(a.id, { status: "running", cursor_agent_id: "a1" });
    repo.update(b.id, { status: "running", cursor_agent_id: "b1" });

    const getAgent = vi.fn(async (id: string) => {
      if (id === "a1") throw new Error("boom");
      return { id, prUrl: "https://github.com/o/r/pull/2" };
    });

    const m = mocks({
      cursor: { getAgent },
      github: {
        getPull: vi.fn(async () => ({
          url: "https://github.com/o/r/pull/2",
          nodeId: "PR_2",
          merged: false,
          draft: false,
          mergeable: true,
          mergeableState: "clean",
        })),
      },
    });

    await tick({
      log,
      runs: repo,
      cursor: m.cursor,
      github: m.github,
      jira: m.jira,
      prTimeoutMs: 1_800_000,
      targetRepoUrl: "https://github.com/o/r",
    });

    expect(repo.get(a.id)!.status).toBe("running");
    expect(repo.get(b.id)!.status).toBe("pr_open");
  });
});
