# Implementation Plan: Jira → Cursor Cloud Agent Bridge

## File layout (matches spec, two minor additions)

```
.
├── src/
│   ├── index.ts              # entrypoint: load config, init db, start server + watcher, wire SIGTERM
│   ├── config.ts             # zod-parsed env
│   ├── server.ts             # Hono app factory
│   ├── routes/
│   │   ├── webhook.ts        # POST /webhook/jira
│   │   └── health.ts         # GET /healthz
│   ├── webhook/
│   │   ├── verify.ts         # HMAC verification (timingSafeEqual)
│   │   └── parse.ts          # zod schema + label-add detection
│   ├── runs/
│   │   ├── db.ts             # better-sqlite3 setup, migration runner, prepared statements
│   │   └── repo.ts           # CRUD + state transitions
│   ├── cursor/
│   │   └── client.ts         # thin wrapper around @cursor/sdk (createAgent, getAgent)
│   ├── github/
│   │   └── client.ts         # Octokit REST + GraphQL enablePullRequestAutoMerge
│   ├── jira/
│   │   └── client.ts         # comment posting via fetch
│   ├── watcher/
│   │   └── tick.ts           # poll loop with single-tick mutex
│   └── log.ts                # pino with redaction
├── migrations/
│   └── 0001_init.sql
├── tests/
│   ├── verify.test.ts
│   ├── parse.test.ts
│   ├── repo.test.ts
│   └── tick.test.ts
├── package.json
├── tsconfig.json
├── README.md
├── .env.example
└── .gitignore
```

## Dependencies

Runtime: `hono`, `@hono/node-server`, `@cursor/sdk`, `better-sqlite3`, `@octokit/rest`, `@octokit/graphql`, `zod`, `pino`, `pino-pretty`.
Dev: `typescript`, `tsx`, `vitest`, `@types/node`, `@types/better-sqlite3`.

Node 20+, ES modules (`"type": "module"`), `tsx` for dev, `tsc` build for prod.

## SQLite schema (`migrations/0001_init.sql`)

```sql
CREATE TABLE IF NOT EXISTS runs (
  id                TEXT PRIMARY KEY,           -- uuid
  jira_issue_key    TEXT NOT NULL,
  jira_delivery_id  TEXT NOT NULL UNIQUE,       -- race-safe dedupe
  cursor_agent_id   TEXT,
  pr_url            TEXT,
  pr_node_id        TEXT,                       -- needed for graphql auto-merge
  status            TEXT NOT NULL CHECK (status IN ('queued','running','pr_open','merged','conflict','failed')),
  prompt            TEXT NOT NULL,
  error             TEXT,
  created_at        TEXT NOT NULL,              -- ISO 8601 UTC
  updated_at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_runs_status ON runs(status);
```

`PRAGMA journal_mode = WAL` at startup for safer concurrent reads during the watcher tick.

## Run state machine

```
                webhook
                   │
                   ▼
                queued ──(create cursor agent fails)──► failed
                   │
                   │ Agent.create + send ok
                   ▼
                running ──(>30min, still no PR)──────► failed
                   │
                   │ watcher sees PR
                   ▼
                pr_open ──(merged)──► merged   (terminal)
                   │
                   ├──(mergeable=false / DIRTY)──► conflict (terminal until human acts)
                   │
                   └──(any other state)──► stays pr_open
```

Terminal states: `merged`, `conflict`, `failed`. Non-terminal rows are picked up every tick.

## Watcher tick algorithm

Single-tick mutex (boolean). On each tick:

1. Skip if previous tick still running.
2. Query non-terminal rows.
3. For each row:
   - If `running` and no `pr_url`:
     - Check Cursor agent for PR. If present → set `pr_url`, `pr_node_id`, enable GitHub auto-merge (graphql `enablePullRequestAutoMerge`, method=SQUASH), transition to `pr_open`.
     - Else if age > `PR_TIMEOUT_MS` (default 30 min) → `failed`, post Jira comment.
   - If `pr_open`:
     - `pulls.get` → if `merged === true` → `merged`, post Jira comment.
     - Else if `mergeable === false` or `mergeable_state === 'dirty'` → `conflict`, post Jira comment.
     - Else if `mergeable === null` or other transient (`unstable`, `blocked`, `behind`) → no-op.
4. Each per-row operation is wrapped in try/catch — one row's failure must not block others.
5. Tick logs a structured summary (counts by transition).

## Webhook handling

- Read raw body bytes for HMAC verification (Hono middleware preserves raw body).
- Header `x-atlassian-webhook-identifier` = delivery ID. Header `x-hub-signature` or `x-atlassian-webhook-signature` (Atlassian uses the latter) = `sha256=<hex>`.
- Verify using `crypto.createHmac("sha256", secret).update(rawBody).digest()` and `timingSafeEqual` against the parsed hex digest.
- Parse JSON with zod schema. Extract:
  - `webhookEvent === "jira:issue_updated"`
  - `changelog.items[]` for any item with `field === "labels"` and a label in `toString` that wasn't in `fromString` matching `TRIGGER_LABEL`.
- If trigger conditions met, INSERT (with `INSERT OR IGNORE` on `jira_delivery_id`), then asynchronously kick off agent creation (don't block the webhook response).
- Return 200 immediately after insert (or 200 if already deduped, or 401 on bad signature).

### Idempotency

- Race-safe: `INSERT INTO runs(...) VALUES (...)` with `jira_delivery_id` UNIQUE. If `SqliteError: UNIQUE constraint failed`, treat as dedupe and return 200.
- Background agent creation only fires on first successful insert.

### Label-removed-after-add

- After dedupe insert, before calling `Agent.create`, re-fetch the issue via Jira REST (`GET /rest/api/3/issue/{key}?fields=labels`) and verify the trigger label is still on the issue. If not, mark the row `failed` with `error = "label removed before processing"`. Cheap, avoids spawning a wasted agent. Documented as a deliberate choice.

### Multiple labels in one event

- The trigger predicate is "did the new label set add `TRIGGER_LABEL`?". Even if 5 labels were added in one event, the predicate matches once; we insert one row per delivery ID. Solved by design.

## Cursor SDK wrapper

Two functions, both narrow:

- `createCursorAgent({ issueKey, summary, prompt, model? })` → returns `{ id }`
- `getCursorAgent(id)` → returns `{ id, prUrl?: string }`

The spec notes the watcher path may use `Agent.list` filtered by id or `Agent.retrieve` — depends on SDK version. The wrapper will:

1. Try `Agent.retrieve(id, { apiKey })` (or instance method) first.
2. Fall back to `Agent.list({ apiKey, runtime: "cloud" })` filtered by id.

Whichever shape the installed SDK exposes, the wrapper hides it. PR URL extraction tries common shapes (`agent.pullRequest?.url`, `agent.pr?.url`, `agent.cloud?.pullRequest?.url`, `agent.runs?.[0]?.pullRequest?.url`) and returns the first present. If the installed SDK shape differs, only `cursor/client.ts` changes.

**Assumption:** the SDK exposes some way to fetch a single agent and read its PR state. If it doesn't, fallback is to record the PR URL when Cursor posts back via webhook (out of scope per spec) or to ask the user. Flagged.

## GitHub auto-merge approach

Use `@octokit/graphql` `enablePullRequestAutoMerge` mutation with `mergeMethod: SQUASH`. This matches `gh pr merge --auto --squash`. Requires the PR's GraphQL node id (we get this from `pulls.get` `node_id`). Branch deletion handled by repo settings or by `pulls.update`/`git.deleteRef` after merge — easier path: rely on the repo's "Automatically delete head branches" setting, document in README.

Branch protection blocking auto-merge: the GraphQL mutation returns an error like `Pull request is not in the correct state`. Catch, log structured, leave run in `pr_open`. Do not retry-loop — the next tick will not re-attempt because we only enable auto-merge once at the `running → pr_open` transition.

`pulls.get` for status polling. Use `mergeable` (true/false/null) and `mergeable_state` (clean/dirty/blocked/unstable/behind/unknown). Map to spec's `mergeStateStatus` semantics.

Octokit retry/throttle: install `@octokit/plugin-retry` + `@octokit/plugin-throttling` and let Octokit handle 403/secondary-rate-limit backoff. Already a transitive of `@octokit/rest`'s recommended config.

## Jira client

Plain `fetch` with basic auth (`Authorization: Basic base64(email:token)`).

- `getIssueLabels(key)` for the label-removed-after-add check.
- `postComment(key, text)` — uses ADF (Atlassian Document Format) minimal wrapper: `{ body: { type: "doc", version: 1, content: [{ type: "paragraph", content: [{ type: "text", text }]}]}}`.

Comments posted at three points:
1. Right after `Agent.create` succeeds — "Cursor agent started. Track at https://cursor.com/agents/<id>".
2. On transition to `merged` — "✅ Merged: <pr_url>".
3. On transition to `conflict` — "⚠️ Merge conflict on <pr_url> — needs manual resolution".
4. On transition to `failed` — "❌ Run failed: <error>".

## Error / retry strategy

- **Webhook receipt**: 401 on bad sig, 200 on dedupe, 200 on accepted. Never 5xx (Atlassian retries on 5xx — we want at-most-once retries dedupe-protected, but no need to invite them).
- **Agent creation failure**: mark run `failed`, log, post Jira comment. Don't retry — the user can re-add the label.
- **Watcher per-row failure**: log with run id, leave row in current state, next tick retries.
- **Octokit failures**: retry/throttle plugins handle 5xx and secondary rate limits with exponential backoff. 4xx errors (except 429) are not retried — logged and the row stays in its state for the next tick to re-evaluate.
- **Jira comment failure**: log error on the run row's `error` column, but don't change run status — comment failure is not run failure.
- **DB busy**: WAL mode + better-sqlite3's built-in retry. Single-process, single-tick, so contention is minimal.
- **No exponential backoff inside a tick** — the tick interval *is* the backoff.

## Logging & redaction

`pino` with redact paths covering all secrets:
```
["*.apiKey", "*.api_key", "*.token", "*.secret", "*.password",
 "headers.authorization", "*.headers.authorization",
 "CURSOR_API_KEY", "GITHUB_TOKEN", "JIRA_API_TOKEN", "JIRA_WEBHOOK_SECRET", "JIRA_EMAIL"]
```

Every log line tagged with `run_id` when applicable. Pretty in dev (`LOG_LEVEL` from env, pino-pretty when `NODE_ENV !== 'production'`).

## Graceful shutdown

On `SIGTERM`/`SIGINT`:
1. Stop the Hono server from accepting new connections.
2. Set a "shutting down" flag → watcher stops scheduling further ticks.
3. Await in-flight tick completion (the mutex flag).
4. Close the better-sqlite3 handle.
5. `process.exit(0)`.

10s hard timeout fallback.

## Testing

- `verify.test.ts`: valid sig accepted, tampered body rejected, missing header rejected. Constant-time compare verified by feeding two same-length but different digests.
- `parse.test.ts`: triggers on label add, ignores label remove, ignores non-issue_updated events, handles multi-label adds correctly.
- `repo.test.ts`: insert dedupe via UNIQUE constraint (second insert with same delivery_id throws), state transitions, recovery query returns non-terminal rows.
- `tick.test.ts`: mocked Cursor + Octokit clients, full happy path, conflict path, timeout-to-failed path, single-tick mutex skip behavior.

No real network calls in tests. All clients injected via factory pattern so tests pass mocks.

## Assumptions (calling these out for review)

1. **`@cursor/sdk` shape**: matches the spec's example. Wrapper isolates SDK calls; if the installed version differs, only `cursor/client.ts` changes. The watcher's "fetch agent by id" path is the most fragile — I'll verify against the installed package and adjust if needed before declaring done.
2. **Atlassian signature header name**: `x-atlassian-webhook-signature` with `sha256=<hex>` value. (Confirmed by Atlassian docs for Cloud webhooks with secret.)
3. **PR detection latency**: Cursor's "agent created a PR" state is observable via the SDK. If not, the watcher falls back to scanning recent PRs in the target repo authored by the Cursor bot — but I'd ask before building that.
4. **Branch deletion**: handled by GitHub repo setting "Automatically delete head branches". Documented in README. Not enforced from this service.
5. **Auto-merge method**: `SQUASH` per spec. No env override.
6. **Single trigger label, single repo**: per spec's "out of scope" multi-repo. Architecture leaves a `getRepoForIssue(key)` seam in `cursor/client.ts` so multi-repo is a future change.
7. **Jira ADF format**: minimal text-only paragraphs. Markdown-in-Jira is not used.
8. **Timeouts**: 30 min from `running` (no PR yet) → `failed`. Configurable via `PR_TIMEOUT_MS` (added to env, default 1_800_000). This is one env var beyond the spec — flagged.
9. **No PR review/check waiting in this service**: GitHub auto-merge handles CI/review gates. We just observe `merged` vs `conflict`.
10. **HTTP framework**: Hono per spec. No deviation.
11. **Database**: better-sqlite3 per spec. WAL mode added.
12. **Tests use vitest with in-memory sqlite (`:memory:`)** for `repo.test.ts`. Migrations run against the test DB at setup.

## Discoveries during live test (post-plan, real SDK behaviour)

These are mismatches between the spec's assumed SDK shape and the installed
`@cursor/sdk` v1.x. Code already reflects the corrections.

1. **`Agent.create()` returns `agent.agentId`, not `agent.id`.** The spec's
   example used `agent.id` — that's `undefined` on the real SDK. Wrapper now
   reads `agent.agentId ?? agent.id ?? agent.options?.agentId` and throws if
   none are present, so we never silently store a NULL id again.
2. **`Agent.listRuns(id, { apiKey })` returns `{ items: [] }` for cloud
   agents** (at least this account / this version), even after the agent has
   completed and opened a PR. So we cannot rely on the SDK to surface the PR
   URL. Fallback: `findOpenPrByBranchSuffix` against the target repo. Cursor
   names branches `cursor/<slug>-<last4-of-agentId>`, so we match the suffix.
3. **Cursor opens PRs as drafts.** `pulls.merge` then returns 405 "Pull
   Request is still a draft." Watcher now calls
   `markPullRequestReadyForReview` (GraphQL) before merging.
4. **`enablePullRequestAutoMerge` requires branch protection.** On an
   unprotected repo it errors. We try it anyway (so protected repos still
   benefit), and fall back to direct `pulls.merge` with `merge_method=squash`
   when the PR is already `mergeable=true, mergeable_state=clean`.
5. **The Cursor cloud agent uses Cursor's own GitHub App, not our PAT.** If
   that App doesn't have access to the target repo, `Agent.create` fails with
   `[validation_error] Failed to determine repository default branch`. README
   should call this out (TODO).

## Acceptance checklist coverage

- [x] Env validation at startup → `src/config.ts` with zod, fail-fast.
- [x] HMAC verification → 401 on fail, in `webhook/verify.ts`.
- [x] Same delivery ID twice → one run via UNIQUE constraint.
- [x] Successful flow covered by state machine + watcher.
- [x] Conflict flow covered by `mergeable=false` branch in tick.
- [x] Restart mid-run → recovery query at watcher startup picks up non-terminal rows.
- [x] Redaction → pino redact paths cover all secrets; `verify.test.ts` includes a redaction sanity test.
- [x] `npm test` → vitest runs all `tests/*.test.ts`.
- [x] `npm run dev` → tsx + ready log.
- [x] README → install, env, ngrok tip, Jira webhook setup.
