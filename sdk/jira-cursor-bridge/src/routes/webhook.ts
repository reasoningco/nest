import { Hono } from "hono";
import type { Logger } from "../log.ts";
import type { Config } from "../config.ts";
import type { RunsRepo } from "../runs/repo.ts";
import type { ReposRepo } from "../repos/repo.ts";
import { projectKeyFromIssueKey } from "../repos/repo.ts";
import type { CursorClient } from "../cursor/client.ts";
import type { JiraClient } from "../jira/client.ts";
import { verifySignature } from "../webhook/verify.ts";
import { detectTrigger } from "../webhook/parse.ts";

export interface WebhookDeps {
  log: Logger;
  config: Config;
  runs: RunsRepo;
  repos: ReposRepo;
  cursor: CursorClient;
  jira: JiraClient;
}

/**
 * Resolve the repo to spawn an agent against for a given issue key. Looks
 * up the project key (PAY-412 → PAY) against the repos table; falls back
 * to the single TARGET_REPO_URL when no repo claims that project key.
 */
export function resolveRepoUrl(
  issueKey: string,
  repos: ReposRepo,
  fallback: string,
): { repoUrl: string; source: "mapping" | "fallback" } {
  const projectKey = projectKeyFromIssueKey(issueKey);
  if (projectKey) {
    const r = repos.getByJiraProjectKey(projectKey);
    if (r) return { repoUrl: r.url, source: "mapping" };
  }
  return { repoUrl: fallback, source: "fallback" };
}

const SIG_HEADERS = [
  "x-atlassian-webhook-signature",
  "x-hub-signature-256",
  "x-hub-signature",
];

const DELIVERY_HEADER = "x-atlassian-webhook-identifier";

export function webhookRoutes(deps: WebhookDeps) {
  const { log, config, runs } = deps;
  const app = new Hono();

  app.post("/webhook/jira", async (c) => {
    const raw = await c.req.raw.clone().text();

    let sig: string | null = null;
    for (const h of SIG_HEADERS) {
      const v = c.req.header(h);
      if (v) {
        sig = v;
        break;
      }
    }

    if (!verifySignature(raw, sig, config.JIRA_WEBHOOK_SECRET)) {
      log.warn({ headers_present: !!sig }, "webhook: bad signature");
      return c.json({ error: "invalid signature" }, 401);
    }

    const deliveryId = c.req.header(DELIVERY_HEADER);
    if (!deliveryId) {
      log.warn("webhook: missing delivery id header");
      return c.json({ error: "missing delivery id" }, 400);
    }

    let payload: unknown;
    try {
      payload = JSON.parse(raw);
    } catch {
      log.warn("webhook: invalid json");
      return c.json({ error: "invalid json" }, 400);
    }

    const trigger = detectTrigger(payload, config.TRIGGER_LABEL);
    if (!trigger) {
      const p = payload as any;
      const items = p?.changelog?.items ?? [];
      log.info(
        {
          delivery_id: deliveryId,
          webhookEvent: p?.webhookEvent,
          issue_key: p?.issue?.key,
          current_labels: p?.issue?.fields?.labels,
          changelog_items: items.map((i: any) => ({
            field: i?.field,
            fieldId: i?.fieldId,
            from: i?.fromString,
            to: i?.toString,
          })),
          trigger_label: config.TRIGGER_LABEL,
        },
        "webhook: no trigger match",
      );
      return c.json({ ok: true, accepted: false });
    }

    const promptText = buildPrompt(trigger);
    const inserted = runs.insert({
      jira_issue_key: trigger.issueKey,
      jira_delivery_id: deliveryId,
      prompt: promptText,
    });

    if (!inserted) {
      log.info(
        { delivery_id: deliveryId, issue: trigger.issueKey },
        "webhook: duplicate delivery (deduped)",
      );
      return c.json({ ok: true, accepted: false, deduped: true });
    }

    log.info(
      { run_id: inserted.id, issue: trigger.issueKey, delivery_id: deliveryId },
      "webhook: run queued",
    );

    // fire-and-forget agent creation; do not block webhook response.
    void spawnAgent(inserted.id, trigger, promptText, deps).catch((e) => {
      log.error(
        { run_id: inserted.id, err: e?.message ?? String(e) },
        "spawnAgent crashed",
      );
    });

    return c.json({ ok: true, accepted: true, run_id: inserted.id });
  });

  return app;
}

function buildPrompt(t: ReturnType<typeof detectTrigger>): string {
  if (!t) return "";
  const desc = t.description?.trim();
  return [
    `Jira ticket: ${t.issueKey}`,
    `Title: ${t.summary}`,
    "",
    "Description:",
    desc || "(no description)",
  ].join("\n");
}

async function spawnAgent(
  runId: string,
  trigger: NonNullable<ReturnType<typeof detectTrigger>>,
  prompt: string,
  deps: WebhookDeps,
): Promise<void> {
  const { log, config, runs, repos, cursor, jira } = deps;

  // Re-check labels on the issue to avoid spawning if the label was removed
  // between the webhook fire and our processing.
  try {
    const labels = await jira.getLabels(trigger.issueKey);
    if (!labels.includes(config.TRIGGER_LABEL)) {
      runs.update(runId, {
        status: "failed",
        error: "trigger label removed before processing",
      });
      log.info(
        { run_id: runId, issue: trigger.issueKey },
        "spawn aborted: label removed",
      );
      return;
    }
  } catch (e: any) {
    log.warn(
      { run_id: runId, err: e?.message ?? String(e) },
      "label re-check failed; proceeding",
    );
  }

  const resolved = resolveRepoUrl(
    trigger.issueKey,
    repos,
    config.TARGET_REPO_URL,
  );
  log.info(
    {
      run_id: runId,
      issue: trigger.issueKey,
      repo: resolved.repoUrl,
      source: resolved.source,
    },
    "resolved target repo for run",
  );

  let agentId: string;
  try {
    const agent = await cursor.createAgent({
      issueKey: trigger.issueKey,
      summary: trigger.summary,
      prompt,
      repoUrl: resolved.repoUrl,
      model: config.DEFAULT_MODEL || undefined,
    });
    agentId = agent.id;
  } catch (e: any) {
    runs.update(runId, {
      status: "failed",
      error: `cursor create failed: ${e?.message ?? String(e)}`,
    });
    log.error(
      { run_id: runId, err: e?.message ?? String(e) },
      "cursor agent creation failed",
    );
    try {
      await jira.postComment(
        trigger.issueKey,
        `❌ Could not start Cursor agent: ${e?.message ?? "unknown error"}`,
      );
    } catch {
      /* swallow */
    }
    return;
  }

  runs.update(runId, { cursor_agent_id: agentId, status: "running" });
  log.info(
    { run_id: runId, cursor_agent_id: agentId },
    "cursor agent created; status=running",
  );

  try {
    await jira.postComment(
      trigger.issueKey,
      `🤖 Cursor agent started. Track at ${cursor.agentUrl(agentId)}`,
    );
  } catch (e: any) {
    log.warn(
      { run_id: runId, err: e?.message ?? String(e) },
      "jira start-comment failed",
    );
  }
}
