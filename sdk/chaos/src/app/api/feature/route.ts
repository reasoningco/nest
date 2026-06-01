import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// GET /api/feature?id=<personId>:<featureKey>   or   ?id=anon:<activityId>
export async function GET(req: Request) {
  const url = new URL(req.url);
  const id = url.searchParams.get("id");
  if (!id) {
    return NextResponse.json({ error: "missing id" }, { status: 400 });
  }

  if (id.startsWith("anon:")) {
    const activityId = id.slice("anon:".length);
    const a = await prisma.activity.findUnique({ where: { id: activityId } });
    if (!a) return NextResponse.json({ error: "not found" }, { status: 404 });
    const person = await prisma.person.findUnique({ where: { id: a.personId } });
    return NextResponse.json({
      featureKey: null,
      title: a.title,
      source: a.source,
      person: person ? { id: person.id, displayName: person.displayName } : null,
      activities: [
        {
          id: a.id,
          source: a.source,
          type: a.type,
          title: a.title,
          url: a.url,
          occurredAt: a.occurredAt.toISOString(),
          metadata: safeJson(a.metadata),
        },
      ],
    });
  }

  const sep = id.indexOf(":");
  if (sep < 0) return NextResponse.json({ error: "bad id" }, { status: 400 });
  const personId = id.slice(0, sep);
  const featureKey = decodeURIComponent(id.slice(sep + 1));

  const [feature, person, activities] = await Promise.all([
    prisma.feature.findUnique({ where: { featureKey } }),
    prisma.person.findUnique({ where: { id: personId } }),
    prisma.activity.findMany({
      where: { personId, featureKey },
      orderBy: { occurredAt: "asc" },
    }),
  ]);

  if (!feature || !person || activities.length === 0) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  return NextResponse.json({
    featureKey: feature.featureKey,
    title: feature.title,
    summary: feature.summary,
    source: feature.source,
    person: { id: person.id, displayName: person.displayName },
    activities: activities.map((a) => ({
      id: a.id,
      source: a.source,
      type: a.type,
      title: a.title,
      url: a.url,
      occurredAt: a.occurredAt.toISOString(),
      metadata: safeJson(a.metadata),
    })),
  });
}

function safeJson(raw: string) {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
