import { timingSafeEqual } from "node:crypto";

/**
 * Shared core for agent CLI telemetry (Claude Code, Codex, …).
 *
 * Per-tool modules (claude-telemetry.ts, codex-telemetry.ts) wrap this with
 * their own ALLOWED/TERMINAL event-type sets so tool-specific schemas can
 * evolve independently without breaking the others.
 *
 * Privacy contract is identical across tools: we never persist file
 * contents, command strings, or any prompt body beyond the FIRST
 * UserPromptSubmit per session (truncated to MAX_FIRST_PROMPT_CHARS).
 */

export interface AgentEventInput {
  sessionUuid: string;
  user: string;
  host?: string;
  cwd?: string;
  type: string;
  tool?: string;
  durationMs?: number;
  ts?: string;
  prompt?: string;
}

export const MAX_FIRST_PROMPT_CHARS = 500;

export type ParseResult =
  | { ok: true; value: AgentEventInput }
  | { ok: false; reason: string };

export interface ParserOptions {
  /** Event types we accept on this ingest path. Anything else is rejected. */
  allowedTypes: Set<string>;
}

/**
 * Build a per-tool parse function. Same validation rules as before — only
 * the allowed-type set differs between tools.
 */
export function makeEventParser(opts: ParserOptions) {
  return function parseEvent(raw: unknown): ParseResult {
    if (!raw || typeof raw !== "object") {
      return { ok: false, reason: "body must be an object" };
    }
    const r = raw as Record<string, unknown>;

    const sessionUuid = strField(r, "sessionUuid");
    if (!sessionUuid) return { ok: false, reason: "missing sessionUuid" };
    if (sessionUuid.length < 6 || sessionUuid.length > 128) {
      return { ok: false, reason: "sessionUuid length out of range" };
    }

    const user = strField(r, "user");
    if (!user) return { ok: false, reason: "missing user" };
    if (user.length > 128) return { ok: false, reason: "user too long" };

    const type = strField(r, "type");
    if (!type) return { ok: false, reason: "missing type" };
    if (!opts.allowedTypes.has(type))
      return { ok: false, reason: `unknown event type: ${type}` };

    const host = strField(r, "host");
    const cwd = strField(r, "cwd");
    const tool = strField(r, "tool");
    const ts = strField(r, "ts");

    let durationMs: number | undefined;
    if (typeof r.durationMs === "number" && Number.isFinite(r.durationMs)) {
      durationMs = Math.max(0, Math.min(60 * 60 * 1000, Math.round(r.durationMs)));
    }

    if (host && host.length > 128)
      return { ok: false, reason: "host too long" };
    if (cwd && cwd.length > 1024)
      return { ok: false, reason: "cwd too long" };
    if (tool && tool.length > 64)
      return { ok: false, reason: "tool too long" };
    if (ts && Number.isNaN(Date.parse(ts)))
      return { ok: false, reason: "ts is not parseable as ISO date" };

    let prompt: string | undefined;
    if (typeof r.prompt === "string") {
      const trimmed = r.prompt.trim();
      if (trimmed.length > 0) {
        prompt = trimmed.slice(0, MAX_FIRST_PROMPT_CHARS);
      }
    }

    return {
      ok: true,
      value: {
        sessionUuid,
        user,
        host,
        cwd,
        type,
        tool,
        durationMs,
        ts,
        prompt,
      },
    };
  };
}

function strField(r: Record<string, unknown>, key: string): string | undefined {
  const v = r[key];
  if (typeof v !== "string") return undefined;
  const trimmed = v.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

/**
 * Constant-time bearer comparison. Token is read from $CHAOS_TELEMETRY_TOKEN
 * at request time (so rotation = restart).
 */
export function verifyBearer(authHeader: string | null | undefined): boolean {
  const expected = process.env.CHAOS_TELEMETRY_TOKEN ?? "";
  if (!expected) return false;
  if (!authHeader) return false;
  const m = authHeader.match(/^Bearer\s+(.+)$/i);
  if (!m) return false;
  const provided = m[1]!.trim();
  if (provided.length === 0) return false;
  if (provided.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(provided), Buffer.from(expected));
}

export type SessionStatus = "active" | "idle" | "stale" | "ended";

export interface SessionStatusInput {
  endedAt: Date | null;
  lastEventAt: Date;
  now?: Date;
}

/**
 * Bucketing thresholds. Single source of truth so UI + API stay in sync.
 *
 *   active  — heartbeat in last 60s, no terminal event
 *   idle    — last 60s..5min
 *   stale   — last 5min..30min
 *   ended   — explicit terminal event recorded, OR no heartbeat for 30min+
 */
export const ACTIVE_THRESHOLD_MS = 60 * 1000;
export const IDLE_THRESHOLD_MS = 5 * 60 * 1000;
export const STALE_THRESHOLD_MS = 30 * 60 * 1000;

export function deriveStatus(input: SessionStatusInput): SessionStatus {
  if (input.endedAt) return "ended";
  const now = (input.now ?? new Date()).getTime();
  const elapsed = now - input.lastEventAt.getTime();
  if (elapsed <= ACTIVE_THRESHOLD_MS) return "active";
  if (elapsed <= IDLE_THRESHOLD_MS) return "idle";
  if (elapsed <= STALE_THRESHOLD_MS) return "stale";
  return "ended";
}
