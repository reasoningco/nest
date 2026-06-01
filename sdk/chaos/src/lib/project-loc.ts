/**
 * LOC time-series per project, built from per-commit additions/deletions via
 * GitHub's GraphQL `history` field. We aggregate commit diffs per week, sum
 * across all repos in a project, and emit a cumulative series.
 *
 * GraphQL is used here instead of the REST code_frequency endpoint because
 * the latter is lazily computed server-side and can 202-loop for minutes.
 * Results are cached for 24h in the Cache table.
 */
import { prisma } from "./db";
import { loadSources, githubToken } from "./config";
import { ALL_TIME_ORIGIN } from "./time";

export const PROJECT_LOC_CACHE_KEY = "project-loc-series-v6";
const TTL_MS = 24 * 60 * 60 * 1000;
// Backend returns the full all-time window (from ALL_TIME_ORIGIN) and the
// frontend slices it based on the selected time-range tab.
const WEEKS_BUFFER = 2; // pad the window by a couple weeks so the first point
                       // lands on a Sunday on-or-before ALL_TIME_ORIGIN.
const WEEKLY_THROUGHPUT_CORRECTIONS = [
  {
    date: "2025-11-09",
    personId: "github:anmolgxrg",
    additions: 37_000,
  },
] as const;

export interface ProjectSeries {
  project: string;
  points: { date: string; loc: number }[]; // cumulative LOC at the week-ending date
}
export interface WeeklyLocContributor {
  personId: string;
  displayName: string;
  githubLogin: string | null;
  additions: number;
}
export interface WeeklyLocThroughputPoint {
  date: string;
  additions: number;
  contributors: WeeklyLocContributor[];
}
export interface ProjectLocPayload {
  projects: ProjectSeries[];
  weeks: string[];
  weeklyThroughput: WeeklyLocThroughputPoint[];
  cachedAt: string;
  computing: boolean;
}

// Tracks an in-flight compute so concurrent requests don't all kick off
// duplicate GraphQL fan-outs against GitHub.
let inFlightCompute: Promise<ProjectLocPayload> | null = null;

async function computeAndCache(): Promise<ProjectLocPayload> {
  if (inFlightCompute) return inFlightCompute;
  inFlightCompute = (async () => {
    try {
      const fresh = await compute();
      await prisma.cache.upsert({
        where: { key: PROJECT_LOC_CACHE_KEY },
        create: {
          key: PROJECT_LOC_CACHE_KEY,
          value: JSON.stringify(fresh),
          updatedAt: new Date(),
        },
        update: { value: JSON.stringify(fresh), updatedAt: new Date() },
      });
      return fresh;
    } finally {
      inFlightCompute = null;
    }
  })();
  return inFlightCompute;
}

/**
 * Stale-while-revalidate. Returns the cached payload immediately whenever
 * we have one, kicking off a background refresh if it's older than TTL.
 * Only the very first call (no cache at all) returns an empty placeholder
 * with `computing: true` while compute runs in the background — this
 * keeps the request well under nginx's proxy_read_timeout.
 */
export async function getProjectLoc(force = false): Promise<ProjectLocPayload> {
  const cached = await prisma.cache.findUnique({
    where: { key: PROJECT_LOC_CACHE_KEY },
  });

  if (force) {
    return computeAndCache();
  }

  if (cached) {
    const stale = Date.now() - cached.updatedAt.getTime() >= TTL_MS;
    if (stale) {
      // Fire-and-forget refresh; serve stale data this round.
      void computeAndCache().catch(() => {
        /* logged inside compute(); swallow so it never throws unhandled */
      });
    }
    return JSON.parse(cached.value) as ProjectLocPayload;
  }

  // Cold start: trigger compute in the background and return an empty
  // placeholder so the chart can render "Computing LOC history…" without
  // hanging nginx for ~minutes on the GitHub fan-out.
  void computeAndCache().catch(() => {
    /* logged inside compute(); swallow so it never throws unhandled */
  });
  return {
    projects: [],
    weeks: [],
    weeklyThroughput: [],
    cachedAt: new Date(0).toISOString(),
    computing: true,
  };
}

async function compute(): Promise<ProjectLocPayload> {
  const cfg = loadSources();
  const token = githubToken(cfg);
  if (!token) {
    return {
      projects: [],
      weeks: [],
      weeklyThroughput: [],
      cachedAt: new Date().toISOString(),
      computing: false,
    };
  }

  // Project → full (owner,name) tuples from config.
  // Step 1: Jira-mapped projects (DEV→ChefOS bundles ChefOS+ChefOsLP, etc.).
  const projectToRepos = new Map<string, { owner: string; name: string }[]>();
  const mappedRepos = new Set<string>();
  for (const p of cfg.jira?.projects ?? []) {
    const label = p.name ?? p.key;
    const resolved: { owner: string; name: string }[] = [];
    for (const r of p.repos ?? []) {
      const match = (cfg.github?.repos ?? []).find((x) => x.name === r);
      if (match) {
        resolved.push(match);
        mappedRepos.add(`${match.owner}/${match.name}`);
      }
    }
    if (resolved.length > 0) projectToRepos.set(label, resolved);
  }
  // Step 2: every other GitHub repo gets its own project entry keyed by repo
  // name, so the chart shows LOC for the whole org, not just Jira-mapped work.
  // Repos with the same name from different owners (e.g. reasoningco +
  // anmolgxrg forks of reasoningcompany-com) merge into one line.
  for (const r of cfg.github?.repos ?? []) {
    const key = `${r.owner}/${r.name}`;
    if (mappedRepos.has(key)) continue;
    const label = r.name;
    if (!projectToRepos.has(label)) projectToRepos.set(label, []);
    projectToRepos.get(label)!.push({ owner: r.owner, name: r.name });
  }

  // Window start = ALL_TIME_ORIGIN so the backend payload covers every
  // possible selected range; the frontend slices it.
  const sinceIso = ALL_TIME_ORIGIN;

  // Canonical week list: every week-ending Sunday from the window start to
  // "now". Every project emits a point for every one of these so lines stay
  // flat (rather than dropping to 0) during quiet periods.
  const canonicalWeeks = buildWeekListBetween(sinceIso, WEEKS_BUFFER);

  const projects: ProjectSeries[] = [];
  const peopleLookup = buildPeopleLookup(cfg.people);
  const throughputByWeek = new Map<
    string,
    Map<string, WeeklyLocContributor>
  >();
  const countedThroughputCommits = new Set<string>();

  for (const [project, repos] of projectToRepos) {
    const perRepo = await Promise.all(
      repos.map((r) => fetchCommitDiffs(token, r.owner, r.name, sinceIso)),
    );

    // Per-repo: map week → cumulative LOC at that week (only for weeks the
    // repo actually has commits).
    const repoSeries: { cum: Map<string, number>; lastCum: number }[] = [];
    for (const { recent, baseline } of perRepo) {
      const weekNet = new Map<string, number>();
      for (const c of recent) {
        const w = weekEnding(c.date);
        weekNet.set(w, (weekNet.get(w) ?? 0) + c.net);
        recordWeeklyThroughput({
          commit: c,
          week: w,
          peopleLookup,
          throughputByWeek,
          countedThroughputCommits,
        });
      }
      const cum = new Map<string, number>();
      let running = baseline;
      for (const w of [...weekNet.keys()].sort()) {
        running += weekNet.get(w) ?? 0;
        cum.set(w, running);
      }
      repoSeries.push({ cum, lastCum: baseline });
    }

    // Emit a point for every canonical week, carrying each repo's last known
    // cumulative forward so a project that goes quiet shows a flat line
    // instead of collapsing to zero.
    const points: { date: string; loc: number }[] = [];
    for (const w of canonicalWeeks) {
      for (const r of repoSeries) {
        const v = r.cum.get(w);
        if (v !== undefined) r.lastCum = v;
      }
      const total = repoSeries.reduce((a, b) => a + b.lastCum, 0);
      points.push({ date: w, loc: total });
    }
    projects.push({ project, points });
  }

  const weeks = canonicalWeeks;
  const weeklyThroughput = canonicalWeeks.map((date) => {
    const contributors = applyWeeklyThroughputCorrections(
      date,
      [...(throughputByWeek.get(date)?.values() ?? [])].map((c) => ({
        ...c,
      })),
    )
      .sort((a, z) => z.additions - a.additions)
      .map((c) => ({ ...c }));
    return {
      date,
      additions: contributors.reduce((sum, c) => sum + c.additions, 0),
      contributors,
    };
  });

  return {
    projects: projects.sort(
      (a, z) => (z.points.at(-1)?.loc ?? 0) - (a.points.at(-1)?.loc ?? 0),
    ),
    weeks,
    weeklyThroughput,
    cachedAt: new Date().toISOString(),
    computing: false,
  };
}

function buildWeekListBetween(sinceIso: string, padWeeks: number): string[] {
  // All Sundays from the week-ending on/after `sinceIso` up to the current
  // week-ending Sunday. `padWeeks` is an upper-bound safety cap if clocks
  // are skewed; otherwise we just emit one entry per calendar week.
  const sinceWeek = weekEnding(sinceIso);
  const endWeek = weekEnding(new Date().toISOString());
  const result: string[] = [];
  let cursor = new Date(sinceWeek + "T00:00:00Z");
  const end = new Date(endWeek + "T00:00:00Z");
  let safety = 0;
  const limit = Math.ceil(
    (end.getTime() - cursor.getTime()) / (7 * 86_400_000),
  ) + 1 + padWeeks;
  while (cursor.getTime() <= end.getTime() && safety < limit) {
    result.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 7);
    safety += 1;
  }
  return result;
}

function weekEnding(iso: string): string {
  const d = new Date(iso);
  const day = d.getUTCDay(); // 0 = Sunday
  const diff = (7 - day) % 7;
  d.setUTCDate(d.getUTCDate() + diff);
  return d.toISOString().slice(0, 10);
}

interface CommitDiff {
  owner: string;
  name: string;
  oid: string;
  date: string;
  additions: number;
  authorLogin: string | null;
  authorName: string | null;
  net: number; // additions - deletions
}

async function fetchCommitDiffs(
  token: string,
  owner: string,
  name: string,
  sinceIso: string,
): Promise<{ recent: CommitDiff[]; baseline: number }> {
  // Pass 1: commits *within* the window, paginated.
  const recent: CommitDiff[] = [];
  let cursor: string | null = null;
  for (let i = 0; i < 20; i++) {
    const history = await gqlHistory(token, owner, name, {
      since: sinceIso,
      after: cursor,
    });
    if (!history) break;
    for (const n of history.nodes ?? []) {
      recent.push({
        owner,
        name,
        oid: n.oid,
        date: n.committedDate as string,
        additions: n.additions ?? 0,
        authorLogin: n.author?.user?.login ?? null,
        authorName: n.author?.name ?? null,
        net: (n.additions ?? 0) - (n.deletions ?? 0),
      });
    }
    if (!history.pageInfo?.hasNextPage) break;
    cursor = history.pageInfo.endCursor;
  }

  // Pass 2: baseline = sum of net diffs for everything BEFORE the window.
  // Using GraphQL's `until:` filter so we only get out-of-window commits and
  // don't burn queries scrolling past the active region.
  let baseline = 0;
  let bCursor: string | null = null;
  for (let i = 0; i < 500; i++) {
    const history = await gqlHistory(token, owner, name, {
      until: sinceIso,
      after: bCursor,
    });
    if (!history) break;
    for (const n of history.nodes ?? []) {
      baseline += (n.additions ?? 0) - (n.deletions ?? 0);
    }
    if (!history.pageInfo?.hasNextPage) break;
    bCursor = history.pageInfo.endCursor;
  }
  if (baseline < 0) baseline = 0;
  return { recent, baseline };
}

async function gqlHistory(
  token: string,
  owner: string,
  name: string,
  opts: { since?: string; until?: string; after?: string | null },
): Promise<{
  nodes?: {
    oid: string;
    committedDate: string;
    additions: number;
    deletions: number;
    author?: { name?: string | null; user?: { login?: string | null } | null };
  }[];
  pageInfo?: { hasNextPage: boolean; endCursor: string };
} | null> {
  const frags: string[] = [];
  const varDecls: string[] = [];
  if (opts.since) {
    frags.push("since: $since");
    varDecls.push("$since: GitTimestamp!");
  }
  if (opts.until) {
    frags.push("until: $until");
    varDecls.push("$until: GitTimestamp!");
  }
  const extraFrag = frags.length ? ", " + frags.join(", ") : "";
  const extraVars = varDecls.length ? ", " + varDecls.join(", ") : "";
  const query = `query($owner:String!,$name:String!,$cursor:String${extraVars}){
    repository(owner:$owner,name:$name){
      defaultBranchRef{ target{ ... on Commit {
        history(first:100, after:$cursor${extraFrag}){
          nodes{ oid committedDate additions deletions author{ name user{ login } } }
          pageInfo{ hasNextPage endCursor }
        }
      }}}
    }
  }`;
  const variables: Record<string, unknown> = {
    owner,
    name,
    cursor: opts.after ?? null,
  };
  if (opts.since) variables.since = opts.since;
  if (opts.until) variables.until = opts.until;
  try {
    const resp = await fetch("https://api.github.com/graphql", {
      method: "POST",
      cache: "no-store",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "User-Agent": "chaos/0.1",
      },
      body: JSON.stringify({ query, variables }),
    });
    if (!resp.ok) return null;
    const data = (await resp.json()) as {
      data?: {
        repository?: {
          defaultBranchRef?: { target?: { history?: unknown } };
        };
      };
    };
    return (data.data?.repository?.defaultBranchRef?.target as any)?.history ?? null;
  } catch {
    return null;
  }
}

function buildPeopleLookup(
  people: ReturnType<typeof loadSources>["people"],
): {
  byLogin: Map<string, { displayName: string; githubLogin: string | null }>;
  byName: Map<string, { displayName: string; githubLogin: string | null }>;
} {
  const byLogin = new Map<
    string,
    { displayName: string; githubLogin: string | null }
  >();
  const byName = new Map<
    string,
    { displayName: string; githubLogin: string | null }
  >();
  for (const person of people) {
    const entry = {
      displayName: person.display_name,
      githubLogin: person.github ?? null,
    };
    byName.set(normalizeIdentityKey(person.display_name), entry);
    if (person.github) byLogin.set(person.github.toLowerCase(), entry);
    for (const alias of person.github_aliases ?? []) {
      byLogin.set(alias.toLowerCase(), entry);
      byName.set(normalizeIdentityKey(alias), entry);
    }
  }
  return { byLogin, byName };
}

function resolveContributor(
  commit: CommitDiff,
  peopleLookup: ReturnType<typeof buildPeopleLookup>,
): Omit<WeeklyLocContributor, "additions"> {
  const login = commit.authorLogin?.trim() || null;
  if (login) {
    const configured =
      peopleLookup.byLogin.get(login.toLowerCase()) ??
      peopleLookup.byName.get(normalizeIdentityKey(login));
    if (configured) {
      return {
        personId: `github:${configured.githubLogin ?? login}`.toLowerCase(),
        displayName: configured.displayName,
        githubLogin: configured.githubLogin ?? login,
      };
    }
    const name = commit.authorName?.trim();
    return {
      personId: name
        ? `name:${normalizeIdentityKey(name)}`
        : `github:${login}`.toLowerCase(),
      displayName: name || login,
      githubLogin: login,
    };
  }

  const name = commit.authorName?.trim() || "Unknown";
  const configured = peopleLookup.byName.get(normalizeIdentityKey(name));
  if (configured) {
    return {
      personId: configured.githubLogin
        ? `github:${configured.githubLogin}`.toLowerCase()
        : `name:${normalizeIdentityKey(configured.displayName)}`,
      displayName: configured.displayName,
      githubLogin: configured.githubLogin,
    };
  }

  return {
    personId: `name:${normalizeIdentityKey(name)}`,
    displayName: name,
    githubLogin: null,
  };
}

function normalizeIdentityKey(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function applyWeeklyThroughputCorrections(
  date: string,
  contributors: WeeklyLocContributor[],
): WeeklyLocContributor[] {
  for (const correction of WEEKLY_THROUGHPUT_CORRECTIONS) {
    if (correction.date !== date) continue;
    const contributor = contributors.find(
      (c) => c.personId === correction.personId,
    );
    if (!contributor) continue;
    contributor.additions = correction.additions;
  }
  return contributors;
}

function recordWeeklyThroughput({
  commit,
  week,
  peopleLookup,
  throughputByWeek,
  countedThroughputCommits,
}: {
  commit: CommitDiff;
  week: string;
  peopleLookup: ReturnType<typeof buildPeopleLookup>;
  throughputByWeek: Map<string, Map<string, WeeklyLocContributor>>;
  countedThroughputCommits: Set<string>;
}) {
  // Throughput counts default-branch additions only: deleted lines are ignored,
  // because this panel answers "how much code reached production this week".
  if (commit.additions <= 0) return;
  const commitKey = `${commit.owner}/${commit.name}:${commit.oid}`;
  if (countedThroughputCommits.has(commitKey)) return;
  countedThroughputCommits.add(commitKey);

  const contributor = resolveContributor(commit, peopleLookup);
  const contributors =
    throughputByWeek.get(week) ?? new Map<string, WeeklyLocContributor>();
  const current = contributors.get(contributor.personId) ?? {
    ...contributor,
    additions: 0,
  };
  if (!current.githubLogin && contributor.githubLogin) {
    current.githubLogin = contributor.githubLogin;
  }
  current.additions += commit.additions;
  contributors.set(contributor.personId, current);
  throughputByWeek.set(week, contributors);
}
