# Cursor SDK Agent Kanban

A Linear-style board for Cursor Cloud Agents. It uses the Cursor SDK to list
cloud agents, group them into kanban columns, preview artifacts on cards, and
create new cloud agents from a repository and prompt.

This example demonstrates:

- required API-key onboarding before any Cloud Agent data loads,
- role-based access control for viewing agents, launching SDM/SDA work, and
  managing routing,
- durable SQLite records for SDM tasks, SDA launches, routing changes, and
  audit logs,
- launch targets for Cursor Cloud Agents and the Jetson autonomous agent,
- cloud-agent listing with grouping by status, repository, branch, or created
  date,
- agent cards with status, repo/branch metadata, latest activity, PR link, and
  artifact previews,
- create-agent flows backed by `Agent.create({ cloud: { repos } })`,
- authenticated artifact media previews proxied through local API routes.

## Getting Started

```bash
pnpm install
pnpm dev
```

Open the local Next.js URL and complete onboarding by entering a Cursor API key
from the [Cursor integrations dashboard](https://cursor.com/dashboard/integrations).
If you keep "Remember this key" checked, the key is stored locally at
`~/.agent-kanban/settings.json`; otherwise it is kept only in the in-memory app
session.

For a shared deployment, configure `NEST_ADMIN_EMAILS`,
`NEST_OPERATOR_EMAILS`, `NEST_VIEWER_EMAILS`, or `NEST_ALLOWED_DOMAINS` in the
server environment. Without an allowlist, a valid Cursor user is treated as an
admin so local single-user installs keep working.

## Jetson Agent

The sidebar includes a Jetson agent page that proxies to the persistent Claude
tmux console on `jensen`. Start the local tunnel and run Next with the Jetson
console token:

```bash
ssh -N -L 8787:127.0.0.1:8787 jensen
export JETSON_AGENT_TOKEN="$(ssh jensen '~/.local/bin/agent-console-token')"
export JETSON_AGENT_BASE_URL="http://127.0.0.1:8787"
pnpm dev
```

The token stays on the Next.js server. The browser talks only to
`/api/jetson-agent/*`. The clone picker uses linked Cursor/GitHub repositories
and also includes the Routing page repositories when `BRIDGE_URL` and
`BRIDGE_ADMIN_TOKEN` are configured.

The create-agent dialog and SDM chart both support a `Jetson` runtime. Jetson
launches are stored in `~/.agent-kanban/nest.db` and shown on the main board
next to Cursor Cloud Agents. NEST wraps Jetson prompts with autonomous operating
instructions so browser-launched work does not block on yes/no prompts.

### CLI

Install the local shims once:

```bash
./scripts/cloud-agent install
```

Then attach or send prompts from any shell:

```bash
cloud-agent
cloud agent status
cloud agent prompt "Open ChefOS, run the relevant tests, and summarize failures."
cloud agent tail 80
cloud agent tunnel
```

The CLI uses SSH to `jensen` and the existing tmux/helper scripts on Jetson. It
does not store or print the web-console token unless you explicitly run
`cloud agent token`.

By default the CLI starts Claude/Codex with dangerous non-interactive permission
flags when it can. Set `CLOUD_AGENT_DANGEROUS_PERMISSIONS=0` before running
`cloud-agent` if you need the old interactive confirmation behavior.

## Telegram Bot

NEST can accept Telegram commands at `/api/telegram/webhook` and fan them out to
Jetson Claude Code or Cursor Cloud Agents. Configure these server-side variables:

```bash
TELEGRAM_BOT_TOKEN="<BotFather token>"
TELEGRAM_WEBHOOK_SECRET="<random shared secret>"
TELEGRAM_ALLOWED_CHAT_IDS="<your Telegram chat id>"
CURSOR_API_KEY="<Cursor API key for cloud agent launches>"
JETSON_AGENT_BASE_URL="http://127.0.0.1:8787"
JETSON_AGENT_TOKEN="<token from ssh jensen '~/.local/bin/agent-console-token'>"
```

Set the webhook after the app is reachable from Telegram:

```bash
pnpm telegram:set-webhook https://your-public-host/api/telegram/webhook
pnpm telegram:info
```

Send `/id` to the bot first, then add the returned chat id to
`TELEGRAM_ALLOWED_CHAT_IDS`. Launch commands stay blocked until the allowlist is
set. Supported commands:

```text
/claude <task>
/claude <jetson-repo-name-or-path-or-git-url> | <task>
/cursor <repo-id-or-url> | <task>
/both <repo-id-or-url> | <task>
/repos [search]
/jetson-repos [search]
/agents
/status
/tail [lines]
```

`/cursor <task>` also works when `TELEGRAM_DEFAULT_REPOSITORY_ID` is set.
`/claude <task>` can also default to a Jetson repo when
`TELEGRAM_DEFAULT_JETSON_REPO` is set. The bot token should live only in
environment variables such as `.env.local` or your process manager, never in
tracked files.

## Notes

Repository listing is rate-limited by the Cloud Agents API and is cached briefly
in memory. Artifact previews are fetched through authenticated local API routes,
so refresh the board if a preview stops loading.
