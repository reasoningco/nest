import { loadSources } from "./config";

const JIRA_KEY_RE = /^[A-Z][A-Z0-9]+-\d+$/;

export interface ProjectMapping {
  // Raw Jira project key → display name (e.g. "DEV" → "ChefOS")
  jiraNameByKey: Map<string, string>;
  // GitHub repo name → display name (e.g. "form" → "Forms", "ChefOS" → "ChefOS")
  nameByRepo: Map<string, string>;
}

export function buildProjectMapping(): ProjectMapping {
  const jiraNameByKey = new Map<string, string>();
  const nameByRepo = new Map<string, string>();
  try {
    const cfg = loadSources();
    for (const p of cfg.jira?.projects ?? []) {
      const label = p.name ?? p.key;
      jiraNameByKey.set(p.key, label);
      for (const r of p.repos ?? []) nameByRepo.set(r, label);
    }
  } catch {
    /* config not readable — return empty maps */
  }
  return { jiraNameByKey, nameByRepo };
}

/** Project bubble / clustering label for an activity + its featureKey. */
export function deriveProject(
  source: string,
  featureKey: string | null,
  metadataRaw: string,
  m: ProjectMapping,
): string | null {
  // Jira key pattern → look up display name
  if (featureKey && JIRA_KEY_RE.test(featureKey)) {
    const key = featureKey.split("-")[0];
    return m.jiraNameByKey.get(key) ?? key;
  }
  // "pr:owner/repo:num" / "branch:owner/repo:branch" → repo name (mapped if configured)
  if (
    featureKey &&
    (featureKey.startsWith("pr:") || featureKey.startsWith("branch:"))
  ) {
    const parts = featureKey.split(":");
    if (parts.length >= 2) {
      const repo = parts[1].split("/")[1];
      if (repo) return m.nameByRepo.get(repo) ?? repo;
    }
  }
  // Fall back to metadata
  try {
    const meta = JSON.parse(metadataRaw) as { repo?: string; projectKey?: string };
    if (source === "jira" && meta.projectKey) {
      return m.jiraNameByKey.get(meta.projectKey) ?? meta.projectKey;
    }
    if (source === "github" && meta.repo) {
      return m.nameByRepo.get(meta.repo) ?? meta.repo;
    }
  } catch {
    /* non-JSON metadata */
  }
  return null;
}
