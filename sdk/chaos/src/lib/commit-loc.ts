export interface CountedCommitLoc {
  additions: number;
  deletions: number;
}

export function countedCommitLoc(input: {
  title?: string | null;
  metadata: string;
}): CountedCommitLoc | null {
  let metadata: Record<string, unknown>;
  try {
    metadata = JSON.parse(input.metadata) as Record<string, unknown>;
  } catch {
    return null;
  }

  if (!shouldCountCommitLoc({ title: input.title, metadata })) {
    return null;
  }

  const additions = metadata.additions;
  const deletions = metadata.deletions;
  if (typeof additions !== "number" || typeof deletions !== "number") {
    return null;
  }

  return { additions, deletions };
}

export function shouldCountCommitLoc(input: {
  title?: string | null;
  metadata?: Record<string, unknown>;
}): boolean {
  const parentCount = input.metadata?.parentCount;
  if (typeof parentCount === "number" && parentCount > 1) return false;
  if (isMergeLikeCommitTitle(input.title)) return false;
  return true;
}

export function isMergeLikeCommitTitle(
  title: string | null | undefined,
): boolean {
  const text = title?.trim() ?? "";
  if (!text) return false;

  return [
    /^merge pull request\b/i,
    /^merge branch\b/i,
    /^merge remote-tracking branch\b/i,
    /^merge (?:origin|upstream)\/\S+\b/i,
    /^merge (?:main|master|develop|dev)\b/i,
    /^merge .+\binto\b/i,
    /^merge from\b/i,
    /^merge:\s/i,
  ].some((pattern) => pattern.test(text));
}
