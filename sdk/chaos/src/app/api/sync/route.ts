import { NextResponse } from "next/server";
import { runSync } from "@/lib/ingest";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// POST /api/sync — manual trigger. Intentionally unauthenticated; this service
// is expected to bind to an internal network only (see README).
export async function POST() {
  const result = await runSync();
  return NextResponse.json(result, { status: result.ok ? 200 : 500 });
}

export async function GET() {
  return NextResponse.json({
    hint: "POST this endpoint to trigger a manual sync.",
  });
}
