import { z } from "zod";

const schema = z.object({
  CURSOR_API_KEY: z.string().min(1),
  TARGET_REPO_URL: z.string().url(),
  GITHUB_TOKEN: z.string().min(1),
  JIRA_BASE_URL: z.string().url(),
  JIRA_EMAIL: z.string().email(),
  JIRA_API_TOKEN: z.string().min(1),
  JIRA_WEBHOOK_SECRET: z.string().min(1),
  TRIGGER_LABEL: z.string().min(1).default("cursor"),
  DEFAULT_MODEL: z.string().optional().default(""),
  POLL_INTERVAL_MS: z.coerce.number().int().positive().default(60_000),
  PR_TIMEOUT_MS: z.coerce.number().int().positive().default(1_800_000),
  PORT: z.coerce.number().int().positive().default(8787),
  DATA_DIR: z.string().min(1).default("./data"),
  // Bearer token guarding the admin API (/api/repo-mappings). When unset
  // those endpoints are 503'd so a misconfigured deploy can't be exploited.
  BRIDGE_ADMIN_TOKEN: z.string().min(16).optional(),
  // Comma-separated list of origins allowed to call the admin API directly
  // from a browser. Server-side proxies (e.g. SDM NEST) don't need this.
  // Example: "https://sdm-nest.reasoning.company"
  BRIDGE_CORS_ORIGINS: z.string().optional().default(""),
  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
    .default("info"),
  NODE_ENV: z.string().default("development"),
});

export type Config = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    console.error(`Invalid configuration:\n${issues}`);
    process.exit(1);
  }
  return parsed.data;
}

export function parseRepoUrl(url: string): { owner: string; repo: string } {
  const m = url.match(/github\.com[/:]([^/]+)\/([^/.]+)(?:\.git)?\/?$/);
  if (!m) throw new Error(`Cannot parse GitHub repo url: ${url}`);
  return { owner: m[1]!, repo: m[2]! };
}
