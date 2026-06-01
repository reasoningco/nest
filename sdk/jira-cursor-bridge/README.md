# SDM

The Software Delivery Manager — a webhook-driven bridge from Jira to Cursor Cloud Agents.

When a Jira ticket gets the configured trigger label, SDM spawns a Cursor Cloud Agent against the GitHub repo mapped to that ticket's project key (or the default fallback repo). The agent opens a PR; a background watcher enables auto-merge (squash); on conflict it comments back on the Jira ticket.

SDM is the bridge service, not a UI. The agents it creates show up live in
**NEST** at `sdk/agent-kanban` in this cookbook repo.

## Install

```bash
npm install
cp .env.example .env
# fill in .env
npm run dev
```

You should see `ready on :8787`.

## Run tests

```bash
npm test
```

Production deployment is documented in [DEPLOYMENT.md](DEPLOYMENT.md).

## Configuration

All required at startup; missing one → process exits with a clear error.

| Var | Required | Default | Notes |
|---|---|---|---|
| `CURSOR_API_KEY` | yes | | Cursor Pro API key (`crsr_...`) |
| `TARGET_REPO_URL` | yes | | `https://github.com/owner/repo` |
| `GITHUB_TOKEN` | yes | | PAT with `repo` scope |
| `JIRA_BASE_URL` | yes | | `https://mycompany.atlassian.net` |
| `JIRA_EMAIL` | yes | | Atlassian account email |
| `JIRA_API_TOKEN` | yes | | Atlassian API token |
| `JIRA_WEBHOOK_SECRET` | yes | | Shared secret for HMAC-SHA256 |
| `TRIGGER_LABEL` | no | `cursor` | Label that fires the bridge |
| `DEFAULT_MODEL` | no | _empty_ | Cursor model id; blank = Cursor picks |
| `POLL_INTERVAL_MS` | no | `60000` | Watcher tick interval |
| `PR_TIMEOUT_MS` | no | `1800000` | After this, no-PR runs → `failed` |
| `PORT` | no | `8787` | HTTP port |
| `DATA_DIR` | no | `./data` | SQLite directory |
| `LOG_LEVEL` | no | `info` | pino level |

## Local webhook with ngrok

```bash
ngrok http 8787
# copy the https URL, e.g. https://abc123.ngrok.app
```

Then in Jira:

1. Go to **Settings → System → WebHooks** (or `https://<your>.atlassian.net/plugins/servlet/webhooks`).
2. Click **Create a WebHook**.
3. URL: `https://abc123.ngrok.app/webhook/jira`
4. Secret: paste the same value as `$JIRA_WEBHOOK_SECRET`.
5. Events: tick **Issue → updated**.
6. JQL filter (optional): `project = "ABC"`.
7. Save.

Add the trigger label (default `cursor`) to a ticket and watch logs.

## Endpoints

- `POST /webhook/jira` — Jira webhook receiver. HMAC-SHA256 verified.
- `GET /healthz` — `{ status: "ok", db: "ok", uptime_ms: N }`.

## Run state machine

```
queued → running → pr_open → merged   (terminal)
                          ↘ conflict (terminal until human acts)
running ─(>30m, no PR)→ failed
queued ─(cursor create fails)→ failed
```

Non-terminal rows are picked up by every watcher tick. Service restart: any in-flight rows are resumed automatically by the next tick.

## GitHub repo settings

For clean auto-merge behaviour:

- Enable "Allow squash merging".
- Enable "Automatically delete head branches" (we don't shell out to delete refs).
- If branch protection requires reviews, the run will sit in `pr_open` until a human merges it; auto-merge will fire as soon as protections are satisfied.

## Out of scope

No UI, no PR review automation, and no Slack/email. Multi-repo routing is
handled by the repos table and the admin API consumed by NEST.
