import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { loadSources } from "@/lib/config";
import { buildProjectMapping, deriveProject } from "@/lib/project";
import { ALL_TIME_ORIGIN } from "@/lib/time";
import { countedCommitLoc } from "@/lib/commit-loc";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Range = "today" | "24h" | "7d" | "30d" | "all";

function sinceFor(range: Range): Date {
  const now = new Date();
  const d = new Date(now);
  switch (range) {
    case "today":
      d.setHours(0, 0, 0, 0);
      return d;
    case "24h":
      d.setHours(d.getHours() - 24);
      return d;
    case "7d":
      d.setDate(d.getDate() - 7);
      return d;
    case "all":
      return new Date(ALL_TIME_ORIGIN);
    case "30d":
    default:
      d.setDate(d.getDate() - 30);
      return d;
  }
}

interface FeatureRollup {
  featureKey: string | null;
  title: string;
  source: string; // jira | pr | branch | commit (fallback)
  url: string | null;
  personId: string;
  status: "done" | "merged" | "in_review" | "in_progress" | "open";
  commitCount: number;
  prCount: number;
  mergedCount: number;
  issueDoneCount: number;
  firstSeen: string;
  lastSeen: string;
  detailId: string;
  project: string | null; // "ChefOS" | "DEV" | null — used for the project bubble + By-project view
}


export async function GET(req: Request) {
  const url = new URL(req.url);
  const range = (url.searchParams.get("range") as Range) || "7d";
  const since = sinceFor(range);

  const projectMap = buildProjectMapping();
  const SIGNIFICANT_COMMIT_LOC = 150;

  // Configured logins → external flag. A login is external if either:
  //   - it has `external: true` in sources.yaml people, or
  //   - it isn't in the people config at all (auto-registered from commits).
  // Both render under "Other contributors" in By Person.
  const externalByLogin = (() => {
    const m = new Map<string, boolean>();
    try {
      const cfg = loadSources();
      for (const p of cfg.people) {
        if (p.github) m.set(p.github.toLowerCase(), p.external);
        for (const a of p.github_aliases) m.set(a.toLowerCase(), p.external);
      }
    } catch {
      /* config not readable */
    }
    return m;
  })();

  const [people, activities, features, unmapped] = await Promise.all([
    prisma.person.findMany({ orderBy: { displayName: "asc" } }),
    prisma.activity.findMany({
      where: { occurredAt: { gte: since } },
      orderBy: { occurredAt: "desc" },
    }),
    prisma.feature.findMany(),
    prisma.unmappedContributor.count(),
  ]);

  const featureByKey = new Map(features.map((f) => [f.featureKey, f]));

  // Per-person counts for the By-person card headline: (commits whose
  // additions exceed the significance threshold) + (tickets closed).
  const personCounts = new Map<
    string,
    {
      commitCount: number;
      linesAdded: number;
      linesRemoved: number;
      significantCommits: number;
      significantAnonCommits: number;
      ticketsClosed: number;
    }
  >();
  for (const a of activities) {
    const slot = personCounts.get(a.personId) ?? {
      commitCount: 0,
      linesAdded: 0,
      linesRemoved: 0,
      significantCommits: 0,
      significantAnonCommits: 0,
      ticketsClosed: 0,
    };
    if (a.type === "commit") {
      slot.commitCount += 1;
      const loc = countedCommitLoc({ title: a.title, metadata: a.metadata });
      if (loc) {
        slot.linesAdded += loc.additions;
        slot.linesRemoved += loc.deletions;
        if (loc.additions > SIGNIFICANT_COMMIT_LOC) {
          slot.significantCommits += 1;
          if (!a.featureKey) slot.significantAnonCommits += 1;
        }
      }
    } else if (a.type === "issue_done") {
      slot.ticketsClosed += 1;
    }
    personCounts.set(a.personId, slot);
  }

  // Build (personId, featureKey) → rollup.
  const rollupMap = new Map<string, FeatureRollup>();
  const standalone: FeatureRollup[] = [];

  for (const a of activities) {
    const key = a.featureKey;
    const personId = a.personId;
    const bucketId = key ? `${personId}::${key}` : null;

    let rollup: FeatureRollup;
    if (bucketId && rollupMap.has(bucketId)) {
      rollup = rollupMap.get(bucketId)!;
    } else {
      const feat = key ? featureByKey.get(key) : null;
      rollup = {
        featureKey: key,
        title: feat?.title ?? a.title,
        source: feat?.source ?? a.source,
        url: a.url ?? null,
        personId,
        status: "open",
        commitCount: 0,
        prCount: 0,
        mergedCount: 0,
        issueDoneCount: 0,
        firstSeen: a.occurredAt.toISOString(),
        lastSeen: a.occurredAt.toISOString(),
        detailId: key
          ? `${personId}:${encodeURIComponent(key)}`
          : `anon:${a.id}`,
        project: deriveProject(a.source, key, a.metadata, projectMap),
      };
      if (bucketId) rollupMap.set(bucketId, rollup);
      else standalone.push(rollup);
    }

    if (a.occurredAt.toISOString() < rollup.firstSeen) rollup.firstSeen = a.occurredAt.toISOString();
    if (a.occurredAt.toISOString() > rollup.lastSeen) {
      rollup.lastSeen = a.occurredAt.toISOString();
      if (a.url) rollup.url = a.url;
    }

    switch (a.type) {
      case "commit":
        rollup.commitCount += 1;
        break;
      case "pr_opened":
        rollup.prCount += 1;
        if (rollup.status === "open") rollup.status = "in_review";
        break;
      case "pr_merged":
        rollup.mergedCount += 1;
        rollup.status = "merged";
        break;
      case "issue_done":
        rollup.issueDoneCount += 1;
        rollup.status = "done";
        break;
      case "issue_in_progress":
        if (rollup.status === "open") rollup.status = "in_progress";
        break;
      case "issue_created":
        // leave status as-is
        break;
    }
  }

  const rollups = [...rollupMap.values(), ...standalone].sort(
    (a, b) => (a.lastSeen < b.lastSeen ? 1 : -1),
  );

  return NextResponse.json({
    range,
    since: since.toISOString(),
    people: people.map((p) => {
      const c = personCounts.get(p.id) ?? {
        commitCount: 0,
        linesAdded: 0,
        linesRemoved: 0,
        significantCommits: 0,
        significantAnonCommits: 0,
        ticketsClosed: 0,
      };
      return {
        id: p.id,
        displayName: p.displayName,
        role: p.role,
        githubLogin: p.githubLogin,
        external: p.githubLogin
          ? externalByLogin.get(p.githubLogin.toLowerCase()) ?? true
          : false,
        commitCount: c.commitCount,
        linesAdded: c.linesAdded,
        linesRemoved: c.linesRemoved,
        significantCommits: c.significantCommits,
        significantAnonCommits: c.significantAnonCommits,
        ticketsClosed: c.ticketsClosed,
      };
    }),
    rollups,
    unmappedCount: unmapped,
  });
}
