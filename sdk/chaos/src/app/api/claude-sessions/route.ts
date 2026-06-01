import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import {
  deriveStatus,
  STALE_THRESHOLD_MS,
  type SessionStatus,
} from "@/lib/claude-telemetry";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Read-side for the /claude kanban page.
 *
 *   GET /api/claude-sessions?since=24h
 *
 * Query params:
 *   - since: optional ISO date or shorthand (24h, 7d). Default 24h.
 */
export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const sinceMs = parseSince(url.searchParams.get("since"));
  const since = new Date(Date.now() - sinceMs);

  const sessions = await prisma.claudeSession.findMany({
    where: { lastEventAt: { gte: since } },
    orderBy: { lastEventAt: "desc" },
    select: {
      id: true,
      sessionUuid: true,
      user: true,
      host: true,
      cwd: true,
      startedAt: true,
      lastEventAt: true,
      endedAt: true,
      toolUseCount: true,
      promptCount: true,
      errorCount: true,
      firstPrompt: true,
    },
    take: 200,
  });

  const now = new Date();
  const items = sessions.map((s) => {
    const status: SessionStatus = deriveStatus({
      endedAt: s.endedAt,
      lastEventAt: s.lastEventAt,
      now,
    });
    const durationMs = s.lastEventAt.getTime() - s.startedAt.getTime();
    return {
      id: s.id,
      sessionUuid: s.sessionUuid,
      user: s.user,
      host: s.host,
      cwd: s.cwd,
      startedAt: s.startedAt.toISOString(),
      lastEventAt: s.lastEventAt.toISOString(),
      endedAt: s.endedAt?.toISOString() ?? null,
      toolUseCount: s.toolUseCount,
      promptCount: s.promptCount,
      errorCount: s.errorCount,
      firstPrompt: s.firstPrompt,
      durationMs,
      status,
    };
  });

  return NextResponse.json({
    sessions: items,
    serverTime: now.toISOString(),
    staleAfterMs: STALE_THRESHOLD_MS,
  });
}

function parseSince(input: string | null): number {
  if (!input) return 24 * 60 * 60 * 1000;
  const m = input.match(/^(\d+)([hd])$/);
  if (m) {
    const n = Number(m[1]!);
    return m[2] === "h" ? n * 60 * 60 * 1000 : n * 24 * 60 * 60 * 1000;
  }
  const t = Date.parse(input);
  if (!Number.isNaN(t)) return Math.max(0, Date.now() - t);
  return 24 * 60 * 60 * 1000;
}
