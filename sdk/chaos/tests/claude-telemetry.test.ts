import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  parseEvent,
  verifyBearer,
  deriveStatus,
  ACTIVE_THRESHOLD_MS,
  IDLE_THRESHOLD_MS,
  STALE_THRESHOLD_MS,
  MAX_FIRST_PROMPT_CHARS,
} from "../src/lib/claude-telemetry";

describe("parseEvent", () => {
  const valid = {
    sessionUuid: "11111111-2222-3333-4444-555555555555",
    user: "anmol@reasoningcompany.com",
    type: "PostToolUse",
    tool: "Bash",
    cwd: "/repo/foo",
    host: "laptop-anmol",
    durationMs: 421,
    ts: "2026-05-01T12:00:00.000Z",
  };

  it("accepts a well-formed payload", () => {
    const r = parseEvent(valid);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.sessionUuid).toBe(valid.sessionUuid);
      expect(r.value.tool).toBe("Bash");
      expect(r.value.durationMs).toBe(421);
    }
  });

  it("rejects unknown event types", () => {
    const r = parseEvent({ ...valid, type: "Hammertime" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/unknown event type/);
  });

  it("rejects missing required fields", () => {
    expect(parseEvent({ ...valid, sessionUuid: undefined }).ok).toBe(false);
    expect(parseEvent({ ...valid, user: "  " }).ok).toBe(false);
    expect(parseEvent({ ...valid, type: undefined }).ok).toBe(false);
  });

  it("rejects non-objects", () => {
    expect(parseEvent(null).ok).toBe(false);
    expect(parseEvent("string").ok).toBe(false);
    expect(parseEvent(42).ok).toBe(false);
  });

  it("clamps absurd durations", () => {
    const r = parseEvent({ ...valid, durationMs: 99_999_999_999 });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.durationMs).toBeLessThanOrEqual(60 * 60 * 1000);
  });

  it("rejects oversized fields (DoS guard)", () => {
    expect(parseEvent({ ...valid, cwd: "x".repeat(2000) }).ok).toBe(false);
    expect(parseEvent({ ...valid, user: "x".repeat(200) }).ok).toBe(false);
  });

  it("rejects unparseable ts", () => {
    expect(parseEvent({ ...valid, ts: "yesterday" }).ok).toBe(false);
  });

  it("accepts and trims a prompt body", () => {
    const r = parseEvent({
      ...valid,
      type: "UserPromptSubmit",
      prompt: "  refactor the auth middleware  ",
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.prompt).toBe("refactor the auth middleware");
  });

  it("truncates oversized prompt bodies (does not reject)", () => {
    const big = "x".repeat(MAX_FIRST_PROMPT_CHARS + 200);
    const r = parseEvent({ ...valid, type: "UserPromptSubmit", prompt: big });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.prompt!.length).toBe(MAX_FIRST_PROMPT_CHARS);
    }
  });

  it("drops empty/whitespace-only prompt", () => {
    const r = parseEvent({
      ...valid,
      type: "UserPromptSubmit",
      prompt: "   ",
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.prompt).toBeUndefined();
  });

  it("ignores non-string prompt", () => {
    const r = parseEvent({
      ...valid,
      type: "UserPromptSubmit",
      prompt: { foo: "bar" },
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.prompt).toBeUndefined();
  });
});

describe("verifyBearer", () => {
  const SECRET = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

  beforeEach(() => {
    process.env.CHAOS_TELEMETRY_TOKEN = SECRET;
  });
  afterEach(() => {
    delete process.env.CHAOS_TELEMETRY_TOKEN;
  });

  it("accepts the matching bearer", () => {
    expect(verifyBearer(`Bearer ${SECRET}`)).toBe(true);
    expect(verifyBearer(`bearer ${SECRET}`)).toBe(true); // case-insensitive scheme
  });

  it("rejects mismatch", () => {
    expect(verifyBearer(`Bearer wrong`)).toBe(false);
  });

  it("rejects when env token is unset", () => {
    delete process.env.CHAOS_TELEMETRY_TOKEN;
    expect(verifyBearer(`Bearer ${SECRET}`)).toBe(false);
  });

  it("rejects no header / wrong scheme", () => {
    expect(verifyBearer(null)).toBe(false);
    expect(verifyBearer("")).toBe(false);
    expect(verifyBearer(SECRET)).toBe(false); // missing scheme
    expect(verifyBearer(`Basic ${SECRET}`)).toBe(false);
  });

  it("rejects same-prefix tokens (length-mismatch path)", () => {
    expect(verifyBearer(`Bearer ${SECRET.slice(0, -2)}`)).toBe(false);
  });
});

describe("deriveStatus", () => {
  const now = new Date("2026-05-01T12:00:00.000Z");

  it("ended when endedAt is set, regardless of recency", () => {
    expect(
      deriveStatus({
        endedAt: new Date("2026-05-01T11:55:00Z"),
        lastEventAt: new Date("2026-05-01T11:55:00Z"),
        now,
      }),
    ).toBe("ended");
  });

  it("active when within 60s", () => {
    expect(
      deriveStatus({
        endedAt: null,
        lastEventAt: new Date(now.getTime() - 30_000),
        now,
      }),
    ).toBe("active");
  });

  it("idle when 60s..5min", () => {
    expect(
      deriveStatus({
        endedAt: null,
        lastEventAt: new Date(now.getTime() - 2 * 60_000),
        now,
      }),
    ).toBe("idle");
  });

  it("stale when 5..30 min", () => {
    expect(
      deriveStatus({
        endedAt: null,
        lastEventAt: new Date(now.getTime() - 10 * 60_000),
        now,
      }),
    ).toBe("stale");
  });

  it("ended when older than 30 min even without explicit endedAt", () => {
    expect(
      deriveStatus({
        endedAt: null,
        lastEventAt: new Date(now.getTime() - 60 * 60_000),
        now,
      }),
    ).toBe("ended");
  });

  it("threshold constants are ordered", () => {
    expect(ACTIVE_THRESHOLD_MS).toBeLessThan(IDLE_THRESHOLD_MS);
    expect(IDLE_THRESHOLD_MS).toBeLessThan(STALE_THRESHOLD_MS);
  });
});
