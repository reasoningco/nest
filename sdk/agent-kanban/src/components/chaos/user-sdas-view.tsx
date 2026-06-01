"use client";

import * as React from "react";
import { ClockIcon, XIcon } from "@phosphor-icons/react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import type {
  EventRow,
  SessionDetail,
  SessionRow,
  SessionStatus,
  SessionsResponse,
} from "./types";

const POLL_MS = 4 * 60 * 60 * 1000;
const POLL_LABEL = "4h";

const SOURCES: {
  tool: "claude" | "codex";
  label: string;
  apiBase: string;
}[] = [
  { tool: "claude", label: "Claude", apiBase: "/api/chaos/claude-sessions" },
  { tool: "codex", label: "Codex", apiBase: "/api/chaos/codex-sessions" },
];

const COLUMNS: {
  key: SessionStatus;
  label: string;
  hint: string;
  dot: string;
}[] = [
  { key: "active", label: "Active", hint: "≤ 60s", dot: "bg-emerald-500" },
  { key: "idle", label: "Idle", hint: "1–5 min", dot: "bg-amber-400" },
  { key: "stale", label: "Stale", hint: "5–30 min", dot: "bg-muted-foreground/40" },
  { key: "ended", label: "Ended", hint: "stopped", dot: "bg-muted-foreground" },
];

export function UserSdasView() {
  const [sessions, setSessions] = React.useState<SessionRow[]>([]);
  const [hasLoaded, setHasLoaded] = React.useState(false);
  const [loading, setLoading] = React.useState(true);
  const [err, setErr] = React.useState<string | null>(null);
  const [selected, setSelected] = React.useState<SessionRow | null>(null);

  const load = React.useCallback(async () => {
    try {
      const results = await Promise.all(
        SOURCES.map(async (src) => {
          const resp = await fetch(`${src.apiBase}?since=24h`, {
            cache: "no-store",
          });
          if (!resp.ok) throw new Error(`${src.label} HTTP ${resp.status}`);
          const j = (await resp.json()) as SessionsResponse;
          return j.sessions.map(
            (s) => ({ ...s, toolKind: src.tool }) as SessionRow,
          );
        }),
      );
      const merged = results
        .flat()
        .sort(
          (a, b) =>
            new Date(b.lastEventAt).getTime() -
            new Date(a.lastEventAt).getTime(),
        );
      setSessions(merged);
      setErr(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
      setHasLoaded(true);
    }
  }, []);

  React.useEffect(() => {
    const initialLoad = window.setTimeout(() => void load(), 0);
    const t = window.setInterval(load, POLL_MS);
    return () => {
      window.clearTimeout(initialLoad);
      window.clearInterval(t);
    };
  }, [load]);

  const grouped: Record<SessionStatus, SessionRow[]> = {
    active: [],
    idle: [],
    stale: [],
    ended: [],
  };
  for (const s of sessions) grouped[s.status].push(s);

  const isEmpty = sessions.length === 0 && !loading && hasLoaded;

  return (
    <div className="space-y-4 p-4">
      <header className="flex items-center justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-lg font-semibold leading-tight">Human SDMs</h1>
          <p className="text-xs text-muted-foreground">
            {sessions.length === 0
              ? "Live activity across team laptops · last 24h"
              : `${sessions.length} session${sessions.length === 1 ? "" : "s"} · last 24h · refresh ${POLL_LABEL}`}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-3">
          {loading && sessions.length === 0 ? (
            <span className="text-xs text-muted-foreground">loading…</span>
          ) : null}
          {err ? (
            <span className="text-xs text-destructive">{err}</span>
          ) : null}
        </div>
      </header>

      {sessions.length > 0 ? (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {COLUMNS.map((c) => (
            <Column
              key={c.key}
              label={c.label}
              hint={c.hint}
              dotClass={c.dot}
              sessions={grouped[c.key]}
              onSelect={setSelected}
            />
          ))}
        </div>
      ) : isEmpty ? (
        <EmptyHero />
      ) : null}

      {selected ? (
        <SessionDrawer
          summary={selected}
          apiBase={
            SOURCES.find((s) => s.tool === selected.toolKind)?.apiBase ??
            "/api/chaos/claude-sessions"
          }
          onClose={() => setSelected(null)}
        />
      ) : null}
    </div>
  );
}

function Column({
  label,
  hint,
  dotClass,
  sessions,
  onSelect,
}: {
  label: string;
  hint: string;
  dotClass: string;
  sessions: SessionRow[];
  onSelect: (s: SessionRow) => void;
}) {
  return (
    <Card className="flex flex-col gap-2 p-3">
      <header className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className={cn("inline-block size-1.5 rounded-full", dotClass)} />
          <h2 className="text-sm font-medium">{label}</h2>
          <span className="text-[11px] text-muted-foreground">{hint}</span>
        </div>
        <span className="text-xs font-medium text-muted-foreground">
          {sessions.length}
        </span>
      </header>
      <div className="flex flex-col gap-2">
        {sessions.length === 0 ? (
          <p className="py-1 text-[11px] italic text-muted-foreground/70">
            none
          </p>
        ) : null}
        {sessions.map((s) => (
          <SessionCard key={s.id} session={s} onClick={() => onSelect(s)} />
        ))}
      </div>
    </Card>
  );
}

function SessionCard({
  session,
  onClick,
}: {
  session: SessionRow;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className="rounded-lg border bg-background p-2.5 text-left transition-colors hover:bg-muted/60"
    >
      <div className="flex min-w-0 items-baseline justify-between gap-2">
        <span className="flex min-w-0 items-center gap-1.5 truncate text-sm font-medium">
          <Badge
            variant={session.toolKind === "claude" ? "secondary" : "outline"}
            className="px-1 text-[9px] font-medium uppercase tracking-wider"
          >
            {session.toolKind === "claude" ? "cl" : "cx"}
          </Badge>
          <span className="truncate">{displayUser(session.user)}</span>
        </span>
        <span className="shrink-0 text-[10px] text-muted-foreground">
          {formatRelative(session.lastEventAt)}
        </span>
      </div>
      {session.firstPrompt ? (
        <div className="mt-1 line-clamp-2 text-xs leading-snug">
          {session.firstPrompt}
        </div>
      ) : null}
      {session.cwd ? (
        <div className="mt-1 truncate font-mono text-[11px] text-muted-foreground">
          {trimHomePrefix(session.cwd)}
        </div>
      ) : null}
      <div className="mt-1.5 flex flex-wrap items-center gap-1 text-[10px]">
        <Pill label="dur" value={formatDuration(session.durationMs)} />
        {session.toolUseCount > 0 ? (
          <Pill label="tools" value={String(session.toolUseCount)} />
        ) : null}
        {session.promptCount > 0 ? (
          <Pill label="prompts" value={String(session.promptCount)} />
        ) : null}
        {session.errorCount > 0 ? (
          <Pill label="err" value={String(session.errorCount)} tone="warn" />
        ) : null}
      </div>
    </button>
  );
}

function Pill({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: "warn";
}) {
  return (
    <span
      className={cn(
        "rounded px-1.5 py-0.5",
        tone === "warn"
          ? "bg-destructive/10 text-destructive"
          : "bg-muted text-foreground",
      )}
    >
      <span className="mr-1 text-muted-foreground">{label}</span>
      {value}
    </span>
  );
}

function EmptyHero() {
  return (
    <Card className="p-10 text-center">
      <div className="inline-flex items-center gap-2 text-xs text-muted-foreground">
        <span className="inline-block size-2 animate-pulse rounded-full bg-muted-foreground/50" />
        Waiting for the first session
      </div>
      <p className="mx-auto mt-3 max-w-md text-sm text-muted-foreground">
        Run the chaos telemetry installer on any laptop, then invoke{" "}
        <code className="rounded bg-muted px-1 font-mono">claude</code> or{" "}
        <code className="rounded bg-muted px-1 font-mono">codex</code> in a
        project — a card will appear here within a few seconds of the first
        tool use.
      </p>
    </Card>
  );
}

function SessionDrawer({
  summary,
  apiBase,
  onClose,
}: {
  summary: SessionRow;
  apiBase: string;
  onClose: () => void;
}) {
  const [detail, setDetail] = React.useState<SessionDetail | null>(null);
  const [err, setErr] = React.useState<string | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    fetch(`${apiBase}/${summary.id}`, { cache: "no-store" })
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return (await r.json()) as SessionDetail;
      })
      .then((d) => {
        if (!cancelled) setDetail(d);
      })
      .catch((e) => {
        if (!cancelled) setErr(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [apiBase, summary.id]);

  const view: SessionRow = detail ?? summary;

  return (
    <div
      className="fixed inset-0 z-40 flex items-stretch justify-end bg-foreground/30"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <aside className="flex w-full max-w-xl flex-col border-l bg-background">
        <header className="sticky top-0 z-10 flex items-start justify-between gap-3 border-b bg-background px-5 py-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <StatusDot status={view.status} />
              <div className="truncate text-sm font-medium">
                {displayUser(view.user)}
              </div>
            </div>
            <div className="mt-0.5 truncate font-mono text-xs text-muted-foreground">
              {view.cwd ?? "(no cwd)"}
            </div>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            onClick={onClose}
            aria-label="Close"
          >
            <XIcon />
          </Button>
        </header>
        <ScrollArea className="min-h-0 flex-1">
          <div className="space-y-5 p-5">
            {view.firstPrompt ? (
              <Card className="p-4">
                <div className="mb-1.5 text-[10px] uppercase tracking-wider text-muted-foreground">
                  First prompt
                </div>
                <p className="whitespace-pre-wrap text-sm leading-snug">
                  {view.firstPrompt}
                </p>
              </Card>
            ) : null}
            <Stats summary={view} detail={detail} />
            <section>
              <h3 className="mb-2 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                Events
              </h3>
              {err ? (
                <p className="text-xs text-destructive">{err}</p>
              ) : null}
              {!detail && !err ? (
                <p className="text-xs text-muted-foreground">loading…</p>
              ) : null}
              {detail ? <EventTimeline events={detail.events} /> : null}
            </section>
          </div>
        </ScrollArea>
      </aside>
    </div>
  );
}

function StatusDot({ status }: { status: SessionStatus }) {
  const klass =
    status === "active"
      ? "bg-emerald-500"
      : status === "idle"
        ? "bg-amber-400"
        : status === "stale"
          ? "bg-muted-foreground/40"
          : "bg-muted-foreground";
  return (
    <span
      className={cn("inline-block size-2 rounded-full", klass)}
      title={status}
    />
  );
}

function Stats({
  summary,
  detail,
}: {
  summary: SessionRow;
  detail: SessionDetail | null;
}) {
  const toolFreq = detail
    ? countBy(
        detail.events.filter((e) => e.type === "PostToolUse"),
        (e) => e.tool ?? "unknown",
      )
    : null;

  return (
    <section className="grid grid-cols-2 gap-3 text-xs">
      <Field label="Status" value={summary.status} />
      <Field label="Host" value={summary.host ?? "—"} />
      <Field
        label="Started"
        value={new Date(summary.startedAt).toLocaleString()}
      />
      <Field
        label="Last event"
        value={new Date(summary.lastEventAt).toLocaleString()}
      />
      <Field label="Duration" value={formatDuration(summary.durationMs)} />
      <Field
        label="Tools / Prompts / Errors"
        value={`${summary.toolUseCount} / ${summary.promptCount} / ${summary.errorCount}`}
      />
      {toolFreq && Object.keys(toolFreq).length > 0 ? (
        <div className="col-span-2">
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
            Tool usage
          </div>
          <div className="mt-1 flex flex-wrap gap-1.5">
            {Object.entries(toolFreq)
              .sort((a, b) => b[1] - a[1])
              .map(([tool, n]) => (
                <span
                  key={tool}
                  className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px]"
                >
                  {tool}{" "}
                  <span className="text-muted-foreground">×{n}</span>
                </span>
              ))}
          </div>
        </div>
      ) : null}
    </section>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
        {label}
      </div>
      <div className="mt-0.5 truncate">{value}</div>
    </div>
  );
}

function EventTimeline({ events }: { events: EventRow[] }) {
  if (events.length === 0)
    return <p className="text-xs text-muted-foreground">no events</p>;
  return (
    <ol className="flex flex-col gap-1 font-mono text-xs">
      {events.map((e) => (
        <li
          key={e.id}
          className="flex items-baseline gap-2 border-l-2 border-border pl-2"
        >
          <span className="shrink-0 text-muted-foreground">
            <ClockIcon
              aria-hidden="true"
              className="-mb-0.5 mr-1 inline-block size-3"
            />
            {new Date(e.ts).toLocaleTimeString()}
          </span>
          <span className="font-medium">{e.type}</span>
          {e.tool ? <span>· {e.tool}</span> : null}
          {e.durationMs != null ? (
            <span className="text-muted-foreground">
              · {formatDuration(e.durationMs)}
            </span>
          ) : null}
        </li>
      ))}
    </ol>
  );
}

function countBy<T>(items: T[], key: (t: T) => string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const it of items) {
    const k = key(it);
    out[k] = (out[k] ?? 0) + 1;
  }
  return out;
}

function formatRelative(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 5_000) return "just now";
  if (ms < 60_000) return `${Math.round(ms / 1000)}s ago`;
  if (ms < 60 * 60_000) return `${Math.round(ms / 60_000)}m ago`;
  if (ms < 24 * 60 * 60_000) return `${Math.round(ms / 60 / 60_000)}h ago`;
  return new Date(iso).toLocaleDateString();
}

function formatDuration(ms: number): string {
  if (ms < 1_000) return `${ms}ms`;
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 60 * 60_000) {
    const m = Math.floor(ms / 60_000);
    const s = Math.floor((ms % 60_000) / 1000);
    return `${m}m ${s}s`;
  }
  const h = Math.floor(ms / (60 * 60_000));
  const m = Math.floor((ms % (60 * 60_000)) / 60_000);
  return `${h}h ${m}m`;
}

function trimHomePrefix(p: string): string {
  return p.replace(/^\/(home|Users)\/[^/]+/, "~");
}

function displayUser(u: string): string {
  const noreply = u.match(/^\d+\+([\w.-]+)@users\.noreply\.github\.com$/i);
  if (noreply) return noreply[1]!;
  const at = u.indexOf("@");
  if (at > 0) return u.slice(0, at);
  return u;
}
