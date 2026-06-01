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
  AgentEventInput as ClaudeEventInput,
  ParseResult,
  SessionStatus,
  SessionStatusInput,
} from "./agent-telemetry";

const ALLOWED_EVENT_TYPES = new Set([
  "SessionStart",
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "Stop",
  "SessionEnd",
  "Error",
]);

export const TERMINAL_EVENT_TYPES = new Set(["Stop", "SessionEnd"]);

export const parseEvent = makeEventParser({ allowedTypes: ALLOWED_EVENT_TYPES });
