/**
 * Feature grouping. Given a raw activity signal, return the featureKey that
 * collapses related commits/PRs/tickets into a single row.
 *
 * Priority (first match wins):
 *   1. Jira ticket reference — regex [A-Z][A-Z0-9]+-\d+
 *   2. Pull request          — "pr:<owner>/<repo>:<number>"
 *   3. Branch                — "branch:<owner>/<repo>:<branch>"
 *   4. null (activity stands alone)
 */

const JIRA_KEY_RE = /\b([A-Z][A-Z0-9]+-\d+)\b/;

export interface GroupingInput {
  repoOwner?: string;
  repoName?: string;
  commitMessage?: string | null;
  prTitle?: string | null;
  prNumber?: number | null;
  branchName?: string | null;
  jiraKey?: string | null;
  defaultBranch?: string | null;
}

export function assignFeatureKey(input: GroupingInput): string | null {
  // 1. Jira key — prefer explicit, else scan text fields.
  if (input.jiraKey) return input.jiraKey;
  const haystacks = [input.commitMessage, input.prTitle, input.branchName];
  for (const h of haystacks) {
    if (!h) continue;
    const m = h.match(JIRA_KEY_RE);
    if (m) return m[1];
  }

  // 2. Pull request.
  if (
    input.prNumber != null &&
    input.repoOwner &&
    input.repoName
  ) {
    return `pr:${input.repoOwner}/${input.repoName}:${input.prNumber}`;
  }

  // 3. Branch (non-default, no PR yet).
  if (
    input.branchName &&
    input.repoOwner &&
    input.repoName &&
    input.branchName !== (input.defaultBranch ?? "main") &&
    input.branchName !== "master"
  ) {
    return `branch:${input.repoOwner}/${input.repoName}:${input.branchName}`;
  }

  // 4. Fallback.
  return null;
}

export function featureSource(
  featureKey: string,
): "jira" | "pr" | "branch" {
  if (featureKey.startsWith("pr:")) return "pr";
  if (featureKey.startsWith("branch:")) return "branch";
  return "jira";
}
