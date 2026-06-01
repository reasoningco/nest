# Chaos

Self-hosted team activity dashboard. Shows, by day and by person, what your
team has been shipping across GitHub and Jira — collapsed into feature-level
rollups, not raw commit history.

Built for small teams (<10 people), full-company visibility, no per-user auth.

Chaos now lives inside the cookbook monorepo at `sdk/chaos`. Production
deployment is documented in [DEPLOYMENT.md](DEPLOYMENT.md).

## What's different about this fork

Branch-level feature summarization is routed through **OpenRouter** using the
OpenAI-compatible API surface, instead of calling Anthropic directly. Default
model is `google/gemini-2.0-flash-lite-001` — a fraction of a cent per call
and more than enough for a one-line imperative title.

Model swap knobs:

```env
OPENROUTER_API_KEY=sk-or-v1-...
OPENROUTER_MODEL=google/gemini-2.0-flash-lite-001   # or openai/gpt-4o-mini, google/gemini-flash-1.5-8b, etc.
OPENROUTER_REFERRER=https://chaos.local             # optional, attribution only
```

## Quick start

1. Copy `.env.example` to `.env` and fill in tokens.
2. Edit `config/sources.yaml` — add your repos, Jira projects, and people.
3. `docker-compose up --build`

Prisma migrations run automatically on boot. Data persists in the
`chaos-data` Docker volume (`/app/data/app.db`).

Open <http://localhost:3000>.

> The default `docker-compose.yml` binds to `127.0.0.1` only. This service has
> no authentication — expose it through an internal reverse proxy or VPN.

## Local dev

```bash
npm install
npx prisma migrate dev --name init
npm run dev
```

Hot-reload: editing `config/sources.yaml` is picked up automatically in dev.

Run a manual sync:

```bash
curl -X POST http://localhost:3000/api/sync
```

## Configuration

All sources live in one file: `config/sources.yaml`.

```yaml
github:
  token_env: GITHUB_TOKEN
  repos:
    - { owner: acme, name: backend }
    - { owner: acme, name: mobile-app }

jira:
  base_url: https://acme.atlassian.net
  email_env: JIRA_EMAIL
  token_env: JIRA_API_TOKEN
  projects:
    - { key: PAY }
    - { key: MOB }

people:
  - display_name: Maya Rodriguez
    github: mayar
    jira_account_id: "712020:abc-123-def"
    role: Backend
```

Adding a new repo, Jira project, or person is always a one-line edit here —
no code changes, no UI for it, no migration.

Unknown GitHub logins or Jira account IDs appear in an "unmapped
contributors" strip at the top of the dashboard, pointing you back at this
file.

## Feature grouping

Every Activity gets a `featureKey`:

1. Jira ticket regex (`[A-Z][A-Z0-9]+-\d+`) in commit/PR/branch → `PAY-412`
2. Associated pull request → `pr:<owner>/<repo>:<number>`
3. Non-default branch with no PR → `branch:<owner>/<repo>:<branch>`
4. Else `null` (activity stands alone)

Titles come from:

- Jira key → Jira issue `summary` (verbatim)
- PR key → PR title (verbatim)
- Branch key → OpenRouter (default `google/gemini-2.0-flash-lite-001`),
  one-line imperative-mood summary, re-run only when new commits arrive

## Claude Code session board

Live kanban of every team member's `claude` CLI sessions, at `/claude`. Cards
group by status (Active / Idle / Stale / Ended), click for a per-session
event timeline + tool-use frequency.

### How it works

Each developer's machine pipes Claude Code lifecycle events to chaos via
the `scripts/claude-telemetry` helper, wired through Claude Code's
native hooks. **Privacy by default**: only `{user, host, cwd, type, tool,
ts}` is sent — no prompts, file contents, or command strings.

### One-time setup per developer

Open `https://<your-chaos>/claude` → click **Setup my laptop** → copy the
single command shown → paste into terminal. That's it.

The command is:

```bash
curl -fsSL https://<your-chaos>/install.sh | bash -s -- <token>
```

Re-running is idempotent. The installer:

1. Drops `~/.local/bin/claude-telemetry` (no secrets in the script itself)
2. Appends `CHAOS_TELEMETRY_URL` + `CHAOS_TELEMETRY_TOKEN` exports to your
   shell rc (skipped if already present)
3. Merges six lifecycle hook entries into `~/.claude/settings.json` —
   without touching anything else you have in there

Pause without uninstalling: `export CHAOS_TELEMETRY_DISABLE=1`.

### Server side

Set `CHAOS_TELEMETRY_TOKEN` in chaos's env (`docker-compose` already wires
it). Token rotation = update env + restart container.

## What this is not

No DORA metrics, no velocity, no cycle-time graphs. No code contents. No
real-time on the GitHub/Jira side. It's a feed of what's shipping plus a
live view of who's mid-flight in Claude Code.

## Tests

```bash
npm test
```

The `featureKey` assignment is the easiest thing to regress — there's a
focused unit test at `tests/grouping.test.ts`.
