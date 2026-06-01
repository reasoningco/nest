"use client"

import * as React from "react"
import {
  CaretLeftIcon,
  CaretRightIcon,
  CirclesFourIcon,
  ClockIcon,
  FileIcon,
  GearSixIcon,
  GitBranchIcon,
  KanbanIcon,
  MagnifyingGlassIcon,
  PlayIcon,
  PlusIcon,
  PulseIcon,
  SignOutIcon,
  TerminalWindowIcon,
  UsersThreeIcon,
  XIcon,
} from "@phosphor-icons/react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Separator } from "@/components/ui/separator"
import { AgentDetailsDialog } from "@/components/agent-details-dialog"
import { OrgActivityView } from "@/components/chaos/org-activity-view"
import { UserSdasView } from "@/components/chaos/user-sdas-view"
import { JetsonAgentView } from "@/components/jetson-agent-view"
import { SdmChartView } from "@/components/sdm-chart-view"
import { Textarea } from "@/components/ui/textarea"
import type {
  AgentCard,
  AgentRuntime,
  AgentListResponse,
  CreateAgentResponse,
  ModelOption,
  PublicSession,
  RepositoryOption,
} from "@/lib/agents/types"
import type { ConfiguredRepo } from "@/lib/jetson-agent/types"
import { cn } from "@/lib/utils"

type GroupBy = "status" | "repository" | "createdAt"
type IconComponent = React.ElementType

type GroupOption = {
  id: GroupBy
  label: string
  icon: IconComponent
  requiresData?: keyof AgentCard
}

type SelectableGroupOption = GroupOption & {
  selectable: boolean
}

type SidebarFilter =
  | "sdms"
  | "chart"
  | "jetsonAgent"
  | "userSdas"
  | "orgActivity"

type Repo = ConfiguredRepo

/**
 * Statuses we treat as "this agent is no longer running" — used to bucket
 * the SDMs view down to in-flight work only. Permissive on unknowns: a
 * status the team's never seen before stays visible rather than silently
 * disappearing from the board.
 */
const TERMINAL_STATUSES = new Set([
  "completed",
  "complete",
  "done",
  "finished",
  "failed",
  "error",
  "errored",
  "cancelled",
  "canceled",
  "expired",
  "stopped",
  "aborted",
])

function isAgentActive(status: string | undefined) {
  if (!status) return false
  return !TERMINAL_STATUSES.has(status.trim().toLowerCase())
}

/**
 * Find the Cursor RepositoryOption that corresponds to a bridge Repo.
 * Cursor's API returns its own list of repositories the user has linked;
 * the SDMs columns come from our bridge. We bridge the two by URL match
 * (case-insensitive, ignoring `.git` and trailing slash) so the "+ new
 * agent" button in a column can preselect that repo in the create dialog.
 */
function findRepositoryOption(
  repo: Repo,
  options: RepositoryOption[],
): RepositoryOption | null {
  const norm = (u: string | undefined) =>
    (u ?? "")
      .toLowerCase()
      .trim()
      .replace(/\.git$/, "")
      .replace(/\/+$/, "")
  const target = norm(repo.url)
  return (
    options.find((o) => norm(o.url) === target) ??
    options.find(
      (o) =>
        o.owner?.toLowerCase() === repo.owner.toLowerCase() &&
        o.name?.toLowerCase() === repo.name.toLowerCase(),
    ) ??
    null
  )
}

function repoMatchesAgent(repo: Repo, agent: AgentCard): boolean {
  const target = `${repo.owner}/${repo.name}`.toLowerCase()
  const candidates: string[] = []
  if (agent.repository) candidates.push(agent.repository.toLowerCase().trim())
  if (agent.repositoryUrl)
    candidates.push(agent.repositoryUrl.toLowerCase().trim())

  for (const c of candidates) {
    if (!c) continue
    if (c === target) return true
    const m = c.match(/github\.com[:/]([^/]+)\/([^/.]+)/)
    if (m && `${m[1]}/${m[2]}` === target) return true
    if (c === repo.name.toLowerCase()) return true
  }
  return false
}

type AppStatus = "checking" | "ready"

type ApiError = {
  code?: string
  error?: string
}

const sessionStorageKey = "agent-kanban-session-id"
const sidebarFilterStorageKey = "agent-kanban-sidebar-filter"
const sidebarDefaultVersionStorageKey = "agent-kanban-sidebar-default-version"
const sidebarDefaultVersion = "org-activity-first-v1"
const defaultSidebarFilter: SidebarFilter = "orgActivity"
const defaultGroupBy: GroupBy = "status"
const autoRefreshMs = 4 * 60 * 60 * 1000

const groupOptions: GroupOption[] = [
  { id: "status", label: "Status", icon: CirclesFourIcon },
  { id: "repository", label: "Repository", icon: KanbanIcon },
  { id: "createdAt", label: "Created date", icon: ClockIcon },
]

const dateBucketOrder = new Map([
  ["Today", 0],
  ["Yesterday", 1],
  ["This week", 2],
  ["This month", 3],
  ["Older", 4],
  ["No date", 5],
])

const sidebarFilters: {
  id: SidebarFilter
  label: string
  icon: IconComponent
}[] = [
  { id: "orgActivity", label: "Org activity", icon: PulseIcon },
  { id: "sdms", label: "SDMs", icon: UsersThreeIcon },
  { id: "chart", label: "Chart", icon: CirclesFourIcon },
  { id: "jetsonAgent", label: "Jetson agent", icon: TerminalWindowIcon },
  { id: "userSdas", label: "Human SDMs", icon: TerminalWindowIcon },
]

// Sidebar items that swap the main content for a chaos view rather than
// filtering the in-memory agents list. These hide the search/group-by chrome
// and don't compute counts.
const CHAOS_FILTERS: ReadonlySet<SidebarFilter> = new Set([
  "userSdas",
  "orgActivity",
  "jetsonAgent",
  "chart",
])

function readStoredSidebarFilter(): SidebarFilter {
  if (typeof window === "undefined") return defaultSidebarFilter
  const defaultVersion = window.localStorage.getItem(
    sidebarDefaultVersionStorageKey,
  )
  if (defaultVersion !== sidebarDefaultVersion) {
    window.localStorage.setItem(
      sidebarDefaultVersionStorageKey,
      sidebarDefaultVersion,
    )
    window.localStorage.setItem(sidebarFilterStorageKey, defaultSidebarFilter)
    return defaultSidebarFilter
  }
  const stored = window.localStorage.getItem(sidebarFilterStorageKey)
  return isSidebarFilter(stored) ? stored : defaultSidebarFilter
}

function isSidebarFilter(value: unknown): value is SidebarFilter {
  return (
    typeof value === "string" &&
    sidebarFilters.some((filter) => filter.id === value)
  )
}

const boardLoadingColumns: {
  id: string
  title: string
  icon: IconComponent
  cards: number
}[] = [
  { id: "queued", title: "Queued", icon: CirclesFourIcon, cards: 3 },
  { id: "running", title: "Running", icon: ClockIcon, cards: 2 },
  { id: "review", title: "Review", icon: KanbanIcon, cards: 3 },
]

const loadingCardLineWidths = [
  ["w-11/12", "w-2/3"],
  ["w-4/5", "w-1/2"],
  ["w-3/4", "w-5/6"],
] as const

export function AgentKanbanApp() {
  const [status, setStatus] = React.useState<AppStatus>("checking")
  const [session, setSession] = React.useState<PublicSession | null>(null)
  const [agents, setAgents] = React.useState<AgentCard[]>([])
  const [repositories, setRepositories] = React.useState<RepositoryOption[]>([])
  const [models, setModels] = React.useState<ModelOption[]>([])
  const [groupBy, setGroupBy] = React.useState<GroupBy>(defaultGroupBy)
  const [sidebarFilter, setSidebarFilter] = React.useState<SidebarFilter>(
    readStoredSidebarFilter,
  )
  const [query, setQuery] = React.useState("")
  const [isLoading, setIsLoading] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [isCreateOpen, setIsCreateOpen] = React.useState(false)
  // When the user clicks "+" on a SDMs repo column, we preselect that
  // repo in the create dialog so they don't have to pick again.
  const [createForRepoId, setCreateForRepoId] = React.useState<string | null>(
    null,
  )
  const [selectedAgent, setSelectedAgent] = React.useState<AgentCard | null>(
    null,
  )
  const [isSidebarCollapsed, setIsSidebarCollapsed] = React.useState(false)
  const [repos, setRepos] = React.useState<Repo[]>([])
  const [reposError, setReposError] = React.useState<string | null>(null)
  const [reposLoading, setReposLoading] = React.useState(false)
  const [isSettingsOpen, setIsSettingsOpen] = React.useState(false)
  const autoRefreshInFlightRef = React.useRef(false)

  React.useEffect(() => {
    window.localStorage.setItem(sidebarFilterStorageKey, sidebarFilter)
  }, [sidebarFilter])

  const loadBoard = React.useCallback(async (
    sessionId: string,
    options: { includeStaticData?: boolean; showLoading?: boolean } = {},
  ) => {
    const includeStaticData = options.includeStaticData ?? false
    const showLoading = options.showLoading ?? true
    if (showLoading) {
      setIsLoading(true)
    }
    setError(null)
    try {
      const [agentResult, staticData] = await Promise.all([
        apiFetch<AgentListResponse>("/api/agents", sessionId),
        includeStaticData
          ? Promise.all([
              apiFetch<{ repositories: RepositoryOption[] }>(
                "/api/repositories",
                sessionId
              ),
              apiFetch<{ models: ModelOption[] }>("/api/models", sessionId),
            ])
          : Promise.resolve(null),
      ])
      setAgents(agentResult.agents)
      if (staticData) {
        const [repositoryResult, modelResult] = staticData
        setRepositories(repositoryResult.repositories)
        setModels(modelResult.models)
      }
    } catch (loadError) {
      setError(errorMessage(loadError, "Failed to load cloud agents."))
    } finally {
      if (showLoading) {
        setIsLoading(false)
      }
    }
  }, [])

  React.useEffect(() => {
    let cancelled = false

    async function restore() {
      const existingSessionId = window.localStorage.getItem(sessionStorageKey)
      try {
        const restored = await fetchJson<PublicSession>("/api/session", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sessionId: existingSessionId }),
        })
        if (cancelled) {
          return
        }
        window.localStorage.setItem(sessionStorageKey, restored.id)
        setSession(restored)
        setStatus("ready")
        await loadBoard(restored.id, { includeStaticData: true })
      } catch (restoreError) {
        if (!cancelled) {
          window.localStorage.removeItem(sessionStorageKey)
          setError(errorMessage(restoreError, "Failed to start NEST."))
        }
      }
    }

    restore()
    return () => {
      cancelled = true
    }
  }, [loadBoard])

  React.useEffect(() => {
    if (status !== "ready" || !session) {
      return
    }

    const refresh = async () => {
      if (autoRefreshInFlightRef.current) {
        return
      }
      autoRefreshInFlightRef.current = true
      try {
        await loadBoard(session.id, { showLoading: false })
      } finally {
        autoRefreshInFlightRef.current = false
      }
    }

    const id = window.setInterval(() => void refresh(), autoRefreshMs)
    return () => window.clearInterval(id)
  }, [loadBoard, session, status])

  const loadRepos = React.useCallback(async () => {
    setReposLoading(true)
    try {
      const r = await fetch("/api/repos", { cache: "no-store" })
      if (!r.ok) {
        const j = (await r.json().catch(() => ({}))) as ApiError
        throw new Error(j.error ?? `HTTP ${r.status}`)
      }
      const json = (await r.json()) as { repos: Repo[] }
      setRepos(json.repos)
      setReposError(null)
    } catch (e) {
      setReposError(e instanceof Error ? e.message : String(e))
    } finally {
      setReposLoading(false)
    }
  }, [])

  // Lazy-load the repo list the first time the user opens any repo-driven
  // view. SDMs and Settings share the bridge as the source of truth, so a
  // single fetch hydrates both.
  React.useEffect(() => {
    const repoView =
      sidebarFilter === "sdms" ||
      sidebarFilter === "jetsonAgent" ||
      isSettingsOpen
    if (!repoView) return
    if (repos.length > 0 || reposLoading) return
    const id = window.setTimeout(() => void loadRepos(), 0)
    return () => window.clearTimeout(id)
  }, [sidebarFilter, isSettingsOpen, repos.length, reposLoading, loadRepos])

  async function handleSessionCreated(nextSession: PublicSession) {
    window.localStorage.setItem(sessionStorageKey, nextSession.id)
    setSession(nextSession)
    setStatus("ready")
    await loadBoard(nextSession.id, { includeStaticData: true })
  }

  async function handleForgetKey() {
    window.localStorage.removeItem(sessionStorageKey)
    await fetch("/api/session", { method: "DELETE" })
    const restored = await fetchJson<PublicSession>("/api/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    })
    window.localStorage.setItem(sessionStorageKey, restored.id)
    setSession(restored)
    setAgents([])
    setRepositories([])
    setModels([])
    await loadBoard(restored.id, { includeStaticData: true })
  }

  async function handleAgentCreated(agent: AgentCard) {
    setAgents((current) => [agent, ...current])
    if (session) {
      await loadBoard(session.id)
    }
  }

  const selectableGroupOptions = React.useMemo(
    () => getSelectableGroupOptions(agents),
    [agents]
  )
  const selectedGroupBy = isSelectableGroupBy(groupBy, selectableGroupOptions)
    ? groupBy
    : defaultGroupBy

  if (status === "checking") {
    return <LoadingScreen />
  }

  if (!session) {
    return <LoadingScreen error={error} />
  }

  const searchedAgents = searchAgents(agents, query)
  const visibleAgents = filterAgentsBySidebar(searchedAgents, sidebarFilter)
  const showBoardLoading = isLoading && agents.length === 0 && visibleAgents.length === 0
  const sidebarItems = sidebarFilters.map((item) => ({
    ...item,
    count: CHAOS_FILTERS.has(item.id)
      ? undefined
      : filterAgentsBySidebar(searchedAgents, item.id).length,
  }))
  const selectedGroupOption = groupOptions.find((option) => option.id === selectedGroupBy)
  const SelectedGroupIcon = selectedGroupOption?.icon
  const isSdmsView = sidebarFilter === "sdms"
  const isReposView = isSdmsView
  const isChaosView = CHAOS_FILTERS.has(sidebarFilter)
  const groups = isReposView
    ? []
    : groupAgents(visibleAgents, selectedGroupBy)
  const signedInName =
    session.user?.name ?? (session.hasCursorApiKey ? "Cursor user" : "Local NEST")
  const signedInLabel = session.user?.email
    ? `${signedInName} (${session.user.email})`
    : session.hasCursorApiKey
      ? signedInName
      : "Cursor Cloud not connected"
  const signedInInitial = signedInName.trim().charAt(0).toUpperCase() || "C"
  const signedInRole =
    session.role.charAt(0).toUpperCase() + session.role.slice(1)

  return (
    <div className="flex h-screen min-h-0 bg-background text-foreground">
      <aside
        className={cn(
          "hidden shrink-0 border-r bg-sidebar/70 transition-[width] duration-200 lg:flex lg:flex-col",
          isSidebarCollapsed ? "w-16" : "w-64"
        )}
      >
        <div
          className={cn(
            "flex h-14 items-center px-3",
            isSidebarCollapsed ? "justify-center" : "gap-2"
          )}
        >
          {isSidebarCollapsed ? (
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => setIsSidebarCollapsed(false)}
              aria-label="Expand sidebar"
              title="Expand sidebar"
            >
              <CaretRightIcon />
            </Button>
          ) : (
            <>
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-semibold">NEST</div>
              </div>
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={() => setIsSidebarCollapsed(true)}
                aria-label="Collapse sidebar"
                title="Collapse sidebar"
              >
                <CaretLeftIcon />
              </Button>
            </>
          )}
        </div>
        <Separator />
        <nav
          className={cn(
            "flex flex-1 flex-col gap-1 text-sm",
            isSidebarCollapsed ? "items-center p-2" : "p-3"
          )}
          aria-label="Agent filters"
        >
          {sidebarItems.map((item) => (
            <SidebarItem
              key={item.id}
              active={sidebarFilter === item.id}
              collapsed={isSidebarCollapsed}
              count={item.count}
              icon={item.icon}
              label={item.label}
              onSelect={() => setSidebarFilter(item.id)}
            />
          ))}
        </nav>
        <Separator />
        {isSidebarCollapsed ? (
          <div className="flex flex-col items-center gap-2 p-2">
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => setIsSettingsOpen(true)}
              aria-label={`Settings, signed in as ${signedInLabel}`}
              title={`Settings, signed in as ${signedInLabel}`}
            >
              <GearSixIcon />
            </Button>
          </div>
        ) : (
          <div className="p-3">
            <Button
              variant="outline"
              size="sm"
              className="w-full justify-start"
              onClick={() => setIsSettingsOpen(true)}
            >
              <GearSixIcon data-icon="inline-start" />
              Settings
            </Button>
          </div>
        )}
      </aside>

      <main className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 shrink-0 items-center gap-3 border-b px-4">
          {isChaosView ? <div className="flex-1" /> : (
          <>
          <div className="relative flex min-w-48 flex-1 items-center">
            <MagnifyingGlassIcon
              aria-hidden="true"
              className="pointer-events-none absolute left-2.5 size-4 text-muted-foreground"
            />
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search agents and repos..."
              className="h-8 border-0 bg-muted/60 pl-8"
            />
          </div>

          {isReposView ? null : (
            <Select
              items={selectableGroupOptions.map((option) => ({
                label: groupOptionLabel(option),
                value: option.id,
              }))}
              value={selectedGroupBy}
              onValueChange={(value) => {
                if (isSelectableGroupBy(value, selectableGroupOptions)) {
                  setGroupBy(value)
                } else {
                  setGroupBy(defaultGroupBy)
                }
              }}
            >
              <SelectTrigger aria-label="Group agents" size="sm">
                {SelectedGroupIcon ? (
                  <SelectedGroupIcon
                    aria-hidden="true"
                    className="text-muted-foreground"
                  />
                ) : null}
                <SelectValue />
              </SelectTrigger>
              <SelectContent align="end">
                <SelectGroup>
                  {selectableGroupOptions.map((option) => (
                    <SelectItem
                      key={option.id}
                      value={option.id}
                      disabled={!option.selectable}
                    >
                      <GroupOptionContent option={option} />
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          )}

          </>
          )}
        </header>

        {!session.hasCursorApiKey ? (
          <div className="flex items-center justify-between gap-3 border-b bg-muted/30 px-4 py-2 text-sm text-muted-foreground">
            <span>
              Cursor Cloud is disconnected. Jetson and activity views stay available.
            </span>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setIsSettingsOpen(true)}
            >
              <GearSixIcon data-icon="inline-start" />
              Set key
            </Button>
          </div>
        ) : null}

        {error && !isChaosView ? (
          <div className="border-b bg-destructive/10 px-4 py-2 text-sm text-destructive">
            {error}
          </div>
        ) : null}

        <section className="flex min-h-0 flex-1 flex-col">
          {isChaosView ? (
            <ScrollArea className="min-h-0 flex-1">
              {sidebarFilter === "orgActivity" ? (
                <OrgActivityView />
              ) : sidebarFilter === "userSdas" ? (
                <UserSdasView />
              ) : sidebarFilter === "chart" ? (
                <SdmChartView
                  sessionId={session.id}
                  repositories={repositories}
                  models={models}
                  canCreateAgents={session.permissions.createAgents}
                  onAgentCreated={handleAgentCreated}
                />
              ) : (
                <JetsonAgentView
                  configuredRepos={repos}
                  cloudRepositories={repositories}
                  reposError={reposError}
                  reposLoading={reposLoading}
                  onRefreshRepos={loadRepos}
                />
              )}
            </ScrollArea>
          ) : (
            <ScrollArea className="min-h-0 flex-1">
              <div className="flex min-h-full gap-3 p-4">
                {isSdmsView ? (
                  <SdmsBoardColumns
                    repos={repos}
                    reposError={reposError}
                    agents={visibleAgents}
                    repositoryOptions={repositories}
                    canCreateAgents={session.permissions.createAgents}
                    onSelect={setSelectedAgent}
                    onCreateForRepo={(repo) => {
                      const option = findRepositoryOption(repo, repositories)
                      setCreateForRepoId(option?.id ?? null)
                      setIsCreateOpen(true)
                    }}
                  />
                ) : groups.length > 0 ? (
                  groups.map((group) => (
                    <BoardColumn
                      key={group.id}
                      title={group.title}
                      icon={selectedGroupOption?.icon ?? CirclesFourIcon}
                      agents={group.agents}
                      onSelect={setSelectedAgent}
                    />
                  ))
                ) : showBoardLoading ? (
                  <BoardLoadingSkeleton />
                ) : (
                  <EmptyBoard
                    canCreateAgents={session.permissions.createAgents}
                    onCreate={() => setIsCreateOpen(true)}
                  />
                )}
              </div>
            </ScrollArea>
          )}
        </section>
      </main>

      {isCreateOpen && session.permissions.createAgents ? (
        <CreateAgentDialog
          sessionId={session.id}
          hasCursorApiKey={session.hasCursorApiKey}
          models={models}
          repositories={repositories}
          initialRepositoryId={createForRepoId ?? undefined}
          onClose={() => {
            setIsCreateOpen(false)
            setCreateForRepoId(null)
          }}
          onCreated={handleAgentCreated}
        />
      ) : null}

      {selectedAgent ? (
        <AgentDetailsDialog
          agent={selectedAgent}
          sessionId={session.id}
          onClose={() => setSelectedAgent(null)}
        />
      ) : null}

      {isSettingsOpen ? (
        <SettingsDialog
          session={session}
          signedInName={signedInName}
          signedInLabel={signedInLabel}
          signedInInitial={signedInInitial}
          signedInRole={signedInRole}
          repos={repos}
          reposError={reposError}
          reposLoading={reposLoading}
          canManageRouting={session.permissions.manageRouting}
          onClose={() => setIsSettingsOpen(false)}
          onForgetKey={handleForgetKey}
          onSessionUpdated={handleSessionCreated}
          onRefreshRepos={loadRepos}
        />
      ) : null}
    </div>
  )
}

function SettingsDialog({
  session,
  signedInName,
  signedInLabel,
  signedInInitial,
  signedInRole,
  repos,
  reposError,
  reposLoading,
  canManageRouting,
  onClose,
  onForgetKey,
  onSessionUpdated,
  onRefreshRepos,
}: {
  session: PublicSession
  signedInName: string
  signedInLabel: string
  signedInInitial: string
  signedInRole: string
  repos: Repo[]
  reposError: string | null
  reposLoading: boolean
  canManageRouting: boolean
  onClose: () => void
  onForgetKey: () => Promise<void>
  onSessionUpdated: (session: PublicSession) => Promise<void>
  onRefreshRepos: () => Promise<void>
}) {
  const [apiKey, setApiKey] = React.useState("")
  const [savingKey, setSavingKey] = React.useState(false)
  const [forgetting, setForgetting] = React.useState(false)
  const [keyError, setKeyError] = React.useState<string | null>(null)

  async function handleForgetKey() {
    setForgetting(true)
    setKeyError(null)
    try {
      await onForgetKey()
    } finally {
      setForgetting(false)
    }
  }

  async function handleSaveKey(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setSavingKey(true)
    setKeyError(null)
    try {
      const nextSession = await fetchJson<PublicSession>("/api/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ apiKey, remember: true }),
      })
      setApiKey("")
      await onSessionUpdated(nextSession)
    } catch (saveError) {
      setKeyError(errorMessage(saveError, "Unable to save the Cursor API key."))
    } finally {
      setSavingKey(false)
    }
  }

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-background/80 p-4 backdrop-blur-sm">
      <Card
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
        className="max-h-[92vh] w-full max-w-5xl overflow-hidden shadow-2xl"
      >
        <CardHeader className="border-b">
          <div className="flex items-start justify-between gap-4">
            <div>
              <CardTitle id="settings-title">Settings</CardTitle>
              <CardDescription>
                Account controls and repository routing for NEST.
              </CardDescription>
            </div>
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={onClose}
              aria-label="Close settings"
              title="Close settings"
            >
              <XIcon />
            </Button>
          </div>
        </CardHeader>
        <CardContent className="max-h-[calc(92vh-5rem)] overflow-y-auto p-0">
          <div className="grid min-h-[560px] lg:grid-cols-[280px_minmax(0,1fr)]">
            <aside className="border-b bg-muted/20 p-4 lg:border-b-0 lg:border-r">
              <div className="rounded-lg border bg-background p-3">
                <div className="flex items-center gap-3">
                  <div
                    className="flex size-10 shrink-0 items-center justify-center rounded-lg border bg-muted text-sm font-semibold"
                    aria-hidden="true"
                  >
                    {signedInInitial}
                  </div>
                  <div className="min-w-0">
                    <div className="text-xs font-medium text-muted-foreground">
                      Signed in as
                    </div>
                    <div className="truncate text-sm font-medium">
                      {signedInName}
                    </div>
                    <div className="truncate text-xs text-muted-foreground">
                      {signedInLabel}
                    </div>
                    <Badge variant="secondary" className="mt-2 text-[10px]">
                      {signedInRole}
                    </Badge>
                  </div>
                </div>
              </div>
              <form
                className="mt-3 rounded-lg border bg-background p-3"
                onSubmit={handleSaveKey}
              >
                <label className="flex flex-col gap-1.5 text-sm font-medium">
                  Cursor API key
                  <Input
                    type="password"
                    value={apiKey}
                    onChange={(event) => setApiKey(event.target.value)}
                    placeholder="crsr_..."
                    autoComplete="off"
                    aria-invalid={Boolean(keyError)}
                  />
                </label>
                {keyError ? (
                  <div className="mt-2 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                    {keyError}
                  </div>
                ) : null}
                <Button
                  type="submit"
                  size="sm"
                  className="mt-3 w-full justify-start"
                  disabled={!apiKey.trim() || savingKey}
                >
                  <GearSixIcon data-icon="inline-start" />
                  {savingKey ? "Saving..." : "Save Cursor key"}
                </Button>
              </form>
              <Button
                variant="destructive"
                size="sm"
                className="mt-3 w-full justify-start"
                onClick={() => void handleForgetKey()}
                disabled={forgetting || !session.hasCursorApiKey}
              >
                <SignOutIcon data-icon="inline-start" />
                {forgetting ? "Forgetting..." : "Forget Cursor key"}
              </Button>
            </aside>

            <div className="min-w-0">
              <RoutingPanel
                repos={repos}
                reposError={reposError}
                reposLoading={reposLoading}
                canManage={canManageRouting}
                onRefresh={onRefreshRepos}
              />
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}

function LoadingScreen({ error }: { error?: string | null }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>Loading NEST</CardTitle>
          <CardDescription>Starting the workspace.</CardDescription>
        </CardHeader>
        {error ? (
          <CardContent>
            <div className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {error}
            </div>
          </CardContent>
        ) : null}
      </Card>
    </div>
  )
}

function BoardColumn({
  title,
  icon: Icon,
  agents,
  onSelect,
}: {
  title: string
  icon: IconComponent
  agents: AgentCard[]
  onSelect?: (agent: AgentCard) => void
}) {
  return (
    <section className="flex w-80 shrink-0 flex-col rounded-xl bg-muted/20">
      <header className="flex items-center justify-between px-3 py-2">
        <div className="flex items-center gap-2">
          <Icon aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />
          <h2 className="truncate text-sm font-medium">{title}</h2>
        </div>
        <Badge variant="secondary">{agents.length}</Badge>
      </header>
      <div className="flex flex-col gap-2 p-2">
        {agents.map((agent) => (
          <AgentCardPreview key={agent.id} agent={agent} onSelect={onSelect} />
        ))}
      </div>
    </section>
  )
}

/**
 * SDMs view: one column per chaos repo (in sources.yaml order), populated
 * with the active agents whose repository matches. Empty repo columns
 * are kept visible so it's obvious which repos have nothing in flight.
 * Anything unmatched falls into a dashed "Other" column rather than being
 * silently dropped.
 */
function SdmsBoardColumns({
  repos,
  reposError,
  agents,
  repositoryOptions,
  canCreateAgents,
  onSelect,
  onCreateForRepo,
}: {
  repos: Repo[]
  reposError: string | null
  agents: AgentCard[]
  repositoryOptions: RepositoryOption[]
  canCreateAgents: boolean
  onSelect: (a: AgentCard) => void
  onCreateForRepo: (repo: Repo) => void
}) {
  if (reposError && repos.length === 0) {
    return (
      <div className="m-4 flex-1 self-start rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
        <div className="font-medium">Could not load repo list</div>
        <div className="mt-0.5 text-xs opacity-80">{reposError}</div>
      </div>
    )
  }
  if (repos.length === 0) {
    return (
      <div className="m-4 text-sm text-muted-foreground">
        No repositories yet. Add one in{" "}
        <span className="font-medium">Settings</span>.
      </div>
    )
  }

  const buckets = new Map<string, AgentCard[]>()
  for (const r of repos) buckets.set(`${r.owner}/${r.name}`, [])
  const other: AgentCard[] = []
  for (const a of agents) {
    const r = repos.find((rp) => repoMatchesAgent(rp, a))
    if (r) buckets.get(`${r.owner}/${r.name}`)!.push(a)
    else other.push(a)
  }

  return (
    <>
      {repos.map((repo) => {
        const linkable =
          repositoryOptions.length === 0 ||
          findRepositoryOption(repo, repositoryOptions) !== null
        return (
          <SdmsRepoColumn
            key={`${repo.owner}/${repo.name}`}
            repo={repo}
            agents={buckets.get(`${repo.owner}/${repo.name}`) ?? []}
            onSelect={onSelect}
            onCreate={
              canCreateAgents && linkable ? () => onCreateForRepo(repo) : undefined
            }
          />
        )
      })}
      {other.length > 0 ? (
        <SdmsOtherColumn agents={other} onSelect={onSelect} />
      ) : null}
    </>
  )
}

function SdmsRepoColumn({
  repo,
  agents,
  onSelect,
  onCreate,
}: {
  repo: Repo
  agents: AgentCard[]
  onSelect: (a: AgentCard) => void
  onCreate?: () => void
}) {
  return (
    <section className="flex w-80 shrink-0 flex-col rounded-xl bg-muted/20">
      <header className="flex items-center justify-between gap-2 px-3 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <KanbanIcon
            aria-hidden="true"
            className="size-3.5 shrink-0 text-muted-foreground"
          />
          <h2
            className="truncate text-sm font-medium"
            title={`${repo.owner}/${repo.name}`}
          >
            {repo.name}
          </h2>
          {repo.jira_project_key ? (
            <span
              className="rounded bg-background/80 px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground"
              title={`Jira project ${repo.jira_project_key}`}
            >
              {repo.jira_project_key}
            </span>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Badge variant="secondary">{agents.length}</Badge>
          {onCreate ? (
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={onCreate}
              aria-label={`New agent for ${repo.owner}/${repo.name}`}
              title={`New agent for ${repo.owner}/${repo.name}`}
            >
              <PlusIcon />
            </Button>
          ) : null}
        </div>
      </header>
      <div className="flex flex-col gap-2 p-2">
        {agents.length === 0 ? (
          <p className="px-1 py-3 text-center text-[11px] italic text-muted-foreground/70">
            no active agents
          </p>
        ) : (
          agents.map((a) => (
            <AgentCardPreview key={a.id} agent={a} onSelect={onSelect} />
          ))
        )}
      </div>
    </section>
  )
}

function SdmsOtherColumn({
  agents,
  onSelect,
}: {
  agents: AgentCard[]
  onSelect: (a: AgentCard) => void
}) {
  return (
    <section className="flex w-80 shrink-0 flex-col rounded-xl border border-dashed bg-muted/10">
      <header className="flex items-center justify-between gap-2 px-3 py-2">
        <div className="flex items-center gap-2">
          <GitBranchIcon
            aria-hidden="true"
            className="size-3.5 shrink-0 text-muted-foreground"
          />
          <h2 className="truncate text-sm font-medium">Other</h2>
          <span className="text-[11px] text-muted-foreground">
            not configured
          </span>
        </div>
        <Badge variant="outline">{agents.length}</Badge>
      </header>
      <div className="flex flex-col gap-2 p-2">
        {agents.map((a) => (
          <AgentCardPreview key={a.id} agent={a} onSelect={onSelect} />
        ))}
      </div>
    </section>
  )
}

/**
 * Repository management — owns both the SDMs column source AND the
 * jira-project-key → repo routing the bridge consumes for webhook spawn.
 * One repo can carry an optional jira_project_key; setting it makes the
 * row "active routing" (webhooks for that project go to this repo).
 */
function RoutingPanel({
  repos,
  reposError,
  reposLoading,
  canManage,
  onRefresh,
}: {
  repos: Repo[]
  reposError: string | null
  reposLoading: boolean
  canManage: boolean
  onRefresh: () => Promise<void>
}) {
  const [actionError, setActionError] = React.useState<string | null>(null)

  const onUpsert = async (input: {
    id?: number
    url: string
    jira_project_key: string | null
    description: string | null
  }) => {
    setActionError(null)
    const path = input.id ? `/api/repos/${input.id}` : "/api/repos"
    const method = input.id ? "PUT" : "POST"
    const resp = await fetch(path, {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        url: input.url,
        jira_project_key: input.jira_project_key,
        description: input.description,
      }),
    })
    const json = (await resp.json().catch(() => null)) as
      | { error?: string }
      | null
    if (!resp.ok) {
      setActionError(json?.error ?? `HTTP ${resp.status}`)
      return false
    }
    await onRefresh()
    return true
  }

  const onDelete = async (id: number) => {
    setActionError(null)
    const resp = await fetch(`/api/repos/${id}`, { method: "DELETE" })
    if (!resp.ok) {
      const json = (await resp.json().catch(() => null)) as
        | { error?: string }
        | null
      setActionError(json?.error ?? `HTTP ${resp.status}`)
      return
    }
    await onRefresh()
  }

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-5 px-6 py-8">
      <div>
        <h2 className="text-lg font-semibold tracking-tight">Repositories</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          The canonical list NEST uses for SDM kanban columns and Jira
          webhook routing. Set a Jira project key on a repo to make Cursor
          agents for tickets in that project spawn against this repo.
          Tickets in unmapped projects fall back to the bridge&apos;s{" "}
          <code className="font-mono text-foreground">TARGET_REPO_URL</code>.
        </p>
      </div>

      {reposError ? (
        <div className="rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          <div className="font-medium">Bridge unreachable</div>
          <div className="mt-0.5 text-xs opacity-80">{reposError}</div>
          <Button
            variant="outline"
            size="xs"
            className="mt-2"
            onClick={() => void onRefresh()}
          >
            retry
          </Button>
        </div>
      ) : null}

      {actionError ? (
        <div className="rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          {actionError}
        </div>
      ) : null}

      {canManage ? (
        <AddRepoCard onSubmit={onUpsert} />
      ) : (
        <div className="rounded-lg border bg-muted/30 px-4 py-3 text-sm text-muted-foreground">
          Admin access is required to add, edit, or delete repository routing.
        </div>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Configured repositories</CardTitle>
          <CardDescription>
            {reposLoading && repos.length === 0
              ? "loading…"
              : `${repos.length} configured · ${repos.filter((r) => r.jira_project_key).length} with Jira routing`}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-2">
          {repos.length === 0 && !reposLoading ? (
            <p className="text-sm text-muted-foreground">
              Nothing yet. Add a repo above to get it into the SDMs board
              and (optionally) wire up Jira routing.
            </p>
          ) : null}
          {repos.map((r) => (
            <RepoRow
              key={r.id}
              repo={r}
              onSubmit={(patch) =>
                onUpsert({
                  id: r.id,
                  url: patch.url,
                  jira_project_key: patch.jira_project_key,
                  description: patch.description,
                })
              }
              onDelete={() => onDelete(r.id)}
              canManage={canManage}
            />
          ))}
        </CardContent>
      </Card>
    </div>
  )
}

function AddRepoCard({
  onSubmit,
}: {
  onSubmit: (input: {
    url: string
    jira_project_key: string | null
    description: string | null
  }) => Promise<boolean>
}) {
  const [url, setUrl] = React.useState("")
  const [jiraKey, setJiraKey] = React.useState("")
  const [description, setDescription] = React.useState("")
  const [submitting, setSubmitting] = React.useState(false)

  const canSubmit = url.trim().length > 0 && !submitting

  const handle = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!canSubmit) return
    setSubmitting(true)
    const ok = await onSubmit({
      url: url.trim(),
      jira_project_key: jiraKey.trim() || null,
      description: description.trim() || null,
    })
    setSubmitting(false)
    if (ok) {
      setUrl("")
      setJiraKey("")
      setDescription("")
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Add a repository</CardTitle>
        <CardDescription>
          Paste a GitHub URL. Add a Jira project key if you want webhook
          tickets in that project to spawn agents against this repo.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={handle} className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-medium text-muted-foreground">
              GitHub URL
            </label>
            <Input
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://github.com/reasoningco/ChefOS"
              className="font-mono text-sm"
              required
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="flex flex-col gap-1.5">
              <label className="text-xs font-medium text-muted-foreground">
                Jira project key (optional)
              </label>
              <Input
                value={jiraKey}
                onChange={(e) => setJiraKey(e.target.value.toUpperCase())}
                placeholder="DEV"
                className="font-mono text-sm uppercase"
                maxLength={16}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <label className="text-xs font-medium text-muted-foreground">
                Description (optional)
              </label>
              <Input
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Backend services"
                className="text-sm"
              />
            </div>
          </div>
        </form>
      </CardContent>
      <CardFooter className="justify-end">
        <Button
          size="sm"
          onClick={handle}
          disabled={!canSubmit}
        >
          <PlusIcon data-icon="inline-start" />
          {submitting ? "Adding…" : "Add repository"}
        </Button>
      </CardFooter>
    </Card>
  )
}

function RepoRow({
  repo,
  onSubmit,
  onDelete,
  canManage,
}: {
  repo: Repo
  onSubmit: (input: {
    url: string
    jira_project_key: string | null
    description: string | null
  }) => Promise<boolean>
  onDelete: () => void
  canManage: boolean
}) {
  const [editing, setEditing] = React.useState(false)
  const [jiraKey, setJiraKey] = React.useState(repo.jira_project_key ?? "")
  const [description, setDescription] = React.useState(repo.description ?? "")
  const [saving, setSaving] = React.useState(false)

  React.useEffect(() => {
    if (!editing) {
      const id = window.setTimeout(() => {
        setJiraKey(repo.jira_project_key ?? "")
        setDescription(repo.description ?? "")
      }, 0)
      return () => window.clearTimeout(id)
    }
  }, [repo.jira_project_key, repo.description, editing])

  const save = async () => {
    setSaving(true)
    const ok = await onSubmit({
      url: repo.url,
      jira_project_key: jiraKey.trim() || null,
      description: description.trim() || null,
    })
    setSaving(false)
    if (ok) setEditing(false)
  }

  return (
    <div className="rounded-lg border bg-background/40 px-3 py-2.5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <a
              href={repo.url}
              target="_blank"
              rel="noreferrer"
              className="truncate text-sm font-medium hover:underline"
            >
              {repo.owner}/{repo.name}
            </a>
            {repo.jira_project_key ? (
              <span
                className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground"
                title={`Jira project ${repo.jira_project_key}`}
              >
                {repo.jira_project_key}
              </span>
            ) : null}
          </div>
          {repo.description ? (
            <div className="mt-0.5 text-xs text-muted-foreground">
              {repo.description}
            </div>
          ) : null}
        </div>
        {canManage ? (
          <div className="flex shrink-0 items-center gap-1">
            {!editing ? (
              <Button
                variant="ghost"
                size="xs"
                onClick={() => setEditing(true)}
              >
                edit
              </Button>
            ) : null}
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Delete"
              title="Delete"
              onClick={onDelete}
            >
              <XIcon />
            </Button>
          </div>
        ) : null}
      </div>

      {editing ? (
        <div className="mt-3 grid grid-cols-2 gap-3">
          <div className="flex flex-col gap-1">
            <label className="text-[10px] uppercase tracking-wide text-muted-foreground">
              Jira project key
            </label>
            <Input
              value={jiraKey}
              onChange={(e) => setJiraKey(e.target.value.toUpperCase())}
              placeholder="—"
              className="h-8 font-mono text-xs uppercase"
              maxLength={16}
            />
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-[10px] uppercase tracking-wide text-muted-foreground">
              Description
            </label>
            <Input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="—"
              className="h-8 text-xs"
            />
          </div>
          <div className="col-span-2 flex justify-end gap-2">
            <Button
              variant="ghost"
              size="xs"
              onClick={() => setEditing(false)}
            >
              cancel
            </Button>
            <Button size="xs" onClick={save} disabled={saving}>
              {saving ? "saving…" : "save"}
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  )
}

function BoardLoadingSkeleton() {
  return (
    <div
      role="status"
      aria-live="polite"
      aria-label="Loading cloud agents"
      className="flex min-h-[60vh] flex-1 gap-3"
    >
      <span className="sr-only">Loading cloud agents</span>
      {boardLoadingColumns.map((column) => {
        const Icon = column.icon

        return (
          <section
            key={column.id}
            className="flex w-80 shrink-0 flex-col rounded-xl border bg-muted/20 shadow-sm"
          >
            <header className="flex items-center justify-between px-3 py-2">
              <div className="flex min-w-0 items-center gap-2">
                <span className="flex size-5 items-center justify-center rounded-md bg-background/70 text-muted-foreground">
                  <Icon aria-hidden="true" className="size-3.5" />
                </span>
                <div
                  className="h-3 w-20 animate-pulse rounded-full bg-muted"
                  aria-hidden="true"
                />
              </div>
              <div
                className="h-5 w-8 animate-pulse rounded-full bg-background/80 ring-1 ring-border/60"
                aria-hidden="true"
              />
            </header>
            <div className="flex flex-col gap-2 p-2">
              {Array.from({ length: column.cards }).map((_, cardIndex) => {
                const [titleWidth, metaWidth] =
                  loadingCardLineWidths[cardIndex % loadingCardLineWidths.length]

                return (
                  <Card
                    key={`${column.id}-${cardIndex}`}
                    size="sm"
                    className="gap-3 bg-card/70 ring-border/60"
                  >
                    <CardHeader className="gap-2">
                      <div className="flex items-start justify-between gap-3">
                        <div className="flex min-w-0 flex-1 flex-col gap-2">
                          <div
                            className={cn(
                              "h-3 animate-pulse rounded-full bg-muted",
                              titleWidth
                            )}
                            aria-hidden="true"
                          />
                          <div
                            className="h-3 w-7/12 animate-pulse rounded-full bg-muted/70"
                            aria-hidden="true"
                          />
                        </div>
                        <div
                          className="h-5 w-16 animate-pulse rounded-full bg-muted/80"
                          aria-hidden="true"
                        />
                      </div>
                      <div className="flex items-center gap-1.5">
                        <div
                          className="size-3.5 animate-pulse rounded-full bg-muted"
                          aria-hidden="true"
                        />
                        <div
                          className={cn(
                            "h-2.5 animate-pulse rounded-full bg-muted",
                            metaWidth
                          )}
                          aria-hidden="true"
                        />
                      </div>
                    </CardHeader>
                    {cardIndex === 0 ? (
                      <CardContent className="flex flex-col gap-2">
                        <div
                          className="h-2.5 w-full animate-pulse rounded-full bg-muted/70"
                          aria-hidden="true"
                        />
                        <div
                          className="h-2.5 w-9/12 animate-pulse rounded-full bg-muted/60"
                          aria-hidden="true"
                        />
                      </CardContent>
                    ) : null}
                    <CardFooter className="flex-wrap justify-between gap-2 border-t-0 bg-transparent">
                      <div
                        className="h-2.5 w-12 animate-pulse rounded-full bg-muted"
                        aria-hidden="true"
                      />
                      <div
                        className="h-2.5 w-8 animate-pulse rounded-full bg-muted/70"
                        aria-hidden="true"
                      />
                    </CardFooter>
                  </Card>
                )
              })}
            </div>
          </section>
        )
      })}
    </div>
  )
}

function GroupOptionContent({ option }: { option: SelectableGroupOption }) {
  const Icon = option.icon

  return (
    <span className="flex min-w-0 items-center gap-2">
      <Icon aria-hidden="true" className="shrink-0 text-muted-foreground" />
      <span className="truncate">{groupOptionLabel(option)}</span>
    </span>
  )
}

function AgentCardPreview({
  agent,
  onSelect,
}: {
  agent: AgentCard
  onSelect?: (agent: AgentCard) => void
}) {
  const previewArtifact = getPreviewArtifact(agent.artifacts)
  const hasCardContent = Boolean(agent.latestMessage || previewArtifact)

  return (
    <Card
      size="sm"
      role={onSelect ? "button" : undefined}
      tabIndex={onSelect ? 0 : undefined}
      onClick={onSelect ? () => onSelect(agent) : undefined}
      onKeyDown={
        onSelect
          ? (e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault()
                onSelect(agent)
              }
            }
          : undefined
      }
      className="cursor-pointer gap-3 bg-card/70 ring-border/60 transition-colors hover:bg-card/90 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <CardHeader className="gap-2">
        <div className="flex items-start justify-between gap-3">
          <CardTitle className="line-clamp-2">{agent.title}</CardTitle>
          <StatusBadge status={agent.status} />
        </div>
        <CardDescription className="flex items-center gap-1.5 truncate text-xs">
          <GitBranchIcon aria-hidden="true" className="size-3.5 shrink-0" />
          <span className="truncate">{agent.repository}</span>
        </CardDescription>
      </CardHeader>
      {hasCardContent ? (
        <CardContent className="flex flex-col gap-3">
          {agent.latestMessage ? (
            <p className="line-clamp-2 text-sm text-muted-foreground">
              {agent.latestMessage}
            </p>
          ) : null}
          {previewArtifact ? <ArtifactTile artifact={previewArtifact} /> : null}
        </CardContent>
      ) : null}
      <CardFooter className="flex-wrap justify-between gap-2 border-t-0 bg-transparent text-xs text-muted-foreground">
        <span>{formatRelativeTime(agent.updatedAt ?? agent.createdAt)}</span>
        {agent.prUrl ? (
          <a
            href={agent.prUrl}
            target="_blank"
            rel="noreferrer"
            className="text-foreground underline-offset-4 hover:underline"
          >
            PR
          </a>
        ) : null}
      </CardFooter>
    </Card>
  )
}

function ArtifactTile({ artifact }: { artifact: AgentCard["artifacts"][number] }) {
  if (artifact.previewKind === "video" && artifact.mediaUrl) {
    return (
      <div className="overflow-hidden rounded-lg bg-muted">
        <video
          src={artifact.mediaUrl}
          className="aspect-video w-full object-cover"
          muted
          loop
          playsInline
          controls
          preload="metadata"
        >
          {artifact.name}
        </video>
      </div>
    )
  }

  if (artifact.previewKind === "video") {
    return (
      <div className="flex min-w-0 items-center gap-2 rounded-lg bg-muted/40 p-2 text-xs">
        <PlayIcon
          aria-hidden="true"
          className="size-3.5 shrink-0 text-muted-foreground"
        />
        <span className="truncate">{artifact.name}</span>
      </div>
    )
  }

  if (artifact.previewKind === "image" && artifact.mediaUrl) {
    return (
      <a
        href={artifact.mediaUrl}
        target="_blank"
        rel="noreferrer"
        className="group overflow-hidden rounded-lg bg-muted"
      >
        {/* eslint-disable-next-line @next/next/no-img-element -- artifact media is served through an authenticated app route. */}
        <img
          src={artifact.mediaUrl}
          alt={artifact.name}
          className="aspect-video w-full object-cover transition-transform group-hover:scale-105"
        />
      </a>
    )
  }

  return (
    <div className="flex min-w-0 items-center gap-2 rounded-lg bg-muted/40 p-2 text-xs">
      <FileIcon
        aria-hidden="true"
        className="size-3.5 shrink-0 text-muted-foreground"
      />
      <span className="truncate">{artifact.name}</span>
    </div>
  )
}

function CreateAgentDialog({
  sessionId,
  hasCursorApiKey,
  repositories,
  models,
  initialRepositoryId,
  onClose,
  onCreated,
}: {
  sessionId: string
  hasCursorApiKey: boolean
  repositories: RepositoryOption[]
  models: ModelOption[]
  initialRepositoryId?: string
  onClose: () => void
  onCreated: (agent: AgentCard) => Promise<void>
}) {
  const [name, setName] = React.useState("")
  const [prompt, setPrompt] = React.useState("")
  const [runtime, setRuntime] = React.useState<AgentRuntime>(
    hasCursorApiKey ? "cursor" : "jetson",
  )
  const [repositoryId, setRepositoryId] = React.useState(
    initialRepositoryId ?? repositories[0]?.id ?? "",
  )
  const [modelId, setModelId] = React.useState(models[0]?.id ?? "")
  const [branch, setBranch] = React.useState("")
  const [autoCreatePR, setAutoCreatePR] = React.useState(true)
  const [isSubmitting, setIsSubmitting] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const selectedRepositoryId = repositoryId || repositories[0]?.id || ""
  const selectedRepository = repositories.find(
    (repository) => repository.id === selectedRepositoryId,
  )
  const hasModels = models.length > 0
  const selectedModelId = modelId || models[0]?.id || ""
  const isJetsonRuntime = runtime === "jetson"
  const canSubmit =
    prompt.trim().length > 0 &&
    !isSubmitting &&
    (isJetsonRuntime || Boolean(selectedRepositoryId))

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setIsSubmitting(true)
    setError(null)
    try {
      const response = await apiFetch<CreateAgentResponse>(
        isJetsonRuntime ? "/api/jetson-agent/launch" : "/api/agents",
        sessionId,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            runtime,
            name,
            prompt,
            repositoryId: selectedRepositoryId,
            repositoryLabel: selectedRepository?.label,
            repositoryUrl: selectedRepository?.url,
            ...(hasModels && selectedModelId && !isJetsonRuntime
              ? { modelId: selectedModelId }
              : {}),
            branch,
            autoCreatePR: isJetsonRuntime ? false : autoCreatePR,
          }),
        },
      )
      await onCreated(response.agent)
      onClose()
    } catch (submitError) {
      setError(errorMessage(submitError, "Failed to create an agent."))
    } finally {
      setIsSubmitting(false)
    }
  }

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-background/80 p-4 backdrop-blur-sm">
      <Card
        role="dialog"
        aria-modal="true"
        aria-labelledby="create-agent-title"
        className="max-h-[90vh] w-full max-w-2xl shadow-2xl"
      >
        <CardHeader className="border-b">
          <div className="flex items-start justify-between gap-4">
            <div>
              <CardTitle id="create-agent-title">Create agent</CardTitle>
              <CardDescription>
                Start a Cursor Cloud Agent or Jetson agent from a prompt.
              </CardDescription>
            </div>
            <Button variant="ghost" size="icon-sm" onClick={onClose} aria-label="Close">
              <XIcon />
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          <form className="flex flex-col gap-4" onSubmit={handleSubmit}>
            <label className="flex flex-col gap-2 text-sm font-medium">
              Title
              <Input
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="Triage checkout bug"
              />
            </label>

            <label className="flex flex-col gap-2 text-sm font-medium">
              Runtime
              <Select
                items={[
                  { label: "Cursor Cloud", value: "cursor" },
                  { label: "Jetson", value: "jetson" },
                ]}
                value={runtime}
                onValueChange={(value) => {
                  if (value === "cursor" || value === "jetson") {
                    setRuntime(value)
                  }
                }}
              >
                <SelectTrigger aria-label="Agent runtime" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent align="start">
                  <SelectGroup>
                    <SelectItem value="cursor" disabled={!hasCursorApiKey}>
                      Cursor Cloud
                    </SelectItem>
                    <SelectItem value="jetson">Jetson</SelectItem>
                  </SelectGroup>
                </SelectContent>
              </Select>
            </label>

            <div
              className={cn(
                "grid gap-4",
                hasModels && !isJetsonRuntime && "md:grid-cols-2",
              )}
            >
              <label className="flex flex-col gap-2 text-sm font-medium">
                Repository
                <Select
                  items={repositories.map((repository) => ({
                    label: repository.label,
                    value: repository.id,
                  }))}
                  value={selectedRepositoryId}
                  onValueChange={(value) => {
                    if (value) {
                      setRepositoryId(value)
                    }
                  }}
                >
                  <SelectTrigger
                    aria-label="Repository"
                    className="w-full"
                    disabled={repositories.length === 0}
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent align="start">
                    <SelectGroup>
                      {repositories.map((repository) => (
                        <SelectItem key={repository.id} value={repository.id}>
                          {repository.label}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
              </label>

              {hasModels && !isJetsonRuntime ? (
                <label className="flex flex-col gap-2 text-sm font-medium">
                  Model
                  <Select
                    items={models.map((model) => ({
                      label: model.label,
                      value: model.id,
                    }))}
                    value={selectedModelId}
                    onValueChange={(value) => {
                      if (value) {
                        setModelId(value)
                      }
                    }}
                  >
                    <SelectTrigger aria-label="Model" className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent align="start">
                      <SelectGroup>
                        {models.map((model) => (
                          <SelectItem key={model.id} value={model.id}>
                            {model.label}
                          </SelectItem>
                        ))}
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                </label>
              ) : null}
            </div>

            <label className="flex flex-col gap-2 text-sm font-medium">
              Branch or starting ref
              <Input
                value={branch}
                onChange={(event) => setBranch(event.target.value)}
                placeholder="main"
              />
            </label>

            <label className="flex flex-col gap-2 text-sm font-medium">
              Prompt
              <Textarea
                value={prompt}
                onChange={(event) => setPrompt(event.target.value)}
                placeholder="Ask the agent to investigate, implement, or review..."
                className="min-h-32"
                required
              />
            </label>

            {!isJetsonRuntime ? (
              <label className="flex items-center gap-2 text-sm text-muted-foreground">
                <input
                  type="checkbox"
                  className="size-4 accent-primary"
                  checked={autoCreatePR}
                  onChange={(event) => setAutoCreatePR(event.target.checked)}
                />
                Auto-create a pull request when the agent completes
              </label>
            ) : null}

            {!hasCursorApiKey && !isJetsonRuntime ? (
              <div className="rounded-lg border bg-muted/40 px-3 py-2 text-sm text-muted-foreground">
                Add a Cursor API key in Settings before creating Cursor Cloud
                agents.
              </div>
            ) : repositories.length === 0 && !isJetsonRuntime ? (
              <div className="rounded-lg border bg-muted/40 px-3 py-2 text-sm text-muted-foreground">
                No repositories were returned by the SDK. Check your Cursor and
                GitHub integration permissions.
              </div>
            ) : null}

            {error ? (
              <div className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                {error}
              </div>
            ) : null}

            <div className="flex justify-end gap-2">
              <Button type="button" variant="ghost" onClick={onClose}>
                Cancel
              </Button>
              <Button
                type="submit"
                disabled={!canSubmit}
              >
                {isSubmitting
                  ? "Creating..."
                  : isJetsonRuntime
                    ? "Create Jetson agent"
                    : "Create agent"}
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  )
}

function SidebarItem({
  active,
  collapsed = false,
  count,
  icon: Icon,
  label,
  onSelect,
}: {
  active: boolean
  collapsed?: boolean
  count?: number
  icon: IconComponent
  label: string
  onSelect: () => void
}) {
  const showCount = typeof count === "number"
  return (
    <button
      type="button"
      aria-pressed={active}
      aria-label={collapsed && showCount ? `${label}: ${count}` : collapsed ? label : undefined}
      onClick={onSelect}
      title={collapsed && showCount ? `${label}: ${count}` : collapsed ? label : undefined}
      className={cn(
        "relative flex w-full items-center gap-2 rounded-lg text-muted-foreground transition-colors outline-none hover:bg-sidebar-accent/70 hover:text-sidebar-accent-foreground focus-visible:ring-2 focus-visible:ring-ring [&_svg]:size-4 [&_svg]:shrink-0",
        collapsed ? "size-11 justify-center p-0" : "px-2 py-1.5 text-left",
        active && "bg-sidebar-accent text-sidebar-accent-foreground"
      )}
    >
      <Icon aria-hidden="true" />
      {collapsed ? (
        showCount ? (
          <Badge
            variant={active ? "secondary" : "outline"}
            className="absolute -right-1 -top-1 h-4 min-w-4 px-1 text-[0.65rem]"
          >
            {count}
          </Badge>
        ) : null
      ) : (
        <>
          <span className="min-w-0 flex-1 truncate">{label}</span>
          {showCount ? (
            <Badge variant={active ? "secondary" : "outline"}>{count}</Badge>
          ) : null}
        </>
      )}
    </button>
  )
}

function EmptyBoard({
  canCreateAgents,
  onCreate,
}: {
  canCreateAgents: boolean
  onCreate: () => void
}) {
  return (
    <div className="flex min-h-[50vh] flex-1 items-center justify-center">
      <Card className="w-full max-w-md text-center">
        <CardHeader>
          <CardTitle>No agents found</CardTitle>
          <CardDescription>
            {canCreateAgents
              ? "Create a cloud agent or adjust your search to populate the board."
              : "Operator access is required to create cloud agents."}
          </CardDescription>
        </CardHeader>
        {canCreateAgents ? (
          <CardContent>
            <Button onClick={onCreate}>
              <PlusIcon data-icon="inline-start" />
              New agent
            </Button>
          </CardContent>
        ) : null}
      </Card>
    </div>
  )
}

function StatusBadge({ status }: { status: string }) {
  const normalized = status.toLowerCase()
  const variant =
    normalized.includes("fail") || normalized.includes("error")
      ? "destructive"
      : normalized.includes("complete") || normalized.includes("done")
        ? "secondary"
        : normalized === "no_status"
          ? "ghost"
        : "outline"

  return <Badge variant={variant}>{formatStatusLabel(status)}</Badge>
}

function groupAgents(agents: AgentCard[], groupBy: GroupBy) {
  const groups = new Map<string, AgentCard[]>()

  for (const agent of agents) {
    const title = groupTitle(agent, groupBy)
    const group = groups.get(title) ?? []
    group.push(agent)
    groups.set(title, group)
  }

  const entries = Array.from(groups.entries())
  if (groupBy === "createdAt") {
    entries.sort(
      ([leftTitle], [rightTitle]) => dateBucketRank(leftTitle) - dateBucketRank(rightTitle)
    )
  }

  return entries.map(([title, group]) => ({
    id: `${groupBy}-${title}`,
    title,
    agents: group,
  }))
}

function dateBucketRank(title: string) {
  return dateBucketOrder.get(title) ?? dateBucketOrder.size
}

function groupTitle(agent: AgentCard, groupBy: GroupBy) {
  if (groupBy === "createdAt") {
    return dateBucket(agent.createdAt)
  }

  const value = agent[groupBy]
  if (groupBy === "status" && typeof value === "string" && value.trim()) {
    return formatStatusLabel(value)
  }

  return typeof value === "string" && value.trim() ? value : "Unassigned"
}

function searchAgents(agents: AgentCard[], query: string) {
  const normalizedQuery = query.trim().toLowerCase()
  if (!normalizedQuery) {
    return agents
  }

  return agents.filter((agent) =>
    [
      agent.title,
      agent.status,
      agent.repository,
      agent.branch,
      agent.createdBy,
      agent.latestMessage,
    ]
      .filter(Boolean)
      .some((value) => value?.toLowerCase().includes(normalizedQuery))
  )
}

function filterAgentsBySidebar(agents: AgentCard[], filter: SidebarFilter) {
  if (filter === "sdms") {
    return agents.filter((agent) => isAgentActive(agent.status))
  }

  return agents
}

function getPreviewArtifact(artifacts: AgentCard["artifacts"]) {
  return (
    artifacts.find((artifact) => artifact.previewKind === "video") ??
    artifacts[0] ??
    null
  )
}

async function apiFetch<T>(
  input: string,
  sessionId: string,
  init: RequestInit = {}
): Promise<T> {
  return fetchJson<T>(input, {
    ...init,
    headers: {
      ...init.headers,
      "x-agent-kanban-session": sessionId,
    },
  })
}

async function fetchJson<T>(input: string, init?: RequestInit): Promise<T> {
  const response = await fetch(input, init)
  const payload = (await response.json().catch(() => ({}))) as ApiError

  if (!response.ok) {
    throw new Error(payload.error ?? `Request failed with ${response.status}.`)
  }

  return payload as T
}

function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback
}

function getSelectableGroupOptions(agents: AgentCard[]): SelectableGroupOption[] {
  return groupOptions.map((option) => {
    const requiredField = option.requiresData

    return {
      ...option,
      selectable:
        agents.length === 0 ||
        !requiredField ||
        agents.some((agent) => hasAgentValue(agent, requiredField)),
    }
  })
}

function hasAgentValue(agent: AgentCard, field: keyof AgentCard) {
  const value = agent[field]
  if (typeof value === "string") {
    return Boolean(value.trim())
  }

  return value !== undefined && value !== null
}

function groupOptionLabel(option: SelectableGroupOption) {
  return option.selectable ? option.label : `${option.label} (no data)`
}

function isSelectableGroupBy(
  value: string | null,
  options: SelectableGroupOption[]
): value is GroupBy {
  return options.some((option) => option.id === value && option.selectable)
}

function titleCase(value: string) {
  return value
    .replace(/[_-]/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase())
}

function formatStatusLabel(value: string) {
  const normalized = value.trim().toLowerCase()
  if (!normalized || normalized === "unknown" || normalized === "no_status") {
    return "No status"
  }

  return titleCase(value)
}

function dateBucket(value: string | undefined) {
  if (!value) {
    return "No date"
  }

  const date = new Date(value)
  if (Number.isNaN(date.getTime())) {
    return "No date"
  }

  const now = new Date()
  const diffMs = now.getTime() - date.getTime()
  const diffDays = Math.floor(diffMs / 86_400_000)

  if (diffDays <= 0) {
    return "Today"
  }
  if (diffDays === 1) {
    return "Yesterday"
  }
  if (diffDays < 7) {
    return "This week"
  }
  if (diffDays < 30) {
    return "This month"
  }
  return "Older"
}

function formatRelativeTime(value: string | undefined) {
  if (!value) {
    return "No activity"
  }

  const date = new Date(value)
  if (Number.isNaN(date.getTime())) {
    return "No activity"
  }

  const diffMs = Date.now() - date.getTime()
  const minutes = Math.max(1, Math.floor(diffMs / 60_000))
  if (minutes < 60) {
    return `${minutes}m ago`
  }

  const hours = Math.floor(minutes / 60)
  if (hours < 24) {
    return `${hours}h ago`
  }

  const days = Math.floor(hours / 24)
  return `${days}d ago`
}
