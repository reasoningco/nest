import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import {
  parseEvent,
  verifyBearer,
  TERMINAL_EVENT_TYPES,
} from "@/lib/codex-telemetry";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Codex CLI telemetry ingest. Mirrors /api/claude-event — same shape, same
 * privacy contract, separate table so the two pipelines stay isolated.
 *
 * Bypasses the cookie middleware (see middleware.ts OPEN_PATHS).
 * Authenticated by bearer token from $CHAOS_TELEMETRY_TOKEN.
 */
export async function POST(req: NextRequest) {
  if (!verifyBearer(req.headers.get("authorization"))) {
    return NextResponse.json({ ok: false }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { ok: false, reason: "invalid json" },
      { status: 400 },
    );
  }

  const parsed = parseEvent(body);
  if (!parsed.ok) {
    // 200 (not 4xx) so the helper script doesn't retry; we just drop.
    return NextResponse.json({ ok: false, reason: parsed.reason });
  }
  const ev = parsed.value;
  const ts = ev.ts ? new Date(ev.ts) : new Date();
  const isTerminal = TERMINAL_EVENT_TYPES.has(ev.type);

  await prisma.$transaction(async (tx) => {
    const session = await tx.codexSession.upsert({
      where: { sessionUuid: ev.sessionUuid },
      create: {
        sessionUuid: ev.sessionUuid,
        user: ev.user,
        host: ev.host ?? null,
        cwd: ev.cwd ?? null,
        startedAt: ts,
        lastEventAt: ts,
      },
      update: {
        lastEventAt: ts,
        ...(ev.host ? { host: ev.host } : {}),
        ...(ev.cwd ? { cwd: ev.cwd } : {}),
      },
    });

    await tx.codexEvent.create({
      data: {
        sessionId: session.id,
        type: ev.type,
        tool: ev.tool ?? null,
        durationMs: ev.durationMs ?? null,
        ts,
      },
    });

    const counterUpdates: Record<string, { increment: number }> = {};
    if (ev.type === "PostToolUse")
      counterUpdates.toolUseCount = { increment: 1 };
    if (ev.type === "UserPromptSubmit")
      counterUpdates.promptCount = { increment: 1 };
    if (ev.type === "Error") counterUpdates.errorCount = { increment: 1 };

    const shouldSetFirstPrompt =
      ev.type === "UserPromptSubmit" &&
      !!ev.prompt &&
      session.firstPrompt == null;

    const sessionPatch: Record<string, unknown> = { ...counterUpdates };
    if (isTerminal && !session.endedAt) sessionPatch.endedAt = ts;
    if (shouldSetFirstPrompt) sessionPatch.firstPrompt = ev.prompt;

    if (Object.keys(sessionPatch).length > 0) {
      await tx.codexSession.update({
        where: { id: session.id },
        data: sessionPatch,
      });
    }
  });

  return NextResponse.json({ ok: true });
}
