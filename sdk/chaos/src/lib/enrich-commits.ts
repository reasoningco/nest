/**
 * Backfills additions/deletions onto commit Activity.metadata using GitHub's
 * GraphQL history field. Runs at the end of each sync; idempotent (skips
 * commits that already have stats).
 *
 * GitHub REST /commits/{sha} would work but requires one call per commit.
 * GraphQL pulls ~100 commits per call with adds/dels inline.
 */
import { prisma } from "./db";
import { loadSources, githubToken } from "./config";

export interface EnrichResult {
  candidates: number; // commits that needed stats
  fetched: number; // commits for which we obtained stats from GH
  updated: number; // commits whose metadata was rewritten
}

interface MissingCommit {
  id: string;
  owner: string;
  repo: string;
  sha: string;
}

interface CommitStats {
  additions: number;
  deletions: number;
  parentCount: number;
}

export async function enrichCommitStats(): Promise<EnrichResult> {
  const result: EnrichResult = { candidates: 0, fetched: 0, updated: 0 };
  const cfg = loadSources();
  const token = githubToken(cfg);
  if (!token) return result;

  // Load all commit activities with their metadata (SQLite + Prisma can't
  // easily query inside a JSON-encoded text column, so we filter in app code).
  const all = await prisma.activity.findMany({
    where: { source: "github", type: "commit" },
    select: { id: true, metadata: true },
  });

  const missing: MissingCommit[] = [];
  for (const a of all) {
    let m: Record<string, unknown> = {};
    try {
      m = JSON.parse(a.metadata) as Record<string, unknown>;
    } catch {
      /* non-JSON */
    }
    if (
      typeof m.additions === "number" &&
      typeof m.deletions === "number" &&
      typeof m.parentCount === "number"
    )
      continue;
    const owner = typeof m.owner === "string" ? m.owner : null;
    const repo = typeof m.repo === "string" ? m.repo : null;
    const sha = typeof m.sha === "string" ? m.sha : null;
    if (!owner || !repo || !sha) continue;
    missing.push({ id: a.id, owner, repo, sha });
  }
  result.candidates = missing.length;
  if (missing.length === 0) return result;

  // Group by repo to minimise GraphQL calls.
  const byRepo = new Map<string, MissingCommit[]>();
  for (const m of missing) {
    const key = `${m.owner}/${m.repo}`;
    if (!byRepo.has(key)) byRepo.set(key, []);
    byRepo.get(key)!.push(m);
  }

  for (const [key, items] of byRepo) {
    const [owner, repo] = key.split("/");
    const shas = new Set(items.map((x) => x.sha));
    const shaMap = await fetchRepoHistoryStats(token, owner, repo, shas);

    // Fallback: any SHA not found via the default-branch GraphQL walk
    // (e.g. commits on feature branches) gets fetched individually via REST.
    const stillMissing = items.filter((x) => !shaMap.has(x.sha));
    if (stillMissing.length > 0) {
      const fallback = await fetchCommitStatsDirect(
        token,
        owner,
        repo,
        stillMissing.map((x) => x.sha),
      );
      for (const [sha, stats] of fallback) shaMap.set(sha, stats);
    }

    for (const item of items) {
      const stats = shaMap.get(item.sha);
      if (!stats) continue;
      result.fetched += 1;
      const row = await prisma.activity.findUnique({ where: { id: item.id } });
      if (!row) continue;
      let m: Record<string, unknown> = {};
      try {
        m = JSON.parse(row.metadata) as Record<string, unknown>;
      } catch {
        /* ignore */
      }
      m.additions = stats.additions;
      m.deletions = stats.deletions;
      m.parentCount = stats.parentCount;
      await prisma.activity.update({
        where: { id: item.id },
        data: { metadata: JSON.stringify(m) },
      });
      result.updated += 1;
    }
  }

  return result;
}

/**
 * Fetch stats for specific SHAs directly via REST API. Used as a fallback for
 * commits not reachable from the default branch (e.g. open feature branches).
 * Runs sequentially to avoid hammering the secondary rate limit.
 */
async function fetchCommitStatsDirect(
  token: string,
  owner: string,
  repo: string,
  shas: string[],
): Promise<Map<string, CommitStats>> {
  const map = new Map<string, CommitStats>();
  for (const sha of shas) {
    try {
      const resp = await fetch(
        `https://api.github.com/repos/${owner}/${repo}/commits/${sha}`,
        {
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: "application/vnd.github+json",
            "User-Agent": "chaos/0.1",
          },
        },
      );
      if (!resp.ok) continue;
      const body = (await resp.json()) as {
        stats?: { additions?: number; deletions?: number };
        parents?: unknown[];
      };
      const additions = body.stats?.additions;
      const deletions = body.stats?.deletions;
      if (typeof additions === "number" && typeof deletions === "number") {
        map.set(sha, {
          additions,
          deletions,
          parentCount: Array.isArray(body.parents) ? body.parents.length : 0,
        });
      }
    } catch {
      /* best-effort */
    }
  }
  return map;
}

/**
 * Walk the default-branch history and collect { additions, deletions } keyed
 * by commit SHA. Stops early once we've covered every requested SHA.
 */
async function fetchRepoHistoryStats(
  token: string,
  owner: string,
  name: string,
  needed: Set<string>,
): Promise<Map<string, CommitStats>> {
  const map = new Map<string, CommitStats>();
  let cursor: string | null = null;
  // Up to 50 pages × 100 commits = 5000 commits. Our biggest repo has ~900
  // commits in the tracking window.
  for (let i = 0; i < 50; i++) {
    const query = `query($o:String!,$r:String!,$c:String){
      repository(owner:$o,name:$r){
        defaultBranchRef{ target{ ... on Commit {
          history(first:100, after:$c){
            nodes{ oid additions deletions parents{ totalCount } }
            pageInfo{ hasNextPage endCursor }
          }
        }}}
      }
    }`;
    let resp;
    try {
      resp = await fetch("https://api.github.com/graphql", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          "User-Agent": "chaos/0.1",
        },
        body: JSON.stringify({
          query,
          variables: { o: owner, r: name, c: cursor },
        }),
      });
    } catch {
      break;
    }
    if (!resp.ok) break;
    const body = (await resp.json()) as {
      data?: {
        repository?: {
          defaultBranchRef?: {
            target?: {
              history?: {
                nodes?: {
                  oid: string;
                  additions: number;
                  deletions: number;
                  parents?: { totalCount?: number };
                }[];
                pageInfo?: { hasNextPage: boolean; endCursor: string };
              };
            };
          };
        };
      };
    };
    const history = body.data?.repository?.defaultBranchRef?.target?.history;
    if (!history) break;
    for (const n of history.nodes ?? []) {
      if (needed.has(n.oid)) {
        map.set(n.oid, {
          additions: n.additions,
          deletions: n.deletions,
          parentCount: n.parents?.totalCount ?? 0,
        });
      }
    }
    // Early-exit if we've covered all needed SHAs.
    let stillNeed = false;
    for (const s of needed) {
      if (!map.has(s)) {
        stillNeed = true;
        break;
      }
    }
    if (!stillNeed) break;
    if (!history.pageInfo?.hasNextPage) break;
    cursor = history.pageInfo.endCursor;
  }
  return map;
}
