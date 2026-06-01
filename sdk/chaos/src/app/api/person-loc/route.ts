import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { ALL_TIME_ORIGIN } from "@/lib/time";
import { countedCommitLoc, shouldCountCommitLoc } from "@/lib/commit-loc";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface WeekPoint {
  date: string; // week-ending Sunday, YYYY-MM-DD
  additions: number;
  deletions: number;
  removedFromMe: number;
}

function weekEnding(iso: string): string {
  const d = new Date(iso);
  const day = d.getUTCDay();
  const diff = (7 - day) % 7;
  d.setUTCDate(d.getUTCDate() + diff);
  return d.toISOString().slice(0, 10);
}

function buildWeekList(sinceIso: string): string[] {
  const sinceWeek = weekEnding(sinceIso);
  const endWeek = weekEnding(new Date().toISOString());
  const out: string[] = [];
  const cursor = new Date(sinceWeek + "T00:00:00Z");
  const end = new Date(endWeek + "T00:00:00Z");
  let safety = 0;
  while (cursor.getTime() <= end.getTime() && safety < 520) {
    out.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 7);
    safety += 1;
  }
  return out;
}

export async function GET(req: NextRequest) {
  // Auth happens in middleware (bearer token on /api/*) — nothing extra
  // here. The old graph-code unlock gate was for the public chaos UI,
  // which has moved to NEST behind Cloudflare Access.
  const url = new URL(req.url);
  const personId = url.searchParams.get("personId");
  if (!personId) {
    return NextResponse.json({ error: "personId required" }, { status: 400 });
  }

  const since = new Date(ALL_TIME_ORIGIN);
  const rows = await prisma.activity.findMany({
    where: {
      personId,
      source: "github",
      type: "commit",
      occurredAt: { gte: since },
    },
    select: { occurredAt: true, title: true, metadata: true },
  });

  let totalAdditions = 0;
  let totalDeletions = 0;
  const weekMap = new Map<string, WeekPoint>();

  for (const r of rows) {
    const loc = countedCommitLoc({ title: r.title, metadata: r.metadata });
    if (!loc) continue;
    totalAdditions += loc.additions;
    totalDeletions += loc.deletions;

    const w = weekEnding(r.occurredAt.toISOString());
    const slot = weekMap.get(w) ?? {
      date: w,
      additions: 0,
      deletions: 0,
      removedFromMe: 0,
    };
    slot.additions += loc.additions;
    slot.deletions += loc.deletions;
    weekMap.set(w, slot);
  }

  const allCommits = await prisma.activity.findMany({
    where: { source: "github", type: "commit", occurredAt: { gte: since } },
    select: { occurredAt: true, title: true, metadata: true },
  });

  let totalRemovedFromMe = 0;
  const removedByWeek = new Map<string, number>();

  for (const r of allCommits) {
    let m: { linesRemovedFrom?: Record<string, number> } & Record<
      string,
      unknown
    > = {};
    try {
      m = JSON.parse(r.metadata);
    } catch {
      continue;
    }
    if (!shouldCountCommitLoc({ title: r.title, metadata: m })) continue;
    const n = m.linesRemovedFrom?.[personId] ?? 0;
    if (n <= 0) continue;
    totalRemovedFromMe += n;
    const w = weekEnding(r.occurredAt.toISOString());
    removedByWeek.set(w, (removedByWeek.get(w) ?? 0) + n);
  }

  const weeks = buildWeekList(ALL_TIME_ORIGIN);
  const points = weeks.map((w) => ({
    ...weekMap.get(w) ?? { date: w, additions: 0, deletions: 0 },
    removedFromMe: removedByWeek.get(w) ?? 0,
  }));

  return NextResponse.json({
    personId,
    totalAdditions,
    totalDeletions,
    totalRemovedFromMe,
    points,
  });
}
