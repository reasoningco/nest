import type { Logger } from "../log.ts";
import type { CursorClient } from "../cursor/client.ts";
import type { GitHubClient } from "../github/client.ts";
import type { JiraClient } from "../jira/client.ts";
import type { Run, RunsRepo } from "../runs/repo.ts";

export interface TickDeps {
  log: Logger;
  runs: RunsRepo;
  cursor: CursorClient;
  github: GitHubClient;
  jira: JiraClient;
  prTimeoutMs: number;
  targetRepoUrl: string;
}

export async function tick(deps: TickDeps): Promise<void> {
  const { log, runs } = deps;

  await discoverOrphanPrs(deps).catch((e) => {
    log.warn({ err: e?.message ?? String(e) }, "discovery pass failed");
  });

  const open = runs.listNonTerminal();
  log.debug({ count: open.length }, "watcher tick start");

  for (const run of open) {
    try {
      await processRun(run, deps);
    } catch (e: any) {
      log.error(
        { run_id: run.id, err: e?.message ?? String(e) },
        "tick: row failed",
      );
    }
  }
}

async function discoverOrphanPrs(deps: TickDeps): Promise<void> {
  const { log, runs, cursor, github } = deps;
  const agents = await cursor.listAgents();
  if (agents.length === 0) return;

  const seenRepos = new Set<string>();
  for (const agent of agents) {
    for (const repo of agent.repos) {
      const repoUrl = repo.startsWith("http") ? repo : `https://${repo}`;
      if (seenRepos.has(repoUrl)) continue;
      seenRepos.add(repoUrl);
      let prs;
      try {
        prs = await github.listCursorOpenPrs(repoUrl);
      } catch (e: any) {
        log.debug(
          { repo: repoUrl, err: e?.message },
          "discover: list prs failed",
        );
        continue;
      }
      for (const pr of prs) {
        const suffix = pr.branch.split("-").pop() ?? "";
        if (suffix.length < 4) continue;
        const matchedAgent = agents.find((a) => a.id.endsWith(suffix));
        if (!matchedAgent) continue;
        const deliveryId = `kanban:${matchedAgent.id}:${pr.url}`;
        const inserted = runs.adopt({
          jira_delivery_id: deliveryId,
          cursor_agent_id: matchedAgent.id,
          pr_url: pr.url,
          pr_node_id: pr.nodeId,
          prompt: matchedAgent.name ?? pr.title,
        });
        if (inserted) {
          log.info(
            {
              run_id: inserted.id,
              cursor_agent_id: matchedAgent.id,
              pr_url: pr.url,
            },
            "adopted kanban-spawned PR",
          );
        }
      }
    }
  }
}

async function processRun(run: Run, deps: TickDeps): Promise<void> {
  if (run.status === "running" && !run.pr_url) {
    return await checkForPr(run, deps);
  }
  if (run.status === "pr_open" && run.pr_url) {
    return await checkPrStatus(run, deps);
  }
  // queued is handled by webhook handler; if it's stuck here, warn.
  if (run.status === "queued") {
    deps.log.warn({ run_id: run.id }, "tick: row stuck in queued");
  }
}

async function checkForPr(run: Run, deps: TickDeps): Promise<void> {
  const { log, runs, cursor, github, jira, prTimeoutMs, targetRepoUrl } = deps;
  if (!run.cursor_agent_id) {
    log.warn({ run_id: run.id }, "running row has no cursor_agent_id");
    return;
  }

  const ageMs = Date.now() - new Date(run.created_at).getTime();

  let prUrl: string | undefined;
  try {
    const agent = await cursor.getAgent(run.cursor_agent_id);
    prUrl = agent.prUrl;
  } catch (e: any) {
    log.debug({ run_id: run.id, err: e?.message }, "cursor.getAgent failed; trying github fallback");
  }

  if (!prUrl) {
    const suffix = run.cursor_agent_id.slice(-4);
    const found = await github.findOpenPrByBranchSuffix(targetRepoUrl, suffix);
    if (found) {
      prUrl = found.url;
      log.info(
        { run_id: run.id, pr_url: prUrl, suffix },
        "PR found via github branch-suffix match",
      );
    }
  }

  if (!prUrl) {
    if (ageMs > prTimeoutMs) {
      runs.update(run.id, {
        status: "failed",
        error: `no PR after ${Math.round(ageMs / 60000)}m`,
      });
      log.warn({ run_id: run.id, age_ms: ageMs }, "transition: running -> failed (timeout)");
      await safeComment(
        jira,
        run.jira_issue_key,
        `❌ Cursor agent did not produce a PR within the timeout. https://cursor.com/agents/${run.cursor_agent_id}`,
        log,
        run.id,
      );
    }
    return;
  }

  const pull = await github.getPull(prUrl);
  runs.update(run.id, {
    pr_url: prUrl,
    pr_node_id: pull.nodeId,
    status: "pr_open",
  });
  log.info({ run_id: run.id, pr_url: prUrl }, "transition: running -> pr_open");

  if (pull.draft) {
    const ready = await github.markReadyForReview(pull.nodeId);
    if (ready.ok) {
      log.info({ run_id: run.id }, "PR marked ready for review");
    } else {
      log.warn(
        { run_id: run.id, reason: ready.reason },
        "markReadyForReview failed",
      );
    }
  }

  const auto = await github.enableAutoMerge(pull.nodeId);
  if (!auto.ok) {
    log.warn(
      { run_id: run.id, reason: auto.reason },
      "auto-merge enable failed; will try direct merge on next tick",
    );
  } else {
    log.info({ run_id: run.id }, "auto-merge enabled (squash)");
  }

  await safeComment(
    jira,
    run.jira_issue_key,
    `🔀 PR opened: ${prUrl}`,
    log,
    run.id,
  );
}

async function checkPrStatus(run: Run, deps: TickDeps): Promise<void> {
  const { log, runs, github, jira } = deps;
  if (!run.pr_url) return;
  const pull = await github.getPull(run.pr_url);

  if (pull.merged) {
    runs.update(run.id, { status: "merged" });
    log.info({ run_id: run.id, pr_url: run.pr_url }, "transition: pr_open -> merged");
    await safeComment(
      jira,
      run.jira_issue_key,
      `✅ Merged: ${run.pr_url}`,
      log,
      run.id,
    );
    return;
  }

  if (pull.mergeable === false || pull.mergeableState === "dirty") {
    runs.update(run.id, { status: "conflict" });
    log.info({ run_id: run.id, pr_url: run.pr_url }, "transition: pr_open -> conflict");
    await safeComment(
      jira,
      run.jira_issue_key,
      `⚠️ Merge conflict on ${run.pr_url} — needs manual resolution`,
      log,
      run.id,
    );
    return;
  }

  if (pull.draft) {
    const ready = await github.markReadyForReview(pull.nodeId);
    if (ready.ok) {
      log.info({ run_id: run.id }, "PR marked ready (was draft)");
    } else {
      log.warn(
        { run_id: run.id, reason: ready.reason },
        "markReadyForReview failed; leaving pr_open",
      );
      return;
    }
  }

  // PR is clean + mergeable, no checks pending. Auto-merge cannot help here
  // (it requires branch protection). Merge directly.
  if (pull.mergeable === true && pull.mergeableState === "clean") {
    const merged = await github.squashMergeNow(run.pr_url);
    if (merged.ok) {
      runs.update(run.id, { status: "merged" });
      log.info(
        { run_id: run.id, pr_url: run.pr_url },
        "transition: pr_open -> merged (direct squash)",
      );
      await safeComment(
        jira,
        run.jira_issue_key,
        `✅ Merged: ${run.pr_url}`,
        log,
        run.id,
      );
      return;
    }
    log.warn(
      { run_id: run.id, reason: merged.reason },
      "direct squash merge failed; leaving pr_open",
    );
    return;
  }

  log.debug(
    {
      run_id: run.id,
      mergeable: pull.mergeable,
      state: pull.mergeableState,
    },
    "pr_open: still pending",
  );
}

async function safeComment(
  jira: JiraClient,
  key: string,
  text: string,
  log: Logger,
  runId: string,
): Promise<void> {
  if (key === "KANBAN" || !key) return; // adopted runs have no Jira ticket
  try {
    await jira.postComment(key, text);
  } catch (e: any) {
    log.error(
      { run_id: runId, err: e?.message ?? String(e) },
      "jira comment failed",
    );
  }
}
