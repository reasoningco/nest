"use client";

import * as React from "react";
import {
  ArrowClockwiseIcon,
  ArrowSquareOutIcon,
  GithubLogoIcon,
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
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";
import type {
  ActivityPayload,
  ProjectLocPayload,
  Range,
  Rollup,
  WeeklyLocThroughputPoint,
} from "./types";

const CHAOS_PUBLIC_URL = "https://chaos.reasoning.company";

const RANGE_OPTIONS: { key: Range; label: string }[] = [
  { key: "today", label: "Today" },
  { key: "24h", label: "24h" },
  { key: "7d", label: "7d" },
  { key: "30d", label: "30d" },
  { key: "all", label: "All" },
];

// LOC is coarse-grained (weekly), so Today/24h would otherwise be a single
// data point — widen the visible window but bias toward recent.
const WEEKS_FOR_RANGE: Record<Range, number | "all"> = {
  today: 4,
  "24h": 4,
  "7d": 6,
  "30d": 13,
  all: "all",
};

const LOC_REFRESH_STALE_MS = 15 * 60 * 1000;
const LOC_REFRESH_POLL_MS = 8_000;
const LOC_REFRESH_IDLE_POLL_MS = 60_000;
const ACTIVITY_REFRESH_POLL_MS = 60_000;

const LOC_COLORS = [
  "#c15f3c", // terracotta
  "#6b8e4e", // sage
  "#4e6b8e", // slate blue
  "#8e6b4e", // warm brown
  "#574d9c", // muted indigo
  "#9c4d8b", // plum
  "#3a8e85", // teal
  "#c49a3c", // mustard
  "#8a4ec1", // violet
  "#547b3f", // deep olive
  "#b85c7a", // rose
  "#456e95", // steel
];

interface Bucket {
  project: string;
  source: "jira" | "github" | "mixed";
  features: Rollup[];
}

const STATUS_LABELS: Record<Rollup["status"], string> = {
  done: "Done",
  merged: "Merged",
  in_review: "In review",
  in_progress: "In progress",
  open: "Open",
};

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

export function ProjectsView() {
  const [range, setRange] = React.useState<Range>("7d");
  return (
    <ByProjectPanel
      range={range}
      onRangeChange={setRange}
      showHeader
      className="p-4"
    />
  );
}

export function ByProjectPanel({
  range,
  onRangeChange,
  activity: externalActivity,
  activityErr: externalActivityErr,
  activityLoading: externalActivityLoading,
  showHeader = false,
  showProjectBuckets = true,
  chartFooter,
  className,
}: {
  range: Range;
  onRangeChange?: (r: Range) => void;
  activity?: ActivityPayload | null;
  activityErr?: string | null;
  activityLoading?: boolean;
  showHeader?: boolean;
  showProjectBuckets?: boolean;
  chartFooter?: React.ReactNode;
  className?: string;
}) {
  const [activity, setActivity] = React.useState<ActivityPayload | null>(null);
  const [activityErr, setActivityErr] = React.useState<string | null>(null);
  const [activityLoading, setActivityLoading] = React.useState(false);
  const hasExternalActivity =
    externalActivity !== undefined ||
    externalActivityErr !== undefined ||
    externalActivityLoading !== undefined;

  React.useEffect(() => {
    if (hasExternalActivity) return;
    let live = true;
    let loadingTimer: number | null = null;
    let pollTimer: number | null = null;

    async function load(showLoading: boolean) {
      if (showLoading) {
        loadingTimer = window.setTimeout(() => {
          if (live) setActivityLoading(true);
        }, 0);
      }

      try {
        const r = await fetch(`/api/chaos/activity?range=${range}`, {
          cache: "no-store",
        });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const d = (await r.json()) as ActivityPayload;
        if (!live) return;
        setActivity(d);
        setActivityErr(null);
      } catch (e) {
        if (!live) return;
        setActivityErr(e instanceof Error ? e.message : String(e));
      } finally {
        if (loadingTimer) {
          window.clearTimeout(loadingTimer);
          loadingTimer = null;
        }
        if (live && showLoading) setActivityLoading(false);
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
  }, [hasExternalActivity, range]);

  const displayedActivity = hasExternalActivity
    ? externalActivity ?? null
    : activity;
  const displayedActivityErr = hasExternalActivity
    ? externalActivityErr ?? null
    : activityErr;
  const displayedActivityLoading = hasExternalActivity
    ? externalActivityLoading ?? false
    : activityLoading;

  const buckets = React.useMemo<Bucket[]>(() => {
    if (!displayedActivity) return [];
    const m = new Map<string, Bucket>();
    for (const r of displayedActivity.rollups) {
      const name = r.project ?? "(unattributed)";
      let b = m.get(name);
      if (!b) {
        const src = r.source === "jira" ? "jira" : "github";
        b = { project: name, source: src, features: [] };
        m.set(name, b);
      } else if (
        (b.source === "jira" && r.source !== "jira") ||
        (b.source === "github" && r.source === "jira")
      ) {
        b.source = "mixed";
      }
      b.features.push(r);
    }
    for (const b of m.values()) {
      b.features.sort((a, z) => (a.lastSeen < z.lastSeen ? 1 : -1));
    }
    return [...m.values()].sort(
      (a, z) => z.features.length - a.features.length,
    );
  }, [displayedActivity]);

  const activityLocRefreshKey = React.useMemo(
    () => buildActivityLocRefreshKey(displayedActivity),
    [displayedActivity],
  );

  return (
    <div className={cn("space-y-5", className)}>
      {showHeader ? (
        <header className="flex items-center justify-between gap-4">
          <div className="min-w-0">
            <h1 className="text-lg font-semibold leading-tight">By project</h1>
            <p className="text-xs text-muted-foreground">
              Codebase size + shipped features per project, sourced from chaos.
            </p>
          </div>
          {onRangeChange ? (
            <RangeTabs value={range} onChange={onRangeChange} />
          ) : null}
        </header>
      ) : null}

      <ProjectLocChart
        range={range}
        activityRefreshKey={activityLocRefreshKey}
        footer={chartFooter}
      />

      {displayedActivityErr ? (
        <Card className="border-destructive/50 bg-destructive/5 px-4 py-3 text-sm text-destructive">
          Couldn&apos;t load activity: {displayedActivityErr}
        </Card>
      ) : null}

      {!displayedActivity && displayedActivityLoading ? (
        <div className="py-10 text-center text-sm text-muted-foreground">
          Loading…
        </div>
      ) : null}

      {displayedActivity && buckets.length === 0 ? (
        <div className="py-6 text-center text-sm text-muted-foreground">
          No features in this window.
        </div>
      ) : null}

      {showProjectBuckets ? (
        <div className="space-y-5">
          {buckets.map((b) => (
            <section key={b.project}>
              <div className="mb-2 flex items-center gap-2 px-1">
                <span className="text-sm font-medium">{b.project}</span>
                <span className="text-xs text-muted-foreground">
                  {b.features.length} feature
                  {b.features.length === 1 ? "" : "s"}
                </span>
                {b.source !== "mixed" ? (
                  <Badge variant="secondary" className="text-[10px]">
                    {b.source === "jira" ? "Jira" : "GitHub"}
                  </Badge>
                ) : null}
              </div>
              <Card className="divide-y divide-border px-4 py-0">
                {b.features.map((f) => (
                  <FeatureRow key={f.detailId} rollup={f} />
                ))}
              </Card>
            </section>
          ))}
        </div>
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

function FeatureRow({ rollup }: { rollup: Rollup }) {
  const summary = rollupSummary(rollup);
  return (
    <a
      href={`${CHAOS_PUBLIC_URL}/feature?id=${encodeURIComponent(rollup.detailId)}`}
      target="_blank"
      rel="noreferrer"
      className="-mx-1 flex items-center gap-3 rounded-lg px-1 py-2 transition-colors hover:bg-muted/60"
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
      <ArrowSquareOutIcon
        aria-hidden="true"
        className="size-3.5 shrink-0 text-muted-foreground/60"
      />
    </a>
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

function ProjectLocChart({
  range,
  activityRefreshKey,
  footer,
}: {
  range: Range;
  activityRefreshKey?: string | null;
  footer?: React.ReactNode;
}) {
  const [data, setData] = React.useState<ProjectLocPayload | null>(null);
  const [err, setErr] = React.useState<string | null>(null);
  const [refreshing, setRefreshing] = React.useState(false);
  const lastActivityRefreshKey = React.useRef<string | null>(null);

  const refreshNow = React.useCallback(async () => {
    setRefreshing(true);
    try {
      const d = await fetchProjectLoc(true);
      setData(d);
      setErr(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setRefreshing(false);
    }
  }, []);

  React.useEffect(() => {
    let live = true;
    let pollTimer: ReturnType<typeof setTimeout> | null = null;
    let lastForcedCachedAt: string | null = null;

    function scheduleLoad(delay: number) {
      if (pollTimer) clearTimeout(pollTimer);
      pollTimer = setTimeout(() => {
        void load();
      }, delay);
    }

    async function load(force = false) {
      try {
        if (force) setRefreshing(true);
        const d = await fetchProjectLoc(force);
        if (!live) return;
        setData(d);
        setErr(null);
        const stale = isProjectLocStale(d);
        if (!force && stale && lastForcedCachedAt !== d.cachedAt) {
          lastForcedCachedAt = d.cachedAt;
          void load(true);
        }
        scheduleLoad(
          d.computing || stale
            ? LOC_REFRESH_POLL_MS
            : LOC_REFRESH_IDLE_POLL_MS,
        );
      } catch (e) {
        if (live) setErr(e instanceof Error ? e.message : String(e));
      } finally {
        if (live && force) setRefreshing(false);
      }
    }

    load();
    return () => {
      live = false;
      if (pollTimer) clearTimeout(pollTimer);
    };
  }, []);

  React.useEffect(() => {
    if (!activityRefreshKey) return;
    if (lastActivityRefreshKey.current === activityRefreshKey) return;
    lastActivityRefreshKey.current = activityRefreshKey;

    let live = true;
    setRefreshing(true);
    fetchProjectLoc(true)
      .then((d) => {
        if (!live) return;
        setData(d);
        setErr(null);
      })
      .catch((e) => {
        if (live) setErr(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (live) setRefreshing(false);
      });

    return () => {
      live = false;
    };
  }, [activityRefreshKey]);

  const visibleWeeks = React.useMemo(() => {
    if (!data) return [];
    const spec = WEEKS_FOR_RANGE[range];
    if (spec === "all" || spec === undefined) return data.weeks;
    return data.weeks.slice(-spec);
  }, [data, range]);

  const rows = React.useMemo(() => {
    if (!data) return [];
    return visibleWeeks.map((w) => {
      const row: Record<string, number | string> = { date: w };
      for (const p of data.projects) {
        const pt = p.points.find((x) => x.date === w);
        if (pt) row[p.project] = pt.loc;
      }
      return row;
    });
  }, [data, visibleWeeks]);

  if (err) {
    return (
      <Card className="px-4 py-3 text-xs text-muted-foreground">
        Couldn&apos;t load LOC history: {err}
      </Card>
    );
  }

  if (!data) {
    return (
      <Card className="px-4 py-8 text-center text-xs text-muted-foreground">
        Loading LOC history…
      </Card>
    );
  }

  if (data.projects.length === 0) {
    if (data.computing) {
      return (
        <Card className="px-4 py-6 text-center text-xs text-muted-foreground">
          GitHub is computing stats for these repos. This usually takes 30–60
          seconds on first run — refresh in a minute.
        </Card>
      );
    }
    return (
      <Card className="px-4 py-4 text-xs text-muted-foreground">
        No project ↔ repo mappings configured. Add{" "}
        <code className="rounded bg-muted px-1">repos:</code> to projects in{" "}
        <code className="rounded bg-muted px-1">config/sources.yaml</code> in
        chaos.
      </Card>
    );
  }

  const latestByProj = data.projects.map((p) => ({
    name: p.project,
    loc: p.points.at(-1)?.loc ?? 0,
  }));
  const isRefreshing = refreshing || data.computing;

  return (
    <Card className="p-4">
      <div className="mb-3 flex items-start justify-between gap-3">
        <div>
          <div className="text-sm font-medium">Codebase size by project</div>
          <div className="text-xs text-muted-foreground">
            Cumulative lines of code · last {visibleWeeks.length} week
            {visibleWeeks.length === 1 ? "" : "s"}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <div className="text-xs text-muted-foreground">
            {isRefreshing
              ? "refreshing…"
              : "updated " +
                new Date(data.cachedAt).toLocaleDateString("en-US", {
                  month: "short",
                  day: "numeric",
                })}
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-7 gap-1.5 px-2 text-xs"
            onClick={() => void refreshNow()}
            disabled={refreshing}
            title="Refresh LOC history"
          >
            <ArrowClockwiseIcon
              aria-hidden="true"
              className={cn("size-3.5", refreshing ? "animate-spin" : "")}
            />
            LOC
          </Button>
        </div>
      </div>

      <div className="-ml-2 h-56">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart
            data={rows}
            margin={{ top: 6, right: 6, left: 0, bottom: 0 }}
          >
            <defs>
              {data.projects.map((p, i) => (
                <linearGradient
                  key={p.project}
                  id={`g-${p.project}`}
                  x1="0"
                  y1="0"
                  x2="0"
                  y2="1"
                >
                  <stop
                    offset="0%"
                    stopColor={LOC_COLORS[i % LOC_COLORS.length]}
                    stopOpacity={0.4}
                  />
                  <stop
                    offset="100%"
                    stopColor={LOC_COLORS[i % LOC_COLORS.length]}
                    stopOpacity={0}
                  />
                </linearGradient>
              ))}
            </defs>
            <CartesianGrid stroke="rgba(20,20,19,0.06)" vertical={false} />
            <XAxis
              dataKey="date"
              tickFormatter={formatDate}
              stroke="rgba(20,20,19,0.4)"
              tick={{ fontSize: 10 }}
              axisLine={false}
              tickLine={false}
            />
            <YAxis
              tickFormatter={formatLoc}
              stroke="rgba(20,20,19,0.4)"
              tick={{ fontSize: 10 }}
              axisLine={false}
              tickLine={false}
              width={40}
            />
            <Tooltip content={<LocTooltip />} />
            {data.projects.map((p, i) => (
              <Area
                key={p.project}
                type="monotone"
                dataKey={p.project}
                stroke={LOC_COLORS[i % LOC_COLORS.length]}
                strokeWidth={1.5}
                fill={`url(#g-${p.project})`}
                isAnimationActive
                animationDuration={600}
                connectNulls
              />
            ))}
          </AreaChart>
        </ResponsiveContainer>
      </div>

      <WeeklyLocThroughputPanel
        weeks={visibleWeeks}
        throughput={data.weeklyThroughput ?? []}
      />

      <Separator className="my-3" />

      {footer !== undefined ? (
        footer
      ) : (
        <div className="flex flex-wrap gap-x-4 gap-y-1 pl-2 text-xs">
          {latestByProj.map((p, i) => (
            <div key={p.name} className="flex items-center gap-1.5">
              <span
                className="size-2 rounded-full"
                style={{ backgroundColor: LOC_COLORS[i % LOC_COLORS.length] }}
              />
              <span>{p.name}</span>
              <span className="tabular-nums text-muted-foreground">
                {formatLoc(p.loc)}
              </span>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

async function fetchProjectLoc(force: boolean): Promise<ProjectLocPayload> {
  const path = force
    ? "/api/chaos/project-stats?force=1"
    : "/api/chaos/project-stats";
  const r = await fetch(path, { cache: "no-store" });
  const ct = r.headers.get("content-type") ?? "";
  if (!ct.includes("application/json")) {
    throw new Error(
      `unexpected response (${r.status} ${ct || "no content-type"})`,
    );
  }
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return (await r.json()) as ProjectLocPayload;
}

function isProjectLocStale(data: ProjectLocPayload): boolean {
  const cachedAt = new Date(data.cachedAt).getTime();
  if (!Number.isFinite(cachedAt) || cachedAt <= 0) return data.computing;
  return Date.now() - cachedAt >= LOC_REFRESH_STALE_MS;
}

function buildActivityLocRefreshKey(
  activity: ActivityPayload | null,
): string | null {
  if (!activity) return null;

  const projectStats = new Map<
    string,
    { commitCount: number; lastSeen: string }
  >();
  for (const rollup of activity.rollups) {
    if (!rollup.commitCount) continue;
    const project = rollup.project ?? "(unattributed)";
    const current = projectStats.get(project) ?? {
      commitCount: 0,
      lastSeen: "",
    };
    current.commitCount += rollup.commitCount;
    if (rollup.lastSeen > current.lastSeen) current.lastSeen = rollup.lastSeen;
    projectStats.set(project, current);
  }

  const totals = activity.people.reduce(
    (acc, person) => {
      acc.commits += person.commitCount ?? 0;
      acc.added += person.linesAdded ?? 0;
      acc.removed += person.linesRemoved ?? 0;
      return acc;
    },
    { commits: 0, added: 0, removed: 0 },
  );

  if (
    projectStats.size === 0 &&
    totals.commits === 0 &&
    totals.added === 0 &&
    totals.removed === 0
  ) {
    return null;
  }

  const projectPart = [...projectStats.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(
      ([project, stats]) =>
        `${project}:${stats.commitCount}:${stats.lastSeen}`,
    )
    .join("|");

  return `${totals.commits}:${totals.added}:${totals.removed}:${projectPart}`;
}

interface TooltipItem {
  name?: string | number;
  value?: number;
  color?: string;
}
function LocTooltip({
  active,
  payload,
  label,
}: {
  active?: boolean;
  payload?: TooltipItem[];
  label?: string;
}) {
  if (!active || !payload || payload.length === 0 || !label) return null;
  const nonZero = payload.filter((p) => (p.value ?? 0) > 0);
  if (nonZero.length === 0) return null;
  const total = nonZero.reduce((a, b) => a + (b.value ?? 0), 0);
  return (
    <div
      className={cn(
        "rounded-md border bg-popover px-3 py-2 text-xs text-popover-foreground shadow-sm",
      )}
    >
      <div className="mb-1 font-medium">{formatDate(label)}</div>
      <div className="space-y-0.5">
        {nonZero
          .slice()
          .sort((a, b) => (b.value ?? 0) - (a.value ?? 0))
          .map((p) => (
            <div key={String(p.name)} className="flex items-center gap-2">
              <span
                className="size-1.5 rounded-full"
                style={{ backgroundColor: p.color }}
              />
              <span>{p.name}</span>
              <span className="ml-auto tabular-nums text-muted-foreground">
                {formatLoc(p.value ?? 0)}
              </span>
            </div>
          ))}
      </div>
      <div className="mt-1 flex justify-between border-t pt-1 text-muted-foreground">
        <span>total</span>
        <span className="tabular-nums">{formatLoc(total)}</span>
      </div>
    </div>
  );
}

function WeeklyLocThroughputPanel({
  weeks,
  throughput,
}: {
  weeks: string[];
  throughput: WeeklyLocThroughputPoint[];
}) {
  const [tooltip, setTooltip] = React.useState<{
    point: WeeklyLocThroughputPoint;
    x: number;
    y: number;
  } | null>(null);
  const scrollRef = React.useRef<HTMLDivElement | null>(null);

  const points = React.useMemo(() => {
    const byWeek = new Map(throughput.map((p) => [p.date, p]));
    return weeks.map(
      (date) =>
        byWeek.get(date) ?? {
          date,
          additions: 0,
          contributors: [],
        },
    );
  }, [throughput, weeks]);

  const contributorTotals = React.useMemo(() => {
    const totals = new Map<
      string,
      {
        personId: string;
        displayName: string;
        githubLogin: string | null;
        additions: number;
      }
    >();
    for (const point of points) {
      for (const contributor of point.contributors) {
        const current = totals.get(contributor.personId) ?? {
          personId: contributor.personId,
          displayName: contributor.displayName,
          githubLogin: contributor.githubLogin,
          additions: 0,
        };
        current.additions += contributor.additions;
        totals.set(contributor.personId, current);
      }
    }
    return [...totals.values()].sort((a, z) => z.additions - a.additions);
  }, [points]);

  const colorByPerson = React.useMemo(() => {
    const colors = new Map<string, string>();
    contributorTotals.forEach((person, index) => {
      colors.set(person.personId, LOC_COLORS[index % LOC_COLORS.length]);
    });
    return colors;
  }, [contributorTotals]);

  const maxWeek = Math.max(1, ...points.map((point) => point.additions));
  const total = points.reduce((sum, point) => sum + point.additions, 0);
  const latest = points.at(-1)?.additions ?? 0;
  const latestWeekDate = points.at(-1)?.date ?? "";

  React.useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollLeft = el.scrollWidth;
  }, [latestWeekDate, points.length]);

  const showTooltip = React.useCallback(
    (point: WeeklyLocThroughputPoint, clientX: number, clientY: number) => {
      const width = 280;
      const gutter = 12;
      const viewportWidth = document.documentElement.clientWidth || width;
      setTooltip({
        point,
        x: Math.max(
          gutter,
          Math.min(clientX + 14, viewportWidth - width - gutter),
        ),
        y: Math.max(gutter, clientY + 14),
      });
    },
    [],
  );

  return (
    <div className="mt-4 rounded-md border bg-background/35 p-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-sm font-medium">Weekly LOC throughput</div>
          <div className="text-xs text-muted-foreground">
            Default-branch additions that reached production; deletions
            excluded.
          </div>
        </div>
        <div className="text-right text-xs">
          <div className="font-medium tabular-nums">
            {formatLoc(total)} added
          </div>
          <div className="text-muted-foreground tabular-nums">
            latest {formatLoc(latest)}
          </div>
        </div>
      </div>

      <div
        ref={scrollRef}
        className="mt-3 overflow-x-auto pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        onScroll={() => setTooltip(null)}
      >
        <div
          className="grid min-w-[480px] items-end gap-2"
          style={{
            gridTemplateColumns: `repeat(${Math.max(points.length, 1)}, minmax(44px, 1fr))`,
          }}
        >
          {points.map((point) => {
            const height = point.additions
              ? Math.max(6, (point.additions / maxWeek) * 100)
              : 0;
            return (
              <button
                key={point.date}
                type="button"
                className="flex min-w-0 cursor-default flex-col items-center gap-1 rounded-sm bg-transparent p-0 text-inherit outline-none focus-visible:ring-1 focus-visible:ring-ring"
                aria-label={`${formatDate(point.date)}: ${formatLoc(point.additions)} LOC added`}
                onMouseEnter={(event) =>
                  showTooltip(point, event.clientX, event.clientY)
                }
                onMouseMove={(event) =>
                  showTooltip(point, event.clientX, event.clientY)
                }
                onMouseLeave={() => setTooltip(null)}
                onFocus={(event) => {
                  const rect = event.currentTarget.getBoundingClientRect();
                  showTooltip(point, rect.left + rect.width / 2, rect.top);
                }}
                onBlur={() => setTooltip(null)}
              >
                <div className="h-4 max-w-full truncate text-[10px] tabular-nums text-muted-foreground">
                  {point.additions ? formatLoc(point.additions) : "0"}
                </div>
                <div className="flex h-24 w-full max-w-10 items-end rounded-sm bg-muted/50">
                  {point.additions ? (
                    <div
                      className="flex w-full flex-col-reverse overflow-hidden rounded-sm"
                      style={{ height: `${height}%` }}
                    >
                      {point.contributors.map((contributor) => (
                        <div
                          key={contributor.personId}
                          style={{
                            height: `${(contributor.additions / point.additions) * 100}%`,
                            backgroundColor:
                              colorByPerson.get(contributor.personId) ??
                              LOC_COLORS[0],
                          }}
                        />
                      ))}
                    </div>
                  ) : null}
                </div>
                <div className="max-w-full truncate text-[10px] text-muted-foreground">
                  {formatDate(point.date)}
                </div>
              </button>
            );
          })}
        </div>
      </div>

      {tooltip ? (
        <WeeklyLocThroughputTooltip
          point={tooltip.point}
          x={tooltip.x}
          y={tooltip.y}
          colorByPerson={colorByPerson}
        />
      ) : null}

      {contributorTotals.length === 0 ? (
        <div className="mt-3 text-xs text-muted-foreground">
          No production additions in this window.
        </div>
      ) : null}
    </div>
  );
}

function WeeklyLocThroughputTooltip({
  point,
  x,
  y,
  colorByPerson,
}: {
  point: WeeklyLocThroughputPoint;
  x: number;
  y: number;
  colorByPerson: Map<string, string>;
}) {
  const visibleContributors = point.contributors.slice(0, 12);

  return (
    <div
      className="pointer-events-none fixed z-50 w-[17.5rem] rounded-md border bg-popover px-3 py-2 text-xs text-popover-foreground shadow-xl"
      style={{ left: x, top: y }}
    >
      <div className="flex items-center justify-between gap-3">
        <div className="font-medium">{formatDate(point.date)}</div>
        <div className="tabular-nums text-muted-foreground">
          {formatLoc(point.additions)} LOC
        </div>
      </div>

      {visibleContributors.length > 0 ? (
        <div className="mt-2 space-y-1">
          {visibleContributors.map((contributor) => (
            <div
              key={contributor.personId}
              className="flex items-center justify-between gap-3"
            >
              <div className="flex min-w-0 items-center gap-1.5">
                <span
                  className="size-2 shrink-0 rounded-full"
                  style={{
                    backgroundColor:
                      colorByPerson.get(contributor.personId) ??
                      LOC_COLORS[0],
                  }}
                />
                <span className="truncate">{contributor.displayName}</span>
              </div>
              <span className="shrink-0 tabular-nums text-muted-foreground">
                {formatLoc(contributor.additions)}
              </span>
            </div>
          ))}
          {point.contributors.length > visibleContributors.length ? (
            <div className="text-muted-foreground">
              +{point.contributors.length - visibleContributors.length} more
            </div>
          ) : null}
        </div>
      ) : (
        <div className="mt-2 text-muted-foreground">
          No production additions this week.
        </div>
      )}
    </div>
  );
}
