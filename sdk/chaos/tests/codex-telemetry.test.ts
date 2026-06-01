import { describe, it, expect } from "vitest";
import { parseEvent, TERMINAL_EVENT_TYPES } from "../src/lib/codex-telemetry";

// Codex telemetry shares its core (verifyBearer / deriveStatus / threshold
// constants / prompt trim) with Claude — those are covered by
// claude-telemetry.test.ts. These tests only assert the Codex-specific
// behaviour: which event types are accepted/rejected, and the empty
// terminal set (Codex's Stop fires per turn, not per session).

describe("codex parseEvent", () => {
  const valid = {
    sessionUuid: "019c0284-cb78-7483-a6c0-87823a46d1a0",
    user: "anmol@reasoningcompany.com",
    type: "PostToolUse",
    tool: "shell",
    cwd: "/repo/foo",
    host: "laptop-anmol",
  };

  it("accepts PermissionRequest (Codex-specific event)", () => {
    const r = parseEvent({ ...valid, type: "PermissionRequest" });
    expect(r.ok).toBe(true);
  });

  it("rejects SessionEnd (Claude-only, not a Codex event)", () => {
    const r = parseEvent({ ...valid, type: "SessionEnd" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/unknown event type/);
  });

  it("accepts the events that Codex 0.125+ actually emits", () => {
    for (const t of [
      "SessionStart",
      "UserPromptSubmit",
      "PreToolUse",
      "PostToolUse",
      "Stop",
      "PermissionRequest",
      "Error",
    ]) {
      const r = parseEvent({ ...valid, type: t });
      expect(r.ok, `expected ${t} to be accepted`).toBe(true);
    }
  });

  it("captures the first user prompt, trimmed", () => {
    const r = parseEvent({
      ...valid,
      type: "UserPromptSubmit",
      prompt: "  fix the broken oauth flow  ",
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.prompt).toBe("fix the broken oauth flow");
  });
});

describe("codex TERMINAL_EVENT_TYPES", () => {
  it("is empty — Codex Stop is per-turn, not per-session", () => {
    // If Codex ever adds a real session-end hook, add it here so the kanban
    // can mark sessions definitively ended instead of relying on the 30min
    // timeout. Until then, leaving this empty avoids closing live sessions
    // on the first turn-end.
    expect(TERMINAL_EVENT_TYPES.size).toBe(0);
  });
});
