# Build Spec: Jira → Cursor Cloud Agent Bridge

## How to use this spec

You are about to build a small backend service. **Do not write code yet.** Follow this process:

1. Read this entire spec end to end.
2. Switch to plan mode (`/plan` in Codex, `--permission-mode plan` in Claude Code, or "Ask" mode in Cursor).
3. Produce an implementation plan as a markdown document covering: file layout, dependencies, SQLite schema, the run state machine, error/retry strategy, and a list of every assumption you're making. **No code.**
4. Stop and wait for me to review the plan. I will push back on anything I disagree with.
5. Once the plan is approved, implement incrementally — one module at a time, with a smoke test per module before moving to the next.

If at any point a requirement is ambiguous, ask before guessing.

---

## Mission

Build a Node.js service that listens for Jira webhooks and, when a ticket gets a configured label, spawns a Cursor Cloud Agent against a target GitHub repo to do the work. The agent opens a PR. A background watcher tries to auto-merge the PR; if it can't because of a conflict, the watcher comments the conflict back on the Jira ticket so a human can intervene.

This service is a **bridge**, not a UI. The UI is the existing `cookbook/sdk/agent-kanban` Next.js app, which I'm running unmodified on port 3000 and which already shows all my Cursor Cloud Agents in real time. Your service creates agents that show up there automatically — you don't render anything yourself.

---

## Existing context (don't break these)

- `cookbook/sdk/agent-kanban` is running on `localhost:3000`. **Do not modify it.** Your service is a separate process on a different port (default 8787).
- I have a Cursor Pro account with API access. The API key (starts with `crsr_`) will be in `$CURSOR_API_KEY`.
- Target repo for now: a single GitHub repo URL in `$TARGET_REPO_URL`. Design so adding multi-repo (mapping Jira project → repo) later is easy, but don't build it now.
- My Jira instance is Atlassian Cloud (e.g. `https://mycompany.atlassian.net`). Webhook signing uses HMAC-SHA256 with a shared secret in `$JIRA_WEBHOOK_SECRET`.
- I have a GitHub PAT in `$GITHUB_TOKEN` with `repo` scope on the target repo.

---

## End-to-end flow

1. Jira fires a webhook when a ticket gets the trigger label (default: `cursor`).
2. Service validates the webhook signature. If invalid → 401, log, drop.
3. Service dedupes by Jira delivery ID. If we've seen it → 200, no-op.
4. Service inserts a `run` row in SQLite with status `queued`.
5. Service calls `Agent.create()` from `@cursor/sdk` with `cloud.autoCreatePR: true`, then calls `.send(prompt)` with the ticket title + description as the prompt.
6. Service stores the returned Cursor agent ID on the run row, sets status `running`, and posts a comment back on the Jira ticket: "Cursor agent started. Track at https://cursor.com/agents/<id>"
7. Watcher loop (every 60s by default):
   - For every run with status `running` and no `pr_url` yet: re-fetch the agent via the Cursor SDK and check if a PR has been created. If yes, store `pr_url`, then call `gh pr merge <pr_url> --auto --squash --delete-branch` (or Octokit equivalent — your call, see "Tech stack" below).
   - For every run with `pr_url` set and status not in a terminal state: poll the PR's `mergeable` and `mergeStateStatus` fields via Octokit.
     - `mergeStateStatus === CLEAN` and merged → status `merged`, post Jira comment with PR URL.
     - `mergeable === false` or `mergeStateStatus === DIRTY` → status `conflict`, post Jira comment "⚠️ Merge conflict on <pr_url> — needs manual resolution".
     - `mergeable === null` (still computing) → leave it, retry next tick.
     - Otherwise (waiting on CI, blocked on review, etc.) → leave it, retry next tick.
8. On service startup, run a recovery sweep: any rows in non-terminal states should be picked back up by the watcher loop. The watcher is idempotent on each tick, so this is automatic — just make sure the loop kicks off on boot.

---

## Functional requirements (must-have)

1. **HTTP endpoint** `POST /webhook/jira` that accepts Atlassian webhook payloads.
2. **Signature verification** using HMAC-SHA256 against `$JIRA_WEBHOOK_SECRET`. Reject anything that doesn't verify.
3. **Idempotency** keyed on the Jira webhook delivery ID (header `x-atlassian-webhook-identifier`). Same ID delivered twice must not create two runs. Use a unique constraint at the DB layer, not just an `if exists` check (race-safe).
4. **Trigger condition**: only fire when the event is `jira:issue_updated`, the change includes adding a label, and the new label set contains the trigger label. Configurable via `$TRIGGER_LABEL` (default `cursor`). Removing the label does **not** cancel an in-flight run — log it and move on.
5. **Cursor agent creation** via `@cursor/sdk` with `cloud.autoCreatePR: true` and `cloud.repos: [{ url: $TARGET_REPO_URL }]`. Pass a model from `$DEFAULT_MODEL` if set, otherwise omit and let Cursor pick.
6. **Persistence** in a single SQLite file (`./data/runs.db`). Schema must include at minimum: `id`, `jira_issue_key`, `jira_delivery_id (unique)`, `cursor_agent_id`, `pr_url`, `status`, `prompt`, `error`, `created_at`, `updated_at`. Status enum: `queued | running | pr_open | merged | conflict | failed`.
7. **Watcher loop** that runs on a configurable interval (`$POLL_INTERVAL_MS`, default 60000). Single instance — use a simple `setInterval` or `setTimeout` recursion, not a worker pool. Skip ticks if the previous tick is still running (use a flag).
8. **Auto-merge** on detected PR with `--auto --squash --delete-branch`. Don't merge synchronously — set GitHub auto-merge and let GitHub do it when checks pass.
9. **Conflict notification**: post a comment on the Jira ticket via the Atlassian REST API when a run lands in `conflict` status.
10. **Health endpoint** `GET /healthz` that returns `200 {status: "ok", db: "ok", uptime_ms: N}`.
11. **Structured logging** — every webhook receipt, agent creation, watcher tick decision, and Jira comment should log a JSON line with the run ID. No silent failures.
12. **Graceful shutdown** on SIGTERM: stop accepting webhooks, finish in-flight watcher tick, close DB, exit.

---

## Tech stack (use exactly these unless you have a strong reason otherwise — flag in the plan if you deviate)

- **Runtime**: Node.js 20+, TypeScript, ES modules.
- **HTTP framework**: Hono. (Tiny, fast, good TS ergonomics. Don't use Express.)
- **Cursor SDK**: `@cursor/sdk` (latest). Import as `import { Agent } from "@cursor/sdk"`.
- **Database**: `better-sqlite3` (synchronous, simpler than async sqlite for this scale). Migrations as plain SQL files in `./migrations/`.
- **GitHub**: `@octokit/rest`. Use the REST API for `pulls.get` (mergeable status) and `pulls.merge` with `merge_method: "squash"` *or* the auto-merge mutation via `@octokit/graphql`. Pick one and explain in the plan. Do **not** shell out to `gh`.
- **Jira**: plain `fetch` to the REST v3 API. Basic auth with email + API token (env vars `$JIRA_EMAIL`, `$JIRA_API_TOKEN`). Comment endpoint: `POST /rest/api/3/issue/{key}/comment`.
- **Webhook signature**: Node's built-in `crypto.timingSafeEqual` for the HMAC compare. Use `crypto.createHmac("sha256", secret)`.
- **Validation**: `zod` for parsing webhook payloads and env vars at startup.
- **Logging**: `pino` with pretty printing in dev, JSON in prod.
- **Testing**: `vitest`. Mock the Cursor SDK and Octokit calls; do not hit real APIs in tests.

No bundler. Run with `tsx` in dev, `node --experimental-strip-types` or compiled `tsc` output in prod.

---

## Configuration (env vars)

All required at startup. Service must fail fast if any are missing or empty. Validate with zod.

```
CURSOR_API_KEY=crsr_...
TARGET_REPO_URL=https://github.com/owner/repo
GITHUB_TOKEN=ghp_...
JIRA_BASE_URL=https://mycompany.atlassian.net
JIRA_EMAIL=me@mycompany.com
JIRA_API_TOKEN=...
JIRA_WEBHOOK_SECRET=...
TRIGGER_LABEL=cursor              # optional, default "cursor"
DEFAULT_MODEL=                    # optional, blank = let Cursor pick
POLL_INTERVAL_MS=60000            # optional
PORT=8787                         # optional
DATA_DIR=./data                   # optional
LOG_LEVEL=info                    # optional
```

---

## Cursor SDK reference (this is the call pattern)

This is the actual SDK shape — match it.

```ts
import { Agent } from "@cursor/sdk"

const agent = await Agent.create({
  apiKey: process.env.CURSOR_API_KEY!,
  name: `${issueKey}: ${summary.slice(0, 80)}`,
  ...(model ? { model: { id: model } } : {}),
  cloud: {
    repos: [{ url: process.env.TARGET_REPO_URL! }],
    autoCreatePR: true,
  },
})

await agent.send(promptText)

// agent.id is what you persist as cursor_agent_id
```

To check on an existing agent for the watcher (whether a PR exists yet, etc.), use `Agent.list({ apiKey, runtime: "cloud" })` filtered by ID, or the agent-level `listRuns` if available in the version you install. **Verify the exact API in the installed SDK before committing to one approach** — version-check this and note it in your plan.

---

## Edge cases you MUST handle

These are the things AI agents typically under-handle on a build like this. Spell out in the plan how you'll address each one:

1. **Webhook idempotency under retry.** Atlassian retries failed deliveries. Same `x-atlassian-webhook-identifier` arriving twice must result in exactly one run. Use a `UNIQUE` index on `jira_delivery_id`, catch the constraint violation, return 200.
2. **Label added then immediately removed.** The webhook for "added" still fires. Check the issue's *current* label set via the Jira API before spawning, OR accept that you'll spawn one occasionally — document the choice in the plan.
3. **Multiple labels added in one event.** Atlassian groups changes. Don't fire twice.
4. **Cursor agent never produces a PR.** Agent crashes, runs out of context, etc. Watcher should mark the run `failed` after a configurable timeout (default 30 min in `pr_open` wait state) and comment back to Jira.
5. **Service restart mid-run.** Recovery on boot: rows in `running` or `pr_open` get picked back up by the next watcher tick automatically. No special migration logic needed if the watcher is properly idempotent.
6. **Concurrent watcher ticks.** A long DB query or network call could overlap with the next tick. Use a single-tick mutex (boolean flag) — skip the next tick if the previous is still running.
7. **GitHub rate limits.** Octokit handles secondary rate limits with backoff if you let it; verify your config does. Don't poll faster than `POLL_INTERVAL_MS`.
8. **Cursor SDK rate limits.** Same logic — back off on 429s, don't loop hot.
9. **Secrets in logs.** Never log the API keys, the webhook secret, or the GitHub token. Pino redaction config required.
10. **Branch protection blocking auto-merge.** If `gh pr merge --auto` fails because branch protection requires reviewers, log it and treat as a soft state — leave the run in `pr_open` and let a human handle it. Don't retry-loop.
11. **PR title/body**. Cursor controls these via `autoCreatePR`. Don't try to override them — just record the URL.
12. **Time zones.** Store all timestamps as ISO 8601 UTC strings in SQLite. No local time anywhere.

---

## Explicitly out of scope (DO NOT build)

- Any UI. The user has agent-kanban for that.
- Worktree management, process supervision, log capture from the agent. Cursor Cloud handles all of it.
- PR review automation, comment-bot interactions on PRs, or anything inside the PR itself.
- Multi-tenant auth on the webhook. Signature verification is enough for now.
- Multi-repo project routing. Single repo via env var.
- Slack/email notifications. Jira comments only.
- A retry queue, BullMQ, Redis, or any external dependency beyond what's listed in "Tech stack."
- Docker/Kubernetes manifests. A `package.json` script and a `README.md` deploy section is enough.

---

## Repository layout (suggested — propose your own in the plan if you have a better one)

```
.
├── src/
│   ├── index.ts              # entrypoint, wires everything
│   ├── config.ts             # zod-parsed env
│   ├── server.ts             # Hono app
│   ├── routes/
│   │   ├── webhook.ts        # POST /webhook/jira
│   │   └── health.ts         # GET /healthz
│   ├── webhook/
│   │   ├── verify.ts         # HMAC verification
│   │   └── parse.ts          # zod schema for the Jira payload
│   ├── runs/
│   │   ├── db.ts             # better-sqlite3 setup, prepared statements
│   │   └── repo.ts           # CRUD for the runs table
│   ├── cursor/
│   │   └── client.ts         # thin wrapper around @cursor/sdk
│   ├── github/
│   │   └── client.ts         # Octokit + auto-merge logic
│   ├── jira/
│   │   └── client.ts         # comment posting
│   ├── watcher/
│   │   └── tick.ts           # the main poll loop
│   └── log.ts                # pino setup with redaction
├── migrations/
│   └── 0001_init.sql
├── tests/
│   ├── verify.test.ts
│   ├── repo.test.ts
│   └── tick.test.ts
├── package.json
├── tsconfig.json
├── README.md
└── .env.example
```

---

## Acceptance checklist (the plan must address all of these; the build must satisfy them)

- [ ] All env vars validated at startup; missing one → process exits with a clear error.
- [ ] HMAC verification rejects malformed payloads with 401.
- [ ] Same Jira delivery ID twice → one run.
- [ ] Successful flow: webhook → agent created → PR opened → auto-merge enabled → merged → Jira comment posted.
- [ ] Conflict flow: webhook → agent → PR opened → conflict detected → Jira comment posted, run marked `conflict`.
- [ ] Service restart mid-run → in-flight runs resumed by watcher.
- [ ] No secrets in logs (verify with a redaction test).
- [ ] `npm test` passes with at least one test per module in `src/`.
- [ ] `npm run dev` starts the service and prints a "ready on :8787" log line.
- [ ] README has: install, env setup, ngrok-style local webhook tip, and how to register the webhook in Jira.

---

## Final note

Think hard about the plan before writing it. The amount of code is small (~150–250 lines across the service); the difficulty is entirely in the state transitions, idempotency, and recovery semantics. Get those right in the plan and the implementation is straightforward.

When you're ready, present your plan and stop.
