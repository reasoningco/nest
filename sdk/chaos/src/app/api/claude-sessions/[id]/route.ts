import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { deriveStatus, type SessionStatus } from "@/lib/claude-telemetry";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/claude-sessions/{id}
 * Returns the session + its event timeline (newest first, capped).
 */
export async function GET(
  _req: NextRequest,
  ctx: { params: { id: string } },
) {
  const id = ctx.params.id;
  const session = await prisma.claudeSession.findUnique({
    where: { id },
    include: {
      events: {
        orderBy: { ts: "desc" },
        take: 500,
      },
    },
  });
  if (!session) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  const now = new Date();
  const status: SessionStatus = deriveStatus({
    endedAt: session.endedAt,
    lastEventAt: session.lastEventAt,
    now,
  });

  const durationMs =
    session.lastEventAt.getTime() - session.startedAt.getTime();

  return NextResponse.json({
    id: session.id,
    sessionUuid: session.sessionUuid,
    user: session.user,
    host: session.host,
    cwd: session.cwd,
    startedAt: session.startedAt.toISOString(),
    lastEventAt: session.lastEventAt.toISOString(),
    endedAt: session.endedAt?.toISOString() ?? null,
    toolUseCount: session.toolUseCount,
    promptCount: session.promptCount,
    errorCount: session.errorCount,
    firstPrompt: session.firstPrompt,
    durationMs,
    status,
    events: session.events.map((e) => ({
      id: e.id,
      type: e.type,
      tool: e.tool,
      durationMs: e.durationMs,
      ts: e.ts.toISOString(),
    })),
  });
}
