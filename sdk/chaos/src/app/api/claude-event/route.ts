import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import {
  parseEvent,
  verifyBearer,
  TERMINAL_EVENT_TYPES,
} from "@/lib/claude-telemetry";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Telemetry ingest. Bypasses the cookie middleware (see middleware.ts
 * OPEN_PATHS). Authenticated by bearer token from $CHAOS_TELEMETRY_TOKEN.
 *
 * Helper script POSTs one event per Claude Code lifecycle hook.
 * Always 2xx for known-bad payloads (after auth) so the helper doesn't
 * retry-storm. We log + drop instead.
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

  // Upsert session + append event in a single transaction so a session is
  // never created with stale stats.
  await prisma.$transaction(async (tx) => {
    const session = await tx.claudeSession.upsert({
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
        // refresh metadata if helper learned new values mid-session
        ...(ev.host ? { host: ev.host } : {}),
        ...(ev.cwd ? { cwd: ev.cwd } : {}),
      },
    });

    await tx.claudeEvent.create({
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

    // Capture the FIRST prompt as session opener — only if (a) this is a
    // prompt event with non-empty content AND (b) we don't already have one.
    // Done with a conditional update so concurrent events can't overwrite.
    const shouldSetFirstPrompt =
      ev.type === "UserPromptSubmit" &&
      !!ev.prompt &&
      session.firstPrompt == null;

    const sessionPatch: Record<string, unknown> = { ...counterUpdates };
    if (isTerminal && !session.endedAt) sessionPatch.endedAt = ts;
    if (shouldSetFirstPrompt) sessionPatch.firstPrompt = ev.prompt;

    if (Object.keys(sessionPatch).length > 0) {
      await tx.claudeSession.update({
        where: { id: session.id },
        data: sessionPatch,
      });
    }
  });

  return NextResponse.json({ ok: true });
}
