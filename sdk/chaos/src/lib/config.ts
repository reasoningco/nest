import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { z } from "zod";

const PersonSchema = z.object({
  display_name: z.string().min(1),
  github: z.string().optional(),
  // Additional GitHub logins that should map to the same person (e.g. a
  // personal + work account). Activity from any of these attaches here.
  github_aliases: z.array(z.string()).default([]),
  jira_account_id: z.string().optional(),
  role: z.string().optional(),
  // Renders this person under the "Other contributors" heading in By Person
  // instead of the main team grid. Use for bots or external collaborators.
  external: z.boolean().default(false),
});

const GithubSchema = z.object({
  token_env: z.string().min(1),
  repos: z
    .array(z.object({ owner: z.string().min(1), name: z.string().min(1) }))
    .default([]),
  // Skip ingestion for these GitHub logins (case-insensitive). Existing
  // Activity rows are kept; only new commits/PRs are filtered out. Useful
  // for freezing a contributor's data without deleting it.
  exclude_logins: z.array(z.string()).default([]),
});

const JiraSchema = z.object({
  base_url: z.string().url(),
  email_env: z.string().min(1),
  token_env: z.string().min(1),
  projects: z
    .array(
      z.object({
        key: z.string().min(1),
        // Overrides the project bubble label in the UI (e.g. DEV → ChefOS).
        name: z.string().optional(),
        // GitHub repo names whose commits should bucket under the same project
        // for clustering + the bubble. Accepts a string or a list of strings.
        repos: z
          .union([z.string(), z.array(z.string())])
          .transform((v) => (typeof v === "string" ? [v] : v))
          .optional(),
      }),
    )
    .default([]),
});

export const SourcesSchema = z.object({
  github: GithubSchema.optional(),
  jira: JiraSchema.optional(),
  people: z.array(PersonSchema).default([]),
});

export type Sources = z.infer<typeof SourcesSchema>;
export type PersonConfig = z.infer<typeof PersonSchema>;

const CONFIG_PATH =
  process.env.CHAOS_CONFIG_PATH ||
  path.resolve(process.cwd(), "config/sources.yaml");

let cached: { mtimeMs: number; value: Sources } | null = null;

export function loadSources(): Sources {
  const stat = fs.statSync(CONFIG_PATH);
  if (cached && cached.mtimeMs === stat.mtimeMs) return cached.value;

  const raw = fs.readFileSync(CONFIG_PATH, "utf8");
  const parsed = YAML.parse(raw);
  const result = SourcesSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(
      `Invalid config/sources.yaml:\n${result.error.toString()}`,
    );
  }
  cached = { mtimeMs: stat.mtimeMs, value: result.data };
  return result.data;
}

export function configPath() {
  return CONFIG_PATH;
}

export function githubToken(cfg: Sources): string | null {
  if (!cfg.github) return null;
  const t = process.env[cfg.github.token_env];
  return t && t.length > 0 ? t : null;
}

export function jiraCreds(
  cfg: Sources,
): { baseUrl: string; email: string; token: string } | null {
  if (!cfg.jira) return null;
  const email = process.env[cfg.jira.email_env];
  const token = process.env[cfg.jira.token_env];
  if (!email || !token) return null;
  return { baseUrl: cfg.jira.base_url, email, token };
}

/** Dev-only hot reload. Call once at server boot. */
export function watchConfig(onChange: () => void) {
  if (process.env.NODE_ENV === "production") return;
  try {
    // Use fs.watchFile so we don't add chokidar to the hot path.
    fs.watchFile(CONFIG_PATH, { interval: 1000 }, () => {
      cached = null;
      try {
        loadSources();
        onChange();
      } catch (err) {
        console.error("[config] reload failed:", err);
      }
    });
  } catch {
    /* ignore */
  }
}
