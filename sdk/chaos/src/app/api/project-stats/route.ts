import { NextResponse } from "next/server";
import { getProjectLoc } from "@/lib/project-loc";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// GET /api/project-stats — cached daily; force=1 refreshes the cache now.
export async function GET(req: Request) {
  const url = new URL(req.url);
  const force = url.searchParams.get("force") === "1";
  try {
    const payload = await getProjectLoc(force);
    return NextResponse.json(payload);
  } catch (err) {
    return NextResponse.json(
      { error: String(err).slice(0, 200), projects: [], weeks: [] },
      { status: 500 },
    );
  }
}
