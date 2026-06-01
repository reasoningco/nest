# Agent Kanban Deployment

Production currently runs on `trc4` from `/srv/cookbook/sdk/agent-kanban` under
the `agent-kanban` systemd unit. The working tree should stay on `main`.

NEST now shares the cookbook repo with its two backend services:

- `sdk/chaos` provides org activity, telemetry, Jira/GitHub ingestion, and
  project LOC APIs.
- `sdk/jira-cursor-bridge` receives Jira webhooks, starts Cursor Cloud Agents,
  and owns repository routing state.

## Required Gates

Run these before deploying:

```bash
pnpm -C sdk/agent-kanban install --frozen-lockfile
pnpm -C sdk/agent-kanban run typecheck
pnpm -C sdk/agent-kanban run lint
pnpm -C sdk/agent-kanban test
pnpm -C sdk/agent-kanban run build
```

The GitHub workflows mirror the same gate:

- `.github/workflows/agent-kanban-ci.yml` runs on PRs and pushes to `main`.
- `.github/workflows/agent-kanban-deploy.yml` runs manually and deploys only
  after typecheck, lint, test, and build pass.

## Runtime State

NEST writes durable operational state to SQLite. By default the database lives
at `~/.agent-kanban/nest.db`; set `NEST_DB_PATH` in production if the database
should live in a mounted backup directory.

The database records:

- `sdm_tasks` for SDM task requests.
- `sda_launches` for the six launched Software Development Agents.
- `jetson_agent_launches` for browser-launched Jetson work.
- `routing_changes` for repository/Jira routing mutations.
- `audit_log` for sessions, agent creation, routing views, and routing writes.

## RBAC

Authentication is still Cursor API-key based, but authorization is role based.
Set these environment variables on `trc4` for shared-company use:

```bash
NEST_ADMIN_EMAILS="founder@example.com,lead@example.com"
NEST_OPERATOR_EMAILS="engineer@example.com"
NEST_VIEWER_EMAILS="observer@example.com"
NEST_ALLOWED_DOMAINS="example.com"
NEST_DEFAULT_ROLE="operator"
```

If no RBAC allowlist variables are set, NEST keeps local single-user behavior
and treats a valid Cursor user as `admin`.

## Jetson Agent

Jetson launches require both server-side variables:

```bash
JETSON_AGENT_BASE_URL="http://127.0.0.1:<forwarded-agent-console-port>"
JETSON_AGENT_TOKEN="<token from ssh jensen '~/.local/bin/agent-console-token'>"
```

Do not point `JETSON_AGENT_BASE_URL` at the bridge service. `BRIDGE_URL` and
`JETSON_AGENT_BASE_URL` are separate services even if they have historically
used nearby ports.

The `cloud-agent` helper defaults `CLOUD_AGENT_DANGEROUS_PERMISSIONS=1`, which
starts Claude/Codex with non-interactive permission bypass flags when possible.
Set it to `0` only for manual sessions where a human can answer CLI prompts.

## Telegram Bot

Telegram ingress is served by `POST /api/telegram/webhook`. It verifies the
`X-Telegram-Bot-Api-Secret-Token` header and then enforces
`TELEGRAM_ALLOWED_CHAT_IDS` before launching any agent work.

Required environment for Telegram:

```bash
TELEGRAM_BOT_TOKEN="<BotFather token>"
TELEGRAM_WEBHOOK_SECRET="<random shared secret>"
TELEGRAM_ALLOWED_CHAT_IDS="<comma-separated chat ids>"
CURSOR_API_KEY="<server Cursor API key>"
```

Optional defaults:

```bash
TELEGRAM_DEFAULT_REPOSITORY_ID="<Cursor repository id or Git URL>"
TELEGRAM_DEFAULT_JETSON_REPO="<Jetson repo name, path, or Git URL>"
TELEGRAM_DEFAULT_CURSOR_BRANCH="main"
TELEGRAM_DEFAULT_CURSOR_MODEL="auto"
TELEGRAM_CURSOR_AUTO_CREATE_PR="true"
```

Set or inspect the webhook from the deployed app directory:

```bash
pnpm telegram:set-webhook https://your-public-host/api/telegram/webhook
pnpm telegram:info
```

Send `/id` to the bot to discover the chat id, add it to
`TELEGRAM_ALLOWED_CHAT_IDS`, then restart the service. Do not commit the bot
token or webhook secret.

## Rollback

Use the manual deploy workflow and set `rollback_ref` to a known-good commit on
`main`. The workflow checks out `main` on `trc4`, resets it to that ref, runs the
same gates, restarts `agent-kanban`, and health-checks `http://127.0.0.1:3210/`.

Manual server fallback:

```bash
ssh trc4
cd /srv/cookbook
git fetch origin --tags
git checkout main
git reset --hard <known-good-ref>
pnpm -C sdk/agent-kanban install --frozen-lockfile
pnpm -C sdk/agent-kanban run typecheck
pnpm -C sdk/agent-kanban run lint
pnpm -C sdk/agent-kanban test
pnpm -C sdk/agent-kanban run build
systemctl restart agent-kanban
curl -fsS http://127.0.0.1:3210/ >/dev/null
```
