import pino from "pino";

export type Logger = pino.Logger;

export function createLogger(opts: {
  level: string;
  pretty: boolean;
}): Logger {
  const redact = {
    paths: [
      "apiKey",
      "api_key",
      "token",
      "secret",
      "password",
      "*.apiKey",
      "*.api_key",
      "*.token",
      "*.secret",
      "*.password",
      "headers.authorization",
      "*.headers.authorization",
      "config.CURSOR_API_KEY",
      "config.GITHUB_TOKEN",
      "config.JIRA_API_TOKEN",
      "config.JIRA_WEBHOOK_SECRET",
      "config.JIRA_EMAIL",
      "CURSOR_API_KEY",
      "GITHUB_TOKEN",
      "JIRA_API_TOKEN",
      "JIRA_WEBHOOK_SECRET",
    ],
    censor: "[REDACTED]",
  };

  if (opts.pretty) {
    return pino({
      level: opts.level,
      redact,
      transport: {
        target: "pino-pretty",
        options: { colorize: true, translateTime: "SYS:standard" },
      },
    });
  }
  return pino({ level: opts.level, redact });
}
