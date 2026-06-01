import { makeEventParser } from "./agent-telemetry";

export {
  MAX_FIRST_PROMPT_CHARS,
  verifyBearer,
  deriveStatus,
  ACTIVE_THRESHOLD_MS,
  IDLE_THRESHOLD_MS,
  STALE_THRESHOLD_MS,
} from "./agent-telemetry";
export type {
  AgentEventInput as CodexEventInput,
  ParseResult,
  SessionStatus,
  SessionStatusInput,
} from "./agent-telemetry";

/**
 * Hook events Codex CLI 0.125+ fires. Mirrors Claude's set, minus SessionEnd
 * (Codex doesn't have one), plus PermissionRequest (Codex-specific).
 */
const ALLOWED_EVENT_TYPES = new Set([
  "SessionStart",
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "Stop",
  "PermissionRequest",
  "Error",
]);

/**
 * Codex's `Stop` fires per turn, not per session — so unlike Claude (where
 * Stop / SessionEnd close the session), we leave the terminal set empty and
 * let the timeout in deriveStatus close stale sessions. Avoids marking
 * mid-conversation sessions "ended" prematurely.
 */
export const TERMINAL_EVENT_TYPES = new Set<string>();

export const parseEvent = makeEventParser({ allowedTypes: ALLOWED_EVENT_TYPES });
