"use client";

import * as React from "react";
import {
  ArrowSquareOutIcon,
  CaretDownIcon,
  FolderIcon,
  GithubLogoIcon,
  PlusIcon,
  UsersThreeIcon,
  XIcon,
} from "@phosphor-icons/react";
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { ByProjectPanel } from "./projects-view";
import type { ActivityPayload, Person, Range, Rollup } from "./types";

const RANGE_OPTIONS: { key: Range; label: string }[] = [
  { key: "today", label: "Today" },
  { key: "24h", label: "24h" },
  { key: "7d", label: "7d" },
  { key: "30d", label: "30d" },
  { key: "all", label: "All" },
];

const STATUS_LABELS: Record<Rollup["status"], string> = {
  done: "Done",
  merged: "Merged",
  in_review: "In review",
  in_progress: "In progress",
  open: "Open",
};

const PAGE_DAYS = 30;
const DISPLAY_TZ = "America/Los_Angeles";
const ACTIVITY_REFRESH_POLL_MS = 60_000;

const WEEKS_FOR_RANGE: Record<Range, number | "all"> = {
  today: 4,
  "24h": 4,
  "7d": 6,
  "30d": 13,
  all: "all",
};

type Tab = "byproject" | "byperson";
const orgActivityRangeStorageKey = "agent-kanban-org-activity-range";
const orgActivityTabStorageKey = "agent-kanban-org-activity-tab";
const orgActivityPersonStorageKey = "agent-kanban-org-activity-person";

function readStoredRange(): Range {
  if (typeof window === "undefined") return "7d";
  const stored = window.localStorage.getItem(orgActivityRangeStorageKey);
  return isRange(stored) ? stored : "7d";
}

function readStoredTab(): Tab {
  if (typeof window === "undefined") return "byproject";
  const stored = window.localStorage.getItem(orgActivityTabStorageKey);
  return isTab(stored) ? stored : "byproject";
}

function readStoredPersonId(): string | null {
  if (typeof window === "undefined") return null;
  return window.localStorage.getItem(orgActivityPersonStorageKey);
}

function isRange(value: unknown): value is Range {
  return (
    typeof value === "string" &&
    RANGE_OPTIONS.some((option) => option.key === value)
  );
}

function isTab(value: unknown): value is Tab {
  return value === "byproject" || value === "byperson";
}

export function OrgActivityView() {
  const [range, setRange] = React.useState<Range>(readStoredRange);
  const [tab, setTab] = React.useState<Tab>(readStoredTab);
  const [data, setData] = React.useState<ActivityPayload | null>(null);
  const [err, setErr] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [featureId, setFeatureId] = React.useState<string | null>(null);

  React.useEffect(() => {
    window.localStorage.setItem(orgActivityRangeStorageKey, range);
  }, [range]);

  React.useEffect(() => {
    window.localStorage.setItem(orgActivityTabStorageKey, tab);
  }, [tab]);

  React.useEffect(() => {
    let live = true;
    let loadingTimer: number | null = null;
    let pollTimer: number | null = null;

    async function load(showLoading: boolean) {
      if (showLoading) {
        loadingTimer = window.setTimeout(() => {
          if (live) setLoading(true);
        }, 0);
      }

      try {
        const r = await fetch(`/api/chaos/activity?range=${range}`, {
          cache: "no-store",
        });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const d = (await r.json()) as ActivityPayload;
        if (!live) return;
        setData(d);
        setErr(null);
      } catch (e) {
        if (live) setErr(e instanceof Error ? e.message : String(e));
      } finally {
        if (loadingTimer) {
          window.clearTimeout(loadingTimer);
          loadingTimer = null;
        }
        if (live && showLoading) setLoading(false);
        if (live) {
          pollTimer = window.setTimeout(
            () => void load(false),
            ACTIVITY_REFRESH_POLL_MS,
          );
        }
      }
    }

    void load(true);
    return () => {
      live = false;
      if (loadingTimer) window.clearTimeout(loadingTimer);
      if (pollTimer) window.clearTimeout(pollTimer);
    };
  }, [range]);

  return (
    <div className="space-y-4 p-4">
      <header className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-lg font-semibold leading-tight">Org activity</h1>
          <p className="text-xs text-muted-foreground">
            What shipped — by project, by day, by person. Sourced from chaos.
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <TrackedReposMenu />
          <RangeTabs value={range} onChange={setRange} />
        </div>
      </header>

      <div className="flex items-center gap-1">
        <TabButton
          active={tab === "byproject"}
          onClick={() => setTab("byproject")}
          icon={FolderIcon}
          label="By project"
        />
        <TabButton
          active={tab === "byperson"}
          onClick={() => setTab("byperson")}
          icon={UsersThreeIcon}
          label="By person"
        />
      </div>

      {err && tab !== "byproject" ? (
        <Card className="border-destructive/50 bg-destructive/5 px-4 py-3 text-sm text-destructive">
          {err}
        </Card>
      ) : null}

      {!data && loading && tab !== "byproject" ? (
        <div className="py-10 text-center text-sm text-muted-foreground">
          Loading…
        </div>
      ) : null}

      {tab === "byproject" ? (
        <ByProjectPanel
          range={range}
          activity={data}
          activityErr={err}
          activityLoading={loading}
          showProjectBuckets={false}
          chartFooter={
            data ? (
              <ByDay
                data={data}
                onSelectFeature={setFeatureId}
                embedded
              />
            ) : null
          }
        />
      ) : null}
      {data && tab === "byperson" ? (
        <ByPerson data={data} onSelectFeature={setFeatureId} />
      ) : null}

      {featureId ? (
        <FeatureDrawer
          id={featureId}
          onClose={() => setFeatureId(null)}
        />
      ) : null}
    </div>
  );
}

function RangeTabs({
  value,
  onChange,
}: {
  value: Range;
  onChange: (r: Range) => void;
}) {
  return (
    <div className="inline-flex items-center gap-0.5 rounded-md border bg-background p-0.5">
      {RANGE_OPTIONS.map((opt) => {
        const active = value === opt.key;
        return (
          <Button
            key={opt.key}
            type="button"
            variant={active ? "default" : "ghost"}
            size="sm"
            className="h-7 px-2.5 text-xs"
            onClick={() => onChange(opt.key)}
          >
            {opt.label}
          </Button>
        );
      })}
    </div>
  );
}

function TabButton({
  active,
  onClick,
  icon: Icon,
  label,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ElementType;
  label: string;
}) {
  return (
    <Button
      type="button"
      variant={active ? "default" : "ghost"}
      size="sm"
      onClick={onClick}
      className="gap-1.5 text-xs"
    >
      <Icon aria-hidden="true" className="size-3.5" />
      {label}
    </Button>
  );
}

interface TrackedRepo {
  owner: string;
  name: string;
  url: string;
  jiraProjectKey: string | null;
}

function TrackedReposMenu() {
  const [open, setOpen] = React.useState(false);
  const [repos, setRepos] = React.useState<TrackedRepo[]>([]);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [url, setUrl] = React.useState("");
  const [jiraKey, setJiraKey] = React.useState("");
  const [submitting, setSubmitting] = React.useState(false);
  const menuRef = React.useRef<HTMLDivElement | null>(null);

  const loadRepos = React.useCallback(async () => {
    setLoading(true);
    try {
      const resp = await fetch("/api/chaos/repos", { cache: "no-store" });
      const json = (await resp.json()) as {
        repos?: TrackedRepo[];
        error?: string;
      };
      if (!resp.ok) throw new Error(json.error ?? `HTTP ${resp.status}`);
      setRepos(json.repos ?? []);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    const id = window.setTimeout(() => {
      void loadRepos();
    }, 0);
    return () => window.clearTimeout(id);
  }, [loadRepos]);

  React.useEffect(() => {
    if (!open) return;
    function onPointerDown(event: PointerEvent) {
      if (!menuRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    }
    window.addEventListener("pointerdown", onPointerDown);
    return () => window.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  const addRepo = async (event: React.FormEvent) => {
    event.preventDefault();
    const nextUrl = url.trim();
    if (!nextUrl || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const resp = await fetch("/api/chaos/repos", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          url: nextUrl,
          jiraProjectKey: jiraKey.trim() || null,
        }),
      });
      const json = (await resp.json().catch(() => null)) as
        | { repos?: TrackedRepo[]; error?: string }
        | null;
      if (!resp.ok) throw new Error(json?.error ?? `HTTP ${resp.status}`);
      setRepos(json?.repos ?? []);
      setUrl("");
      setJiraKey("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div ref={menuRef} className="relative">
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="h-8 gap-1.5 text-xs"
        onClick={() => setOpen((value) => !value)}
      >
        <GithubLogoIcon aria-hidden="true" className="size-3.5" />
        Repos
        <span className="tabular-nums text-muted-foreground">
          {repos.length}
        </span>
        <CaretDownIcon aria-hidden="true" className="size-3.5" />
      </Button>

      {open ? (
        <div className="absolute right-0 top-9 z-30 w-80 rounded-lg border bg-popover p-3 text-popover-foreground shadow-lg">
          <div className="mb-2 flex items-center justify-between gap-2">
            <div className="text-sm font-medium">Tracked repos</div>
            <Button
              type="button"
              variant="ghost"
              size="xs"
              onClick={() => void loadRepos()}
              disabled={loading}
            >
              {loading ? "loading" : "refresh"}
            </Button>
          </div>

          {error ? (
            <div className="mb-2 rounded-md border border-destructive/30 bg-destructive/10 px-2 py-1.5 text-xs text-destructive">
              {error}
            </div>
          ) : null}

          <div className="max-h-56 overflow-y-auto pr-1">
            {repos.length === 0 && !loading ? (
              <div className="py-3 text-center text-xs text-muted-foreground">
                No repos tracked.
              </div>
            ) : null}
            {repos.map((repo) => (
              <a
                key={`${repo.owner}/${repo.name}`}
                href={repo.url}
                target="_blank"
                rel="noreferrer"
                className="flex items-center justify-between gap-3 rounded-md px-2 py-1.5 text-xs hover:bg-muted/60"
              >
                <span className="min-w-0 truncate">
                  {repo.owner}/{repo.name}
                </span>
                {repo.jiraProjectKey ? (
                  <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
                    {repo.jiraProjectKey}
                  </span>
                ) : null}
              </a>
            ))}
          </div>

          <form onSubmit={addRepo} className="mt-3 border-t pt-3">
            <div className="mb-2 grid grid-cols-[1fr_4.5rem] gap-2">
              <Input
                value={url}
                onChange={(event) => setUrl(event.target.value)}
                placeholder="https://github.com/org/repo"
                className="h-8 font-mono text-xs"
              />
              <Input
                value={jiraKey}
                onChange={(event) =>
                  setJiraKey(event.target.value.toUpperCase())
                }
                placeholder="Jira"
                className="h-8 font-mono text-xs uppercase"
                maxLength={16}
              />
            </div>
            <Button
              type="submit"
              size="sm"
              className="h-8 w-full gap-1.5 text-xs"
              disabled={submitting || url.trim().length === 0}
            >
              <PlusIcon aria-hidden="true" className="size-3.5" />
              {submitting ? "Adding..." : "Add tracked repo"}
            </Button>
          </form>
        </div>
      ) : null}
    </div>
  );
}

// ───────────────────────── By day ─────────────────────────

interface DayBucket {
  displayName: string;
  features: Rollup[];
}

function ByDay({
  data,
  onSelectFeature,
  embedded = false,
}: {
  data: ActivityPayload;
  onSelectFeature: (id: string) => void;
  embedded?: boolean;
}) {
  const grouped = React.useMemo(() => {
    const peopleById = new Map(data.people.map((p) => [p.id, p]));
    const byDay = new Map<string, Map<string, DayBucket>>();
    for (const r of data.rollups) {
      const key = pacificDayKey(r.lastSeen);
      if (!byDay.has(key)) byDay.set(key, new Map());
      const perPerson = byDay.get(key)!;
      if (!perPerson.has(r.personId)) {
        const p = peopleById.get(r.personId);
        if (!p) continue;
        perPerson.set(r.personId, {
          displayName: p.displayName,
          features: [],
        });
      }
      perPerson.get(r.personId)!.features.push(r);
    }
    return [...byDay.entries()].sort((a, b) => (a[0] < b[0] ? 1 : -1));
  }, [data]);

  if (grouped.length === 0) {
    return (
      <div className="py-4 text-center text-sm text-muted-foreground">
        No activity in this window.
      </div>
    );
  }

  return (
    <div className={embedded ? "space-y-3" : "space-y-5"}>
      {embedded ? (
        <div>
          <div className="text-sm font-medium">Activity by day</div>
          <div className="text-xs text-muted-foreground">
            Recent work grouped by day and person.
          </div>
        </div>
      ) : null}
      {grouped.map(([day, perPerson]) => (
        <section key={day}>
          <div className="mb-2 px-1 text-xs uppercase tracking-wider text-muted-foreground">
            {formatPacificDayHeader(day)}
          </div>
          <div
            className={
              embedded
                ? "divide-y divide-border rounded-lg border bg-background/30"
                : "divide-y divide-border rounded-lg border bg-card"
            }
          >
            {[...perPerson.entries()].map(([personId, bucket]) => (
              <PersonDayBucket
                key={`${day}:${personId}`}
                bucket={bucket}
                onSelectFeature={onSelectFeature}
              />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

function PersonDayBucket({
  bucket,
  onSelectFeature,
}: {
  bucket: DayBucket;
  onSelectFeature: (id: string) => void;
}) {
  const [expanded, setExpanded] = React.useState(false);
  const hidden = Math.max(0, bucket.features.length - 3);
  const visible = expanded ? bucket.features : bucket.features.slice(0, 3);

  return (
    <div className="px-4 py-3">
      <div className="mb-1 text-sm">{bucket.displayName}</div>
      <div className="divide-y divide-border">
        {visible.map((f) => (
          <FeatureRow
            key={f.detailId}
            rollup={f}
            onClick={() => onSelectFeature(f.detailId)}
          />
        ))}
      </div>
      {hidden > 0 ? (
        <button
          type="button"
          onClick={() => setExpanded((e) => !e)}
          className="pt-1.5 text-xs font-medium text-muted-foreground hover:text-foreground"
        >
          {expanded ? "Show less" : `+${hidden} more`}
        </button>
      ) : null}
    </div>
  );
}

// ───────────────────────── By person ─────────────────────────

function ByPerson({
  data,
  onSelectFeature,
}: {
  data: ActivityPayload;
  onSelectFeature: (id: string) => void;
}) {
  const [selected, setSelected] = React.useState<string | null>(
    readStoredPersonId,
  );
  const [page, setPage] = React.useState(1);

  React.useEffect(() => {
    if (selected) {
      window.localStorage.setItem(orgActivityPersonStorageKey, selected);
    } else {
      window.localStorage.removeItem(orgActivityPersonStorageKey);
    }
  }, [selected]);

  const rollupsByPerson = React.useMemo(() => {
    const m = new Map<string, Rollup[]>();
    for (const r of data.rollups) {
      if (!m.has(r.personId)) m.set(r.personId, []);
      m.get(r.personId)!.push(r);
    }
    for (const arr of m.values()) {
      arr.sort((a, b) => (a.lastSeen < b.lastSeen ? 1 : -1));
    }
    return m;
  }, [data]);

  const leaderboard = React.useMemo(
    () => buildLeaderboard(data.people, rollupsByPerson),
    [data.people, rollupsByPerson],
  );
  const team = leaderboard.filter((row) => !row.person.external);
  const others = leaderboard.filter((row) => row.person.external);

  if (selected) {
    const p = data.people.find((x) => x.id === selected);
    if (!p) {
      setSelected(null);
      return null;
    }
    const all = rollupsByPerson.get(selected) ?? [];
    const latestSeen = all.reduce(
      (latest, r) => Math.max(latest, new Date(r.lastSeen).getTime()),
      0,
    );
    const cutoff = latestSeen - page * PAGE_DAYS * 86_400_000;
    const visible = all.filter(
      (r) => new Date(r.lastSeen).getTime() >= cutoff,
    );

    return (
      <div className="space-y-4">
        <button
          type="button"
          onClick={() => {
            setSelected(null);
            setPage(1);
          }}
          className="text-xs text-muted-foreground hover:text-foreground"
        >
          ← Back to people
        </button>
        <div className="flex items-center gap-3">
          <div className="flex size-10 select-none items-center justify-center rounded-full bg-muted text-foreground">
            {initials(p.displayName)}
          </div>
          <div className="text-base">{p.displayName}</div>
        </div>
        <PersonLocChart personId={p.id} range={data.range} />
        <Card className="divide-y divide-border px-4 py-0">
          {visible.length === 0 ? (
            <div className="py-6 text-sm text-muted-foreground">
              No activity.
            </div>
          ) : null}
          {visible.map((f) => (
            <FeatureRow
              key={(f.featureKey ?? "anon") + f.firstSeen}
              rollup={f}
              onClick={() => onSelectFeature(f.detailId)}
            />
          ))}
        </Card>
        {visible.length < all.length ? (
          <div className="flex justify-center">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setPage((n) => n + 1)}
            >
              Load another {PAGE_DAYS} days
            </Button>
          </div>
        ) : null}
      </div>
    );
  }

  const renderRow = (row: LeaderboardRow) => (
    <LeaderboardPersonRow
      key={row.person.id}
      row={row}
      onClick={() => {
        setSelected(row.person.id);
        setPage(1);
      }}
    />
  );

  return (
    <div className="space-y-6">
      <Card className="overflow-x-auto py-0">
        <div className="grid min-w-[46rem] grid-cols-[3rem_minmax(0,1fr)_5rem_5rem_5rem_5rem_4rem] gap-3 border-b px-4 py-2 text-xs text-muted-foreground">
          <div>Rank</div>
          <div>Person</div>
          <div className="text-right">Features</div>
          <div className="text-right">Added</div>
          <div className="text-right">Removed</div>
          <div className="text-right">Tickets</div>
          <div className="text-right">Score</div>
        </div>
        <div className="min-w-[46rem] divide-y divide-border">
          {team.map(renderRow)}
        </div>
      </Card>
      {others.length > 0 ? (
        <div className="space-y-3">
          <div className="text-xs uppercase tracking-wider text-muted-foreground">
            Other contributors
          </div>
          <Card className="min-w-[46rem] divide-y divide-border overflow-x-auto py-0">
            {others.map(renderRow)}
          </Card>
        </div>
      ) : null}
    </div>
  );
}

interface LeaderboardRow {
  person: Person;
  rank: number;
  features: number;
  linesAdded: number;
  linesRemoved: number;
  ticketsClosed: number;
  score: number;
}

function buildLeaderboard(
  people: Person[],
  rollupsByPerson: Map<string, Rollup[]>,
): LeaderboardRow[] {
  const featureCount = (person: Person) => {
    const rollups = rollupsByPerson.get(person.id) ?? [];
    const keyedFeatures = rollups.filter((r) => r.featureKey).length;
    return keyedFeatures + (person.significantAnonCommits ?? 0);
  };
  const maxFeatures = Math.max(0, ...people.map(featureCount));
  const maxAdded = Math.max(0, ...people.map((p) => p.linesAdded ?? 0));
  const maxRemoved = Math.max(0, ...people.map((p) => p.linesRemoved ?? 0));
  const maxTickets = Math.max(0, ...people.map((p) => p.ticketsClosed ?? 0));

  return people
    .map((person) => {
      const features = featureCount(person);
      const linesAdded = person.linesAdded ?? 0;
      const linesRemoved = person.linesRemoved ?? 0;
      const ticketsClosed = person.ticketsClosed ?? 0;
      const score =
        100 *
        (0.3 * normalized(features, maxFeatures) +
          0.4 * normalized(linesAdded, maxAdded) +
          0.15 * normalized(linesRemoved, maxRemoved) +
          0.15 * normalized(ticketsClosed, maxTickets));
      return {
        person,
        rank: 0,
        features,
        linesAdded,
        linesRemoved,
        ticketsClosed,
        score,
      };
    })
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      if (b.features !== a.features) return b.features - a.features;
      return b.linesAdded - a.linesAdded;
    })
    .map((row, index) => ({ ...row, rank: index + 1 }));
}

function normalized(value: number, max: number): number {
  if (max <= 0) return 0;
  return Math.log1p(value) / Math.log1p(max);
}

function LeaderboardPersonRow({
  row,
  onClick,
}: {
  row: LeaderboardRow;
  onClick: () => void;
}) {
  const isTop = row.rank === 1 && !row.person.external;
  const formula =
    "Score = 30% features + 40% lines added + 15% lines removed + 15% Jira tickets closed, log-normalized within this range.";
  return (
    <button
      type="button"
      onClick={onClick}
      title={formula}
      className={
        "grid min-w-[46rem] w-full grid-cols-[3rem_minmax(0,1fr)_5rem_5rem_5rem_5rem_4rem] items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-muted/60 " +
        (isTop ? "bg-[#d6a84f]/10" : "")
      }
    >
      <div>
        <span
          className={
            "inline-flex size-7 items-center justify-center rounded-full text-xs font-medium tabular-nums " +
            (isTop
              ? "bg-[#d6a84f] text-black"
              : "bg-muted text-muted-foreground")
          }
        >
          {row.rank}
        </span>
      </div>
      <div className="flex min-w-0 items-center gap-3">
        <div className="flex size-9 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-medium">
          {initials(row.person.displayName)}
        </div>
        <div className="min-w-0">
          <div className="truncate text-sm font-medium">
            {row.person.displayName}
          </div>
          {row.person.githubLogin ? (
            <div className="truncate text-xs text-muted-foreground">
              @{row.person.githubLogin}
            </div>
          ) : null}
        </div>
      </div>
      <div className="text-right text-xs tabular-nums">{row.features}</div>
      <div className="text-right text-xs tabular-nums">
        {formatLoc(row.linesAdded)}
      </div>
      <div className="text-right text-xs tabular-nums">
        {formatLoc(row.linesRemoved)}
      </div>
      <div className="text-right text-xs tabular-nums">
        {row.ticketsClosed}
      </div>
      <div className="text-right text-sm font-medium tabular-nums">
        {row.score.toFixed(1)}
      </div>
    </button>
  );
}

// ───────────────────────── FeatureRow ─────────────────────────

function FeatureRow({
  rollup,
  onClick,
}: {
  rollup: Rollup;
  onClick: () => void;
}) {
  const summary = rollupSummary(rollup);
  return (
    <button
      type="button"
      onClick={onClick}
      className="-mx-1 flex w-full items-center gap-3 rounded-lg px-1 py-2 text-left transition-colors hover:bg-muted/60"
    >
      <SourceIcon source={rollup.source} />
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate text-sm">{rollup.title}</span>
          {rollup.project ? (
            <Badge variant="secondary" className="text-[10px]">
              {rollup.project}
            </Badge>
          ) : null}
          {rollup.source !== "github" ? (
            <Badge variant="outline" className="text-[10px]">
              {STATUS_LABELS[rollup.status]}
            </Badge>
          ) : null}
        </div>
        {summary ? (
          <div className="mt-0.5 text-xs text-muted-foreground">{summary}</div>
        ) : null}
      </div>
    </button>
  );
}

function SourceIcon({ source }: { source: string }) {
  if (source === "jira") {
    return (
      <span
        className="inline-flex size-4 shrink-0 items-center justify-center rounded bg-[#0052cc] text-[10px] font-medium text-white"
        title="Jira"
      >
        J
      </span>
    );
  }
  return (
    <GithubLogoIcon
      aria-hidden="true"
      className="size-4 shrink-0 text-foreground"
    />
  );
}

function rollupSummary(r: Rollup): string {
  const parts: string[] = [];
  if (r.commitCount)
    parts.push(`${r.commitCount} commit${r.commitCount === 1 ? "" : "s"}`);
  if (r.mergedCount) parts.push(`${r.mergedCount} PR merged`);
  else if (r.prCount) parts.push(`${r.prCount} PR${r.prCount === 1 ? "" : "s"}`);
  if (r.issueDoneCount) parts.push(`${r.issueDoneCount} ticket closed`);
  return parts.join(" · ");
}

// ───────────────────────── Person LOC chart ─────────────────────────

interface WeekPoint {
  date: string;
  additions: number;
  deletions: number;
  removedFromMe: number;
}
interface PersonLocPayload {
  personId: string;
  totalAdditions: number;
  totalDeletions: number;
  totalRemovedFromMe: number;
  points: WeekPoint[];
}

const ADDED_COLOR = "#3b82f6";
const REMOVED_COLOR = "#ef4444";
const REMOVED_FROM_ME_COLOR = "#eab308";
const AXIS_TEXT_COLOR = "rgba(245,245,245,0.62)";
const GRID_COLOR = "rgba(245,245,245,0.08)";
const LOC_AXIS_STEP = 10_000;
const LOC_AXIS_MIN_MAX = 400_000;

function PersonLocChart({
  personId,
  range,
}: {
  personId: string;
  range: Range;
}) {
  const [data, setData] = React.useState<PersonLocPayload | null>(null);
  const [err, setErr] = React.useState<string | null>(null);

  React.useEffect(() => {
    let live = true;
    const resetTimer = window.setTimeout(() => {
      if (!live) return;
      setData(null);
      setErr(null);
    }, 0);
    fetch(`/api/chaos/person-loc?personId=${encodeURIComponent(personId)}`, {
      cache: "no-store",
    })
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return (await r.json()) as PersonLocPayload;
      })
      .then((d) => {
        if (live) setData(d);
      })
      .catch((e) => {
        if (live) setErr(e instanceof Error ? e.message : String(e));
      });
    return () => {
      live = false;
      window.clearTimeout(resetTimer);
    };
  }, [personId]);

  const visiblePoints = React.useMemo(() => {
    if (!data?.points) return [];
    const spec = WEEKS_FOR_RANGE[range];
    if (spec === "all" || spec === undefined) return data.points;
    return data.points.slice(-spec);
  }, [data, range]);
  const axisMax = React.useMemo(
    () => locAxisMax(visiblePoints),
    [visiblePoints],
  );
  const axisTicks = React.useMemo(() => locAxisTicks(axisMax), [axisMax]);

  if (err) {
    return (
      <Card className="px-4 py-3 text-xs text-muted-foreground">
        Couldn&apos;t load contribution history: {err}
      </Card>
    );
  }
  if (!data) {
    return (
      <Card className="px-4 py-8 text-center text-xs text-muted-foreground">
        Loading contribution history…
      </Card>
    );
  }

  const hasData =
    data.totalAdditions > 0 ||
    data.totalDeletions > 0 ||
    data.totalRemovedFromMe > 0;

  return (
    <Card className="p-4">
      <div className="mb-3 flex items-baseline justify-between">
        <div>
          <div className="text-sm font-medium">
            Lines added / removed / removed from me
          </div>
          <div className="text-xs text-muted-foreground">
            Last {visiblePoints.length} week
            {visiblePoints.length === 1 ? "" : "s"}
          </div>
        </div>
        <div className="flex flex-wrap justify-end gap-x-4 gap-y-1 text-xs tabular-nums">
          <div>
            <span className="text-muted-foreground">lines added </span>
            <span className="font-medium text-[#3b82f6]">
              {formatLoc(data.totalAdditions)}
            </span>
          </div>
          <div>
            <span className="text-muted-foreground">lines removed </span>
            <span className="font-medium text-[#ef4444]">
              {formatLoc(data.totalDeletions)}
            </span>
          </div>
          <div>
            <span className="text-muted-foreground">removed from me </span>
            <span className="font-medium text-[#eab308]">
              {formatLoc(data.totalRemovedFromMe)}
            </span>
          </div>
        </div>
      </div>

      {!hasData ? (
        <div className="py-8 text-center text-xs text-muted-foreground">
          No enriched commits yet for this contributor.
        </div>
      ) : (
        <div className="-ml-2 h-48">
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart
              data={visiblePoints}
              margin={{ top: 6, right: 6, left: 0, bottom: 0 }}
            >
              <defs>
                <linearGradient id="g-person-added" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={ADDED_COLOR} stopOpacity={0.28} />
                  <stop offset="100%" stopColor={ADDED_COLOR} stopOpacity={0} />
                </linearGradient>
                <linearGradient
                  id="g-person-removed"
                  x1="0"
                  y1="0"
                  x2="0"
                  y2="1"
                >
                  <stop offset="0%" stopColor={REMOVED_COLOR} stopOpacity={0.24} />
                  <stop offset="100%" stopColor={REMOVED_COLOR} stopOpacity={0} />
                </linearGradient>
                <linearGradient
                  id="g-person-removed-from-me"
                  x1="0"
                  y1="0"
                  x2="0"
                  y2="1"
                >
                  <stop
                    offset="0%"
                    stopColor={REMOVED_FROM_ME_COLOR}
                    stopOpacity={0.24}
                  />
                  <stop
                    offset="100%"
                    stopColor={REMOVED_FROM_ME_COLOR}
                    stopOpacity={0}
                  />
                </linearGradient>
              </defs>
              <CartesianGrid stroke={GRID_COLOR} vertical={false} />
              <XAxis
                dataKey="date"
                tickFormatter={formatDate}
                stroke={AXIS_TEXT_COLOR}
                tick={{ fill: AXIS_TEXT_COLOR, fontSize: 10 }}
                axisLine={false}
                tickLine={false}
              />
              <YAxis
                yAxisId="loc"
                orientation="right"
                domain={[0, axisMax]}
                ticks={axisTicks}
                tickFormatter={formatLoc}
                stroke={AXIS_TEXT_COLOR}
                tick={{ fill: AXIS_TEXT_COLOR, fontSize: 10 }}
                axisLine={false}
                tickLine={false}
                width={48}
              />
              <Tooltip content={<PersonTooltip />} />
              <Area
                yAxisId="loc"
                type="monotone"
                dataKey="removedFromMe"
                name="Removed from me"
                stroke={REMOVED_FROM_ME_COLOR}
                strokeWidth={2}
                dot={false}
                activeDot={{ r: 4 }}
                fill="url(#g-person-removed-from-me)"
                isAnimationActive
                animationDuration={600}
              />
              <Area
                yAxisId="loc"
                type="monotone"
                dataKey="deletions"
                name="Lines removed"
                stroke={REMOVED_COLOR}
                strokeWidth={2}
                dot={false}
                activeDot={{ r: 4 }}
                fill="url(#g-person-removed)"
                isAnimationActive
                animationDuration={600}
              />
              <Area
                yAxisId="loc"
                type="monotone"
                dataKey="additions"
                name="Lines added"
                stroke={ADDED_COLOR}
                strokeWidth={2}
                dot={false}
                activeDot={{ r: 4 }}
                fill="url(#g-person-added)"
                isAnimationActive
                animationDuration={600}
              />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      )}
    </Card>
  );
}

function PersonTooltip({
  active,
  payload,
  label,
}: {
  active?: boolean;
  payload?: { value?: number; payload?: WeekPoint }[];
  label?: string;
}) {
  if (!active || !payload || payload.length === 0 || !label) return null;
  const pt = payload[0]?.payload;
  const added = pt?.additions ?? payload[0]?.value ?? 0;
  const removed = pt?.deletions ?? 0;
  const removedFromMe = pt?.removedFromMe ?? 0;
  if (added === 0 && removed === 0 && removedFromMe === 0) return null;
  return (
    <div className="rounded-md border bg-popover px-3 py-2 text-xs text-popover-foreground shadow-sm">
      <div className="mb-1 font-medium">{formatDate(label)}</div>
      <div className="flex items-center gap-2">
        <span
          className="size-1.5 rounded-full"
          style={{ background: ADDED_COLOR }}
        />
        <span>lines added</span>
        <span className="ml-auto tabular-nums text-muted-foreground">
          {formatLoc(added)}
        </span>
      </div>
      <div className="mt-0.5 flex items-center gap-2">
        <span
          className="size-1.5 rounded-full"
          style={{ background: REMOVED_COLOR }}
        />
        <span>lines removed</span>
        <span className="ml-auto tabular-nums text-muted-foreground">
          {formatLoc(removed)}
        </span>
      </div>
      <div className="mt-0.5 flex items-center gap-2">
        <span
          className="size-1.5 rounded-full"
          style={{ background: REMOVED_FROM_ME_COLOR }}
        />
        <span>removed from me</span>
        <span className="ml-auto tabular-nums text-muted-foreground">
          {formatLoc(removedFromMe)}
        </span>
      </div>
    </div>
  );
}

function locAxisMax(points: WeekPoint[]): number {
  const maxValue = points.reduce(
    (max, point) =>
      Math.max(
        max,
        point.additions ?? 0,
        point.deletions ?? 0,
        point.removedFromMe ?? 0,
      ),
    0,
  );
  return Math.max(
    LOC_AXIS_MIN_MAX,
    Math.ceil(maxValue / LOC_AXIS_STEP) * LOC_AXIS_STEP,
  );
}

function locAxisTicks(axisMax: number): number[] {
  const ticks: number[] = [];
  for (let tick = 0; tick < axisMax; tick += LOC_AXIS_STEP) {
    ticks.push(tick);
  }
  ticks.push(axisMax);
  return ticks;
}

// ───────────────────────── Feature drawer ─────────────────────────

interface FeatureActivityRow {
  id: string;
  source: string;
  type: string;
  title: string;
  url: string | null;
  occurredAt: string;
  metadata: Record<string, unknown> | null;
}
interface FeaturePayload {
  featureKey: string | null;
  title: string;
  summary?: string | null;
  source: string;
  person: { id: string; displayName: string } | null;
  activities: FeatureActivityRow[];
}

const TYPE_LABEL: Record<string, string> = {
  commit: "Commit",
  pr_opened: "PR opened",
  pr_merged: "PR merged",
  pr_reviewed: "PR reviewed",
  issue_created: "Issue created",
  issue_in_progress: "Moved to in progress",
  issue_done: "Marked done",
};

function FeatureDrawer({
  id,
  onClose,
}: {
  id: string;
  onClose: () => void;
}) {
  const [data, setData] = React.useState<FeaturePayload | null>(null);
  const [err, setErr] = React.useState<string | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    fetch(`/api/chaos/feature?id=${encodeURIComponent(id)}`, {
      cache: "no-store",
    })
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return (await r.json()) as FeaturePayload;
      })
      .then((d) => {
        if (!cancelled) setData(d);
      })
      .catch((e) => {
        if (!cancelled) setErr(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [id]);

  return (
    <div
      className="fixed inset-0 z-40 flex items-stretch justify-end bg-foreground/30"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <aside className="flex w-full max-w-2xl flex-col border-l bg-background">
        <header className="sticky top-0 z-10 flex items-start justify-between gap-3 border-b bg-background px-5 py-3">
          <div className="min-w-0">
            {data ? (
              <>
                <div className="text-xs uppercase tracking-wider text-muted-foreground">
                  {data.source === "jira"
                    ? data.featureKey
                    : data.featureKey?.startsWith("pr:")
                      ? "Pull request"
                      : data.featureKey?.startsWith("branch:")
                        ? "Branch"
                        : "Activity"}
                </div>
                <h2 className="mt-1 truncate text-base font-medium">
                  {data.title}
                </h2>
                {data.person ? (
                  <div className="mt-0.5 truncate text-xs text-muted-foreground">
                    {data.person.displayName}
                  </div>
                ) : null}
              </>
            ) : (
              <div className="text-sm text-muted-foreground">Loading…</div>
            )}
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
          <div className="p-5">
            {err ? (
              <Card className="border-destructive/50 bg-destructive/5 px-3 py-2 text-sm text-destructive">
                {err}
              </Card>
            ) : null}
            {data ? (
              <Card className="divide-y divide-border py-0">
                {data.activities.map((a) => (
                  <FeatureActivityRow key={a.id} row={a} />
                ))}
                {data.activities.length === 0 ? (
                  <div className="px-4 py-3 text-sm text-muted-foreground">
                    No activity recorded.
                  </div>
                ) : null}
              </Card>
            ) : null}
          </div>
        </ScrollArea>
      </aside>
    </div>
  );
}

function FeatureActivityRow({ row }: { row: FeatureActivityRow }) {
  const meta = row.metadata ?? {};
  const extra: string[] = [];
  if (row.source === "github" && typeof meta.repo === "string") {
    const owner = String(meta.owner ?? "");
    extra.push(`${owner}/${meta.repo}`);
    if (typeof meta.branch === "string" && meta.branch) extra.push(meta.branch);
    if (typeof meta.sha === "string") extra.push(meta.sha.slice(0, 7));
    if (typeof meta.prNumber === "number") extra.push(`#${meta.prNumber}`);
    if (Array.isArray(meta.labels) && meta.labels.length > 0) {
      extra.push((meta.labels as string[]).slice(0, 3).join(", "));
    }
  } else if (row.source === "jira") {
    if (typeof meta.status === "string" && meta.status) extra.push(meta.status);
    if (Array.isArray(meta.labels) && meta.labels.length > 0) {
      extra.push((meta.labels as string[]).slice(0, 3).join(", "));
    }
  }

  return (
    <div className="flex items-start gap-4 px-4 py-3">
      <div className="w-28 shrink-0 pt-0.5 text-xs text-muted-foreground">
        {formatPacific(row.occurredAt)}
      </div>
      <div className="min-w-0 flex-1">
        <div className="mb-0.5 flex items-center gap-2 text-xs text-muted-foreground">
          <span className="font-medium text-foreground">
            {TYPE_LABEL[row.type] ?? row.type}
          </span>
          {extra.length > 0 ? <span>· {extra.join(" · ")}</span> : null}
        </div>
        {row.url ? (
          <a
            href={row.url}
            target="_blank"
            rel="noreferrer"
            className="block truncate text-sm hover:underline"
          >
            {row.title}
            <ArrowSquareOutIcon
              aria-hidden="true"
              className="ml-1 inline size-3 -translate-y-px text-muted-foreground/60"
            />
          </a>
        ) : (
          <div className="truncate text-sm">{row.title}</div>
        )}
      </div>
    </div>
  );
}

// ───────────────────────── helpers ─────────────────────────

function pacificDayKey(iso: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: DISPLAY_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(iso));
}

function formatPacificDayHeader(key: string): string {
  const today = pacificDayKey(new Date().toISOString());
  if (key === today) return "Today";
  const yesterdayIso = new Date(Date.now() - 86_400_000).toISOString();
  if (key === pacificDayKey(yesterdayIso)) return "Yesterday";
  const [y, m, d] = key.split("-").map(Number);
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: DISPLAY_TZ,
    weekday: "long",
    month: "short",
    day: "numeric",
  }).formatToParts(new Date(Date.UTC(y!, (m ?? 1) - 1, d, 12)));
  return parts.map((p) => p.value).join("");
}

function formatPacific(iso: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: DISPLAY_TZ,
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(iso));
}

function formatLoc(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(0) + "K";
  return String(n);
}

function formatDate(iso: string): string {
  return new Date(iso + "T12:00:00").toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });
}

function initials(name: string): string {
  return name
    .split(/\s+/)
    .map((w) => w[0])
    .filter(Boolean)
    .slice(0, 2)
    .join("")
    .toUpperCase();
}
