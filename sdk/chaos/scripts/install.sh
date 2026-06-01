#!/usr/bin/env bash
# Chaos agent telemetry — one-shot installer for Claude Code + Codex CLI.
#
#   curl -fsSL https://chaos.reasoning.company/install.sh | bash -s -- <token>
#
# What it does, idempotently:
#   1. Downloads `claude-telemetry` + `codex-telemetry` helpers to ~/.local/bin
#   2. Adds CHAOS_TELEMETRY_URL + CHAOS_TELEMETRY_TOKEN exports to your shell rc
#      (zshrc and bashrc, whichever exists). Skipped if already present.
#   3. Merges Claude Code hook entries into ~/.claude/settings.json
#   4. Merges Codex CLI hook entries into ~/.codex/hooks.json
#      (only if Codex is installed; skipped silently otherwise)
#
# Re-run safely; nothing is duplicated.
# Pause without uninstalling: `export CHAOS_TELEMETRY_DISABLE=1`.
# One-shot incognito: `claudei`/`codexi` (aliases installed below).

set -euo pipefail

CHAOS_URL="${CHAOS_TELEMETRY_URL:-__CHAOS_URL__}"
TOKEN="${1:-${CHAOS_TELEMETRY_TOKEN:-}}"

if [ -z "$TOKEN" ]; then
  echo "error: telemetry token required" >&2
  echo "  curl -fsSL $CHAOS_URL/install.sh | bash -s -- <token>" >&2
  echo "  (or set \$CHAOS_TELEMETRY_TOKEN)" >&2
  exit 2
fi

if ! command -v python3 >/dev/null 2>&1; then
  echo "error: python3 required (used to merge hook configs)" >&2
  exit 3
fi

# 1. Helper scripts
HELPER_DIR="$HOME/.local/bin"
mkdir -p "$HELPER_DIR"

install_helper() {
  local name="$1"
  local path="$HELPER_DIR/$name"
  curl -fsSL "$CHAOS_URL/api/$name" -o "$path"
  chmod +x "$path"
  echo "✓ helper installed: $path"
}

install_helper "claude-telemetry"
install_helper "codex-telemetry"

# 2. Shell rc env (idempotent — skip if already present)
ensure_rc() {
  local rc="$1"
  [ -f "$rc" ] || return 0
  if grep -q "CHAOS_TELEMETRY_URL=" "$rc" 2>/dev/null; then
    echo "↷ env already in $rc (leaving alone)"
  else
    {
      echo ""
      echo "# chaos agent telemetry (added by chaos installer)"
      echo "export CHAOS_TELEMETRY_URL=\"$CHAOS_URL\""
      echo "export CHAOS_TELEMETRY_TOKEN=\"$TOKEN\""
      case ":$PATH:" in
        *":$HELPER_DIR:"*) ;;
        *) echo "export PATH=\"\$HOME/.local/bin:\$PATH\"" ;;
      esac
    } >> "$rc"
    echo "✓ env added to $rc"
  fi
  # One-shot incognito aliases. Separate idempotency check so we can backfill
  # them onto laptops that ran an older installer.
  if ! grep -q "alias claudei=" "$rc" 2>/dev/null; then
    {
      echo ""
      echo "# chaos: one-shot incognito wrappers (this invocation only)"
      echo "alias claudei='CHAOS_TELEMETRY_DISABLE=1 claude'"
      echo "alias codexi='CHAOS_TELEMETRY_DISABLE=1 codex'"
    } >> "$rc"
    echo "✓ incognito aliases added to $rc"
  else
    echo "↷ incognito aliases already in $rc"
  fi
}

ensure_rc "$HOME/.zshrc"
ensure_rc "$HOME/.bashrc"

# 3. Merge hooks into ~/.claude/settings.json
mkdir -p "$HOME/.claude"
CLAUDE_SETTINGS="$HOME/.claude/settings.json"

python3 - "$CLAUDE_SETTINGS" "claude-telemetry" \
  SessionStart UserPromptSubmit PreToolUse PostToolUse Stop SessionEnd <<'PY'
import json, os, sys
path = sys.argv[1]
helper = sys.argv[2]
events = sys.argv[3:]
data = {}
if os.path.exists(path):
    try:
        with open(path) as f:
            content = f.read().strip()
        data = json.loads(content) if content else {}
    except Exception as e:
        print(f"error: {path} exists but is not valid JSON; aborting to avoid clobbering it: {e}", file=sys.stderr)
        sys.exit(1)
if not isinstance(data, dict):
    print(f"error: {path} root is not an object; aborting.", file=sys.stderr)
    sys.exit(1)

hooks = data.setdefault("hooks", {})
if not isinstance(hooks, dict):
    print(f"error: 'hooks' key in {path} is not an object; aborting.", file=sys.stderr)
    sys.exit(1)

added = 0
for ev in events:
    bucket = hooks.setdefault(ev, [])
    if not isinstance(bucket, list):
        print(f"warning: hooks.{ev} is not a list; skipping that event", file=sys.stderr)
        continue
    cmd = f"{helper} {ev}"
    already = any(
        h.get("command") == cmd
        for entry in bucket if isinstance(entry, dict)
        for h in entry.get("hooks", []) if isinstance(h, dict)
    )
    if already:
        continue
    bucket.append({"matcher": ".*", "hooks": [{"type": "command", "command": cmd}]})
    added += 1

with open(path, "w") as f:
    json.dump(data, f, indent=2)
    f.write("\n")
print(f"✓ wired hooks in {path} (+{added} new)")
PY

# 4. Merge hooks into ~/.codex/hooks.json — only if Codex is on the path or
# the config dir already exists. Codex 0.125+ supports the same hook event
# names as Claude (minus SessionEnd, plus PermissionRequest).
if command -v codex >/dev/null 2>&1 || [ -d "$HOME/.codex" ]; then
  mkdir -p "$HOME/.codex"
  CODEX_HOOKS="$HOME/.codex/hooks.json"

  python3 - "$CODEX_HOOKS" "codex-telemetry" \
    SessionStart UserPromptSubmit PreToolUse PostToolUse Stop PermissionRequest <<'PY'
import json, os, sys
path = sys.argv[1]
helper = sys.argv[2]
events = sys.argv[3:]
data = {}
if os.path.exists(path):
    try:
        with open(path) as f:
            content = f.read().strip()
        data = json.loads(content) if content else {}
    except Exception as e:
        print(f"error: {path} exists but is not valid JSON; aborting to avoid clobbering it: {e}", file=sys.stderr)
        sys.exit(1)
if not isinstance(data, dict):
    print(f"error: {path} root is not an object; aborting.", file=sys.stderr)
    sys.exit(1)

hooks = data.setdefault("hooks", {})
if not isinstance(hooks, dict):
    print(f"error: 'hooks' key in {path} is not an object; aborting.", file=sys.stderr)
    sys.exit(1)

added = 0
for ev in events:
    bucket = hooks.setdefault(ev, [])
    if not isinstance(bucket, list):
        print(f"warning: hooks.{ev} is not a list; skipping that event", file=sys.stderr)
        continue
    cmd = f"{helper} {ev}"
    already = any(
        h.get("command") == cmd
        for entry in bucket if isinstance(entry, dict)
        for h in entry.get("hooks", []) if isinstance(h, dict)
    )
    if already:
        continue
    bucket.append({"matcher": ".*", "hooks": [{"type": "command", "command": cmd}]})
    added += 1

with open(path, "w") as f:
    json.dump(data, f, indent=2)
    f.write("\n")
print(f"✓ wired hooks in {path} (+{added} new)")
PY
else
  echo "↷ codex not detected (skipping ~/.codex/hooks.json — install Codex CLI to enable)"
fi

cat <<EOF

Done. Restart your shell (or 'source ~/.zshrc') so the env vars load.

Then run \`claude\` or \`codex\` somewhere. Activity shows up under
"User SDAs" on nest.reasoning.company.

Skip telemetry for one session:  claudei  /  codexi
Pause for the whole shell:       export CHAOS_TELEMETRY_DISABLE=1
EOF
