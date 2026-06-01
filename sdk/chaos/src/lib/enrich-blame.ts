import { prisma } from "./db";
import { loadSources, githubToken } from "./config";

export interface BlameEnrichResult {
  candidates: number;
  processed: number;
  updated: number;
  failed: number;
}

const HEADERS = (token: string) => ({
  Authorization: `Bearer ${token}`,
  "User-Agent": "chaos/0.1",
  "Content-Type": "application/json",
});

const BLAME_ATTRIBUTION_VERSION = 2;

async function markBlame(
  id: string,
  linesRemovedFrom: Record<string, number>,
  status: "ok" | "empty",
) {
  const row = await prisma.activity.findUnique({ where: { id } });
  if (!row) return;
  let m: Record<string, unknown> = {};
  try { m = JSON.parse(row.metadata); } catch { /**/ }
  m.linesRemovedFrom = linesRemovedFrom;
  m.linesRemovedFromVersion = BLAME_ATTRIBUTION_VERSION;
  m.linesRemovedFromStatus = status;
  await prisma.activity.update({ where: { id }, data: { metadata: JSON.stringify(m) } });
}

function parseDeletedLines(patch: string): number[] {
  const deleted: number[] = [];
  let oldLine = 0;
  for (const line of patch.split("\n")) {
    if (line.startsWith("@@")) {
      const m = line.match(/@@ -(\d+)/);
      if (m) oldLine = parseInt(m[1], 10);
    } else if (line.startsWith("-")) {
      deleted.push(oldLine++);
    } else if (!line.startsWith("+")) {
      oldLine++;
    }
  }
  return deleted;
}

interface CommitFile {
  filename: string;
  previous_filename?: string;
  patch?: string;
  deletions: number;
  status: string;
}

interface BlameRange {
  startingLine: number;
  endingLine: number;
  commit: { author: { user: { login: string } | null } };
}

export async function enrichBlameStats(): Promise<BlameEnrichResult> {
  const result: BlameEnrichResult = { candidates: 0, processed: 0, updated: 0, failed: 0 };
  const cfg = loadSources();
  const token = githubToken(cfg);
  if (!token) return result;

  const all = await prisma.activity.findMany({
    where: { source: "github", type: "commit" },
    select: { id: true, metadata: true },
    orderBy: { occurredAt: "desc" },
  });

  interface Candidate {
    id: string;
    sha: string;
    owner: string;
    repo: string;
    deletions: number;
  }

  const loginToPersonId = new Map<string, string>();
  const people = await prisma.person.findMany({ select: { id: true, githubLogin: true } });
  for (const p of people) {
    if (p.githubLogin) loginToPersonId.set(p.githubLogin.toLowerCase(), p.id);
  }
  for (const cp of cfg.people) {
    const person = people.find(
      (p) => p.githubLogin?.toLowerCase() === cp.github?.toLowerCase(),
    );
    if (!person) continue;
    for (const alias of cp.github_aliases ?? []) {
      loginToPersonId.set(alias.toLowerCase(), person.id);
    }
  }

  const zeroDeletion: { id: string }[] = [];
  const nonZero: Candidate[] = [];

  for (const a of all) {
    let m: Record<string, unknown> = {};
    try { m = JSON.parse(a.metadata) as Record<string, unknown>; } catch { /* non-JSON */ }
    if (m.linesRemovedFromVersion === BLAME_ATTRIBUTION_VERSION) continue;
    if (typeof m.additions !== "number") continue;
    const sha = typeof m.sha === "string" ? m.sha : null;
    const owner = typeof m.owner === "string" ? m.owner : null;
    const repo = typeof m.repo === "string" ? m.repo : null;
    if (!sha || !owner || !repo) continue;
    const deletions = typeof m.deletions === "number" ? m.deletions : 0;
    if (deletions === 0) {
      zeroDeletion.push({ id: a.id });
    } else {
      nonZero.push({ id: a.id, sha, owner, repo, deletions });
    }
  }

  result.candidates = zeroDeletion.length + nonZero.length;

  // Zero-deletion commits need no API calls.
  for (const z of zeroDeletion) {
    await markBlame(z.id, {}, "empty");
    result.processed += 1;
    result.updated += 1;
  }

  // Non-zero deletions: cap at 30 per sync to stay within rate limits.
  const batch = nonZero.slice(0, 30);
  for (const item of batch) {
    result.processed += 1;
    try {
      const resp = await fetch(
        `https://api.github.com/repos/${item.owner}/${item.repo}/commits/${item.sha}`,
        { headers: { ...HEADERS(token), Accept: "application/vnd.github+json" } },
      );
      if (!resp.ok) {
        result.failed += 1;
        continue;
      }

      const body = (await resp.json()) as {
        parents?: { sha: string }[];
        files?: CommitFile[];
      };

      const parentSha = body.parents?.[0]?.sha;
      if (!parentSha) {
        // Initial commit — no parent to blame against.
        await markBlame(item.id, {}, "empty");
        result.updated += 1;
        continue;
      }

      const files = (body.files ?? [])
        .filter(
          (f) =>
            f.deletions > 0 &&
            f.patch &&
            f.status !== "added",
        )
        .sort((a, b) => b.deletions - a.deletions)
        .slice(0, 20);

      if (files.length === 0) {
        await markBlame(item.id, {}, "empty");
        result.updated += 1;
        continue;
      }

      // Build one batched GraphQL query using aliased blame fields on the
      // parent commit. GitHub exposes blame on Commit, not Blob.
      const fieldDefs = files
        .map((f, i) => {
          const blamePath = f.status === "renamed" && f.previous_filename
            ? f.previous_filename
            : f.filename;
          return `f${i}: blame(path:${JSON.stringify(blamePath)}){ranges{startingLine endingLine commit{author{user{login}}}}}`;
        })
        .join("\n");

      const gqlQuery = `query($owner:String!,$repo:String!){
        repository(owner:$owner,name:$repo){
          target: object(expression:${JSON.stringify(parentSha)}){
            ...on Commit{
              ${fieldDefs}
            }
          }
        }
      }`;

      let gqlResp;
      try {
        gqlResp = await fetch("https://api.github.com/graphql", {
          method: "POST",
          headers: HEADERS(token),
          body: JSON.stringify({
            query: gqlQuery,
            variables: { owner: item.owner, repo: item.repo },
          }),
        });
      } catch {
        result.failed += 1;
        continue;
      }

      if (!gqlResp.ok) {
        result.failed += 1;
        continue;
      }

      const gqlBody = (await gqlResp.json()) as {
        data?: {
          repository?: {
            target?: Record<string, { ranges?: BlameRange[] } | null> | null;
          };
        };
        errors?: { message?: string }[];
      };

      if (gqlBody.errors?.length) {
        result.failed += 1;
        continue;
      }

      const blameData = gqlBody.data?.repository?.target;

      // Tally removed lines per login across all files.
      const loginCounts = new Map<string, number>();
      for (let i = 0; i < files.length; i++) {
        const fileBlame = blameData?.[`f${i}`]?.ranges;
        if (!fileBlame) continue;
        const deletedLines = parseDeletedLines(files[i].patch!);
        for (const lineNum of deletedLines) {
          const range = fileBlame.find(
            (r) => r.startingLine <= lineNum && lineNum <= r.endingLine,
          );
          const login = range?.commit?.author?.user?.login;
          if (!login) continue;
          loginCounts.set(login, (loginCounts.get(login) ?? 0) + 1);
        }
      }

      // Convert logins to personIds.
      const linesRemovedFrom: Record<string, number> = {};
      for (const [login, count] of loginCounts) {
        const personId = loginToPersonId.get(login.toLowerCase());
        if (!personId) continue;
        linesRemovedFrom[personId] = (linesRemovedFrom[personId] ?? 0) + count;
      }

      await markBlame(
        item.id,
        linesRemovedFrom,
        Object.keys(linesRemovedFrom).length > 0 ? "ok" : "empty",
      );
      result.updated += 1;
    } catch {
      result.failed += 1;
    }
  }

  return result;
}
