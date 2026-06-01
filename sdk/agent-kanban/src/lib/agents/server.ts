import { randomUUID } from "node:crypto"
import { promises as fs } from "node:fs"
import os from "node:os"
import path from "node:path"

import { Agent, Cursor } from "@cursor/sdk"

import type {
  AppPermissions,
  AppRole,
  AgentCard,
  AgentListResponse,
  ArtifactPreview,
  CreateAgentInput,
  CreateAgentResponse,
  ModelOption,
  PublicSession,
  PublicUser,
  RepositoryOption,
} from "./types"
import { auditEvent, recordSdaLaunch } from "@/lib/nest-store"

type Settings = {
  cursorApiKey?: string
  cursorRole?: AppRole
  cursorUser?: PublicUser | null
}

export type Session = {
  id: string
  apiKey?: string
  role: AppRole
  user: PublicUser | null
}

type UnknownRecord = Record<string, unknown>

type SdkAgentLike = UnknownRecord & {
  id?: string
  send?: (prompt: string) => Promise<unknown>
  listArtifacts?: () => Promise<unknown>
  downloadArtifact?: (artifactPath: string) => Promise<unknown>
  [Symbol.asyncDispose]?: () => Promise<void>
}

type AgentNamespace = {
  list?: (options: UnknownRecord) => Promise<unknown>
  listRuns?: (agentId: string, options?: UnknownRecord) => Promise<unknown>
  create: (options: UnknownRecord) => Promise<SdkAgentLike>
  get?: (id: string, options?: UnknownRecord) => Promise<unknown>
  resume?: (id: string, options?: UnknownRecord) => Promise<SdkAgentLike>
}

type CursorNamespace = typeof Cursor & {
  repositories?: {
    list: (options: UnknownRecord) => Promise<unknown>
  }
}

type RepositoryCacheEntry = {
  loadedAt: number
  repositories: RepositoryOption[]
  rawById: Map<string, unknown>
}

type ModelCacheEntry = {
  loadedAt: number
  models: ModelOption[]
}

type AgentListCacheEntry = {
  loadedAt: number
  response: AgentListResponse
}

type RunSummary = {
  id?: string
  status?: string
  createdAt?: string
  durationMs?: number
  result?: string
  branch?: string
  prUrl?: string
  repoUrl?: string
}

const settingsDir = path.join(os.homedir(), ".agent-kanban")
const settingsPath = path.join(settingsDir, "settings.json")
const agentListCacheTtlMs = 3 * 60_000
const repositoryCacheTtlMs = 30 * 60_000
const modelCacheTtlMs = 30 * 60_000

const globalForAgentKanban = globalThis as typeof globalThis & {
  __agentKanbanSessions?: Map<string, Session>
  __agentKanbanAgentListCache?: Map<string, AgentListCacheEntry>
  __agentKanbanRepositoryCache?: Map<string, RepositoryCacheEntry>
  __agentKanbanModelCache?: Map<string, ModelCacheEntry>
}

const sessions =
  globalForAgentKanban.__agentKanbanSessions ?? new Map<string, Session>()
globalForAgentKanban.__agentKanbanSessions = sessions

const agentListCache =
  globalForAgentKanban.__agentKanbanAgentListCache ??
  new Map<string, AgentListCacheEntry>()
globalForAgentKanban.__agentKanbanAgentListCache = agentListCache

const repositoryCache =
  globalForAgentKanban.__agentKanbanRepositoryCache ??
  new Map<string, RepositoryCacheEntry>()
globalForAgentKanban.__agentKanbanRepositoryCache = repositoryCache

const modelCache =
  globalForAgentKanban.__agentKanbanModelCache ?? new Map<string, ModelCacheEntry>()
globalForAgentKanban.__agentKanbanModelCache = modelCache

const agentSdk = Agent as unknown as AgentNamespace
const cursorSdk = Cursor as CursorNamespace
const roleRank: Record<AppRole, number> = {
  viewer: 0,
  operator: 1,
  admin: 2,
}

export class MissingCursorApiKeyError extends Error {
  readonly code = "missing_api_key"

  constructor(message = "Enter a Cursor API key to continue.") {
    super(message)
    this.name = "MissingCursorApiKeyError"
  }
}

export class InvalidCursorApiKeyError extends Error {
  readonly code = "invalid_api_key"

  constructor(message = "The Cursor API key could not be validated.") {
    super(message)
    this.name = "InvalidCursorApiKeyError"
  }
}

export class UnknownSessionError extends Error {
  readonly code = "unknown_session"

  constructor(message = "This NEST session has expired.") {
    super(message)
    this.name = "UnknownSessionError"
  }
}

export class AuthorizationError extends Error {
  readonly code = "forbidden"

  constructor(message = "You do not have permission to perform this action.") {
    super(message)
    this.name = "AuthorizationError"
  }
}

export function publicSession(session: Session): PublicSession {
  return {
    id: session.id,
    user: session.user,
    hasCursorApiKey: Boolean(session.apiKey?.trim()),
    hasPersistedKey: false,
    role: session.role,
    permissions: permissionsForRole(session.role),
  }
}

export async function createSession(
  apiKey: string,
  remember: boolean
): Promise<PublicSession> {
  const trimmedKey = apiKey.trim()
  await validateCursorApiKey(trimmedKey)

  const user = await getCurrentUser(trimmedKey)
  const role = resolveRole(user)
  assertRole(role, "viewer")

  if (remember) {
    await writeSettings({
      cursorApiKey: trimmedKey,
      cursorRole: role,
      cursorUser: user,
    })
  }

  const session: Session = {
    id: randomUUID(),
    apiKey: trimmedKey,
    role,
    user,
  }
  sessions.set(session.id, session)
  auditEvent({
    actor: actorForSession(session),
    action: "session.create",
    resourceType: "session",
    resourceId: session.id,
    metadata: { remembered: remember },
  })

  return {
    ...publicSession(session),
    hasPersistedKey: remember,
  }
}

export async function restoreSession(sessionId?: string): Promise<PublicSession> {
  if (sessionId) {
    const existing = sessions.get(sessionId)
    if (existing) {
      return publicSession(existing)
    }
  }

  const settings = await readSettings()
  const storedApiKey = settings.cursorApiKey?.trim()
  const serverApiKey =
    process.env.NEST_CURSOR_API_KEY?.trim() || process.env.CURSOR_API_KEY?.trim()
  const persistedApiKey = storedApiKey || serverApiKey
  if (!persistedApiKey) {
    return publicSession(createLocalSession())
  }

  let user: PublicUser | null
  let role: AppRole
  try {
    await validateCursorApiKey(persistedApiKey)
    user = await getCurrentUser(persistedApiKey)
    role = resolveRole(user)
  } catch (error) {
    if (!isCursorRateLimitError(error)) {
      if (storedApiKey) {
        await writeSettings({
          ...settings,
          cursorApiKey: undefined,
          cursorUser: null,
          cursorRole: undefined,
        }).catch(() => undefined)
      }
      return publicSession(createLocalSession())
    }
    user = settings.cursorUser ?? null
    role = isAppRole(settings.cursorRole) ? settings.cursorRole : resolveRole(user)
  }
  assertRole(role, "viewer")

  if (storedApiKey) {
    await writeSettings({
      ...settings,
      cursorApiKey: persistedApiKey,
      cursorRole: role,
      cursorUser: user,
    }).catch(() => undefined)
  }

  const session: Session = {
    id: randomUUID(),
    apiKey: persistedApiKey,
    role,
    user,
  }
  sessions.set(session.id, session)
  auditEvent({
    actor: actorForSession(session),
    action: "session.restore",
    resourceType: "session",
    resourceId: session.id,
  })

  return {
    ...publicSession(session),
    hasPersistedKey: Boolean(storedApiKey),
  }
}

export async function clearPersistedKey() {
  await writeSettings({})
}

export async function requireSession(request: Request): Promise<Session> {
  const sessionId =
    request.headers.get("x-agent-kanban-session")?.trim() ??
    getCookie(request, "agent-kanban-session")?.trim()
  if (!sessionId) {
    const restored = await restoreSession()
    const restoredSession = sessions.get(restored.id)
    if (!restoredSession) {
      throw new UnknownSessionError()
    }
    return restoredSession
  }

  const session = sessions.get(sessionId)
  if (session) {
    return session
  }

  const restored = await restoreSession(sessionId)
  const restoredSession = sessions.get(restored.id)
  if (!restoredSession) {
    throw new UnknownSessionError()
  }

  return restoredSession
}

export async function requireRole(
  request: Request,
  minimumRole: AppRole
): Promise<Session> {
  const session = await requireSession(request)
  assertRole(session.role, minimumRole)
  return session
}

export function requireCursorApiKey(session: Session): string {
  const apiKey = session.apiKey?.trim()
  if (!apiKey) {
    throw new MissingCursorApiKeyError(
      "Set a Cursor API key in Settings to use Cursor Cloud."
    )
  }
  return apiKey
}

export function actorForSession(session: Session) {
  return {
    role: session.role,
    sessionId: session.id,
    userEmail: session.user?.email,
    userName: session.user?.name,
  }
}

function assertRole(actual: AppRole, minimum: AppRole) {
  if (roleRank[actual] < roleRank[minimum]) {
    throw new AuthorizationError(
      `This action requires ${minimum} access. Your role is ${actual}.`
    )
  }
}

function agentListCacheKey(
  apiKey: string,
  options: {
    cursor?: string
    includeArchived?: boolean
    limit?: number
    prUrl?: string
  },
  includeDetails: boolean
) {
  return JSON.stringify({
    apiKey,
    cursor: options.cursor ?? null,
    includeArchived: options.includeArchived ?? false,
    includeDetails,
    limit: options.limit ?? 50,
    prUrl: options.prUrl ?? null,
  })
}

function isCursorRateLimitError(error: unknown) {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : ""
  return /rate limit|requests per hour|too many requests/i.test(message)
}

function permissionsForRole(role: AppRole): AppPermissions {
  return {
    createAgents: roleRank[role] >= roleRank.operator,
    manageRouting: role === "admin",
    useJetsonAgent: roleRank[role] >= roleRank.operator,
    viewAgents: roleRank[role] >= roleRank.viewer,
  }
}

function createLocalSession(): Session {
  const session: Session = {
    id: randomUUID(),
    role: localSessionRole(),
    user: null,
  }
  sessions.set(session.id, session)
  auditEvent({
    actor: actorForSession(session),
    action: "session.local",
    resourceType: "session",
    resourceId: session.id,
  })
  return session
}

function localSessionRole(): AppRole {
  return envRole("NEST_LOCAL_ROLE", envRole("NEST_DEFAULT_ROLE", "operator"))
}

function resolveRole(user: PublicUser | null): AppRole {
  const email = user?.email?.trim().toLowerCase()
  const domain = email?.split("@")[1]
  const admins = envList("NEST_ADMIN_EMAILS")
  const operators = envList("NEST_OPERATOR_EMAILS")
  const viewers = envList("NEST_VIEWER_EMAILS")
  const allowedDomains = envList("NEST_ALLOWED_DOMAINS")
  const hasExplicitPolicy =
    admins.length > 0 ||
    operators.length > 0 ||
    viewers.length > 0 ||
    allowedDomains.length > 0

  if (email && admins.includes(email)) return "admin"
  if (email && operators.includes(email)) return "operator"
  if (email && viewers.includes(email)) return "viewer"

  if (domain && allowedDomains.includes(domain)) {
    return envRole("NEST_DEFAULT_ROLE", "operator")
  }

  // Keep existing single-user installs usable until the deployment defines
  // an explicit allowlist. Once any NEST_* RBAC env var is set, unknown
  // users are denied by assertRole below.
  if (!hasExplicitPolicy) {
    return "admin"
  }

  throw new AuthorizationError("This Cursor account is not allowed in NEST.")
}

function envList(name: string) {
  return (process.env[name] ?? "")
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean)
}

function envRole(name: string, fallback: AppRole): AppRole {
  const value = process.env[name]?.trim().toLowerCase()
  return value === "admin" || value === "operator" || value === "viewer"
    ? value
    : fallback
}

function isAppRole(value: unknown): value is AppRole {
  return value === "admin" || value === "operator" || value === "viewer"
}

function getCookie(request: Request, name: string) {
  const cookies = request.headers.get("cookie") ?? ""
  const prefix = `${name}=`
  const match = cookies
    .split(";")
    .map((cookie) => cookie.trim())
    .find((cookie) => cookie.startsWith(prefix))

  return match ? decodeURIComponent(match.slice(prefix.length)) : undefined
}

export async function listCloudAgents(
  apiKey: string,
  options: {
    cursor?: string
    includeDetails?: boolean
    includeArchived?: boolean
    limit?: number
    prUrl?: string
  } = {}
): Promise<AgentListResponse> {
  if (!agentSdk.list) {
    throw new Error("This version of @cursor/sdk does not support Agent.list.")
  }

  const includeDetails = options.includeDetails ?? false
  const cacheKey = agentListCacheKey(apiKey, options, includeDetails)
  const cached = agentListCache.get(cacheKey)
  if (cached && Date.now() - cached.loadedAt < agentListCacheTtlMs) {
    return cached.response
  }

  try {
    const response = await agentSdk.list({
      apiKey,
      runtime: "cloud",
      limit: options.limit ?? 50,
      cursor: options.cursor,
      prUrl: options.prUrl,
      includeArchived: options.includeArchived ?? false,
    })
    const rawAgents = extractArray(response, ["agents", "items", "data", "results"])

    let agents = rawAgents.map(normalizeAgent)
    if (includeDetails) {
      agents = await Promise.all(
        agents.map(async (card) => {
          const [runs, artifacts] = await Promise.all([
            listRunsForAgent(apiKey, card.id).catch(() => []),
            listArtifactsForAgent(apiKey, card.id).catch(() => []),
          ])
          enrichAgentCardFromRuns(card, runs)
          card.artifacts = artifacts
          return card
        })
      )
    }

    const normalizedResponse = {
      agents,
      nextCursor: firstString(asRecord(response), [
        "nextCursor",
        "next_cursor",
        "cursor",
      ]),
    }
    agentListCache.set(cacheKey, {
      loadedAt: Date.now(),
      response: normalizedResponse,
    })
    return normalizedResponse
  } catch (error) {
    if (cached) {
      return cached.response
    }
    if (isCursorRateLimitError(error)) {
      return { agents: [] }
    }
    throw error
  }
}

export async function createCloudAgent(
  apiKey: string,
  input: CreateAgentInput,
  actor?: ReturnType<typeof actorForSession>
): Promise<CreateAgentResponse> {
  const prompt = input.prompt.trim()
  if (!prompt) {
    throw new Error("A prompt is required to create a cloud agent.")
  }

  const repository = await resolveRepository(apiKey, input.repositoryId)
  const cloudRepository = {
    url: repository.url,
    ...(input.branch?.trim() ? { startingRef: input.branch.trim() } : {}),
  }

  const createdAgent = await agentSdk.create({
    apiKey,
    name: input.name?.trim() || prompt.slice(0, 80),
    ...(input.modelId && input.modelId !== "auto"
      ? { model: { id: input.modelId } }
      : {}),
    cloud: {
      repos: [cloudRepository],
      autoCreatePR: input.autoCreatePR ?? true,
    },
  })

  if (createdAgent.send) {
    await createdAgent.send(prompt)
  }

  const card = normalizeAgent(createdAgent)
  card.repository = repository.label
  card.repositoryUrl = repository.url
  card.branch = input.branch?.trim() || repository.defaultBranch
  card.latestMessage = prompt
  card.artifacts = await listArtifactsForAgent(apiKey, card.id).catch(() => [])
  auditEvent({
    actor,
    action: "agent.create",
    resourceType: "cursor_agent",
    resourceId: card.id,
    metadata: {
      branch: card.branch,
      modelId: input.modelId,
      repositoryId: input.repositoryId,
      sdaRoleId: input.sdaRoleId,
      sdmTaskId: input.sdmTaskId,
    },
  })
  if (input.sdmTaskId || input.sdaRoleId) {
    recordSdaLaunch({
      taskId: input.sdmTaskId,
      roleId: input.sdaRoleId,
      roleTitle: input.sdaRoleTitle,
      agentId: card.id,
      agentTitle: card.title,
      status: card.status,
    })
  }

  return { agent: card }
}

export async function listModels(apiKey: string): Promise<ModelOption[]> {
  const cached = modelCache.get(apiKey)
  if (cached && Date.now() - cached.loadedAt < modelCacheTtlMs) {
    return cached.models
  }

  try {
    const models = await Cursor.models.list({ apiKey })
    const normalized = extractArray(models, ["models", "items", "data"]).flatMap((model) => {
      const normalized = normalizeModel(model)
      return normalized ? [normalized] : []
    })
    modelCache.set(apiKey, { loadedAt: Date.now(), models: normalized })
    return normalized
  } catch {
    if (cached) {
      return cached.models
    }
    return []
  }
}

export async function listRepositories(
  apiKey: string
): Promise<RepositoryOption[]> {
  const cache = repositoryCache.get(apiKey)
  if (cache && Date.now() - cache.loadedAt < repositoryCacheTtlMs) {
    return cache.repositories
  }

  if (!cursorSdk.repositories?.list) {
    return []
  }

  try {
    const response = await cursorSdk.repositories.list({ apiKey })
    const rawRepositories = extractArray(response, [
      "repositories",
      "repos",
      "items",
      "data",
    ])
    const rawById = new Map<string, unknown>()
    const repositories = rawRepositories
      .map((rawRepository) => normalizeRepository(rawRepository))
      .filter((repository): repository is RepositoryOption => Boolean(repository))

    for (const repository of repositories) {
      rawById.set(repository.id, repository)
      rawById.set(repository.url, repository)
    }

    repositoryCache.set(apiKey, {
      loadedAt: Date.now(),
      repositories,
      rawById,
    })

    return repositories
  } catch (error) {
    if (cache) {
      return cache.repositories
    }
    if (isCursorRateLimitError(error)) {
      return []
    }
    throw error
  }
}

export async function listArtifactsForAgent(
  apiKey: string,
  agentId: string
): Promise<ArtifactPreview[]> {
  const agent = await attachAgent(apiKey, agentId)
  if (!agent.listArtifacts) {
    return []
  }

  const response = await agent.listArtifacts()
  const rawArtifacts = extractArray(response, [
    "artifacts",
    "items",
    "files",
    "data",
  ])

  const previews = rawArtifacts
    .map((rawArtifact) => withArtifactMediaUrl(agentId, normalizeArtifact(rawArtifact)))
    .sort(compareArtifactPreviews)
    .slice(0, 4)

  await disposeAgent(agent)
  return previews
}

export async function listRunsForAgent(
  apiKey: string,
  agentId: string
): Promise<RunSummary[]> {
  if (!agentSdk.listRuns) {
    return []
  }

  const response = await agentSdk.listRuns(agentId, {
    runtime: "cloud",
    apiKey,
    limit: 10,
  })
  const rawRuns = extractArray(response, ["items", "runs", "data", "results"])

  return rawRuns.map(normalizeRun)
}

export async function downloadArtifact(
  apiKey: string,
  agentId: string,
  artifactPath: string
): Promise<{ downloadUrl?: string }> {
  const agent = await attachAgent(apiKey, agentId)
  if (!agent.downloadArtifact) {
    return {}
  }

  const response = await agent.downloadArtifact(artifactPath)
  await disposeAgent(agent)

  if (typeof response === "string") {
    return { downloadUrl: response }
  }

  const record = asRecord(response)
  return {
    downloadUrl: firstString(record, [
      "downloadUrl",
      "url",
      "href",
      "presignedUrl",
    ]),
  }
}

export async function readArtifactContent(
  apiKey: string,
  agentId: string,
  artifactPath: string
): Promise<{ bytes: Uint8Array; contentType: string }> {
  const agent = await attachAgent(apiKey, agentId)
  if (!agent.downloadArtifact) {
    throw new Error("This agent does not support artifact downloads.")
  }

  try {
    const response = await agent.downloadArtifact(artifactPath)

    if (typeof response === "string") {
      const artifactResponse = await fetch(response)
      if (!artifactResponse.ok) {
        throw new Error("Artifact download URL returned an error.")
      }

      return {
        bytes: new Uint8Array(await artifactResponse.arrayBuffer()),
        contentType:
          artifactResponse.headers.get("content-type") ??
          contentTypeForArtifactPath(artifactPath),
      }
    }

    if (response instanceof ArrayBuffer) {
      return {
        bytes: new Uint8Array(response),
        contentType: contentTypeForArtifactPath(artifactPath),
      }
    }

    if (response instanceof Uint8Array) {
      return {
        bytes: response,
        contentType: contentTypeForArtifactPath(artifactPath),
      }
    }

    if (response instanceof Blob) {
      return {
        bytes: new Uint8Array(await response.arrayBuffer()),
        contentType: response.type || contentTypeForArtifactPath(artifactPath),
      }
    }
  } finally {
    await disposeAgent(agent)
  }

  throw new Error("Unsupported artifact download response.")
}

async function validateCursorApiKey(apiKey: string) {
  if (!apiKey || !apiKey.startsWith("crsr_")) {
    throw new InvalidCursorApiKeyError(
      "Cursor API keys start with crsr_. Please check the key and try again."
    )
  }

  try {
    await Cursor.me({ apiKey })
  } catch (error) {
    if (isCursorRateLimitError(error)) {
      throw error
    }
    throw new InvalidCursorApiKeyError(
      "The Cursor API key could not be validated. Please check the key and try again."
    )
  }
}

async function getCurrentUser(apiKey: string): Promise<PublicUser | null> {
  try {
    const user = asRecord(await Cursor.me({ apiKey }))
    const name =
      firstString(user, ["name", "displayName", "username"]) ??
      firstString(user, ["email"]) ??
      "Cursor user"
    return {
      name,
      email: firstString(user, ["email"]),
    }
  } catch (error) {
    if (isCursorRateLimitError(error)) {
      throw error
    }
    return null
  }
}

async function resolveRepository(
  apiKey: string,
  repositoryId: string
): Promise<RepositoryOption> {
  const repositories = await listRepositories(apiKey)
  const selected =
    repositories.find((repository) => repository.id === repositoryId) ??
    repositories.find((repository) => repository.url === repositoryId)

  if (selected) {
    return selected
  }

  const fallbackUrl = normalizeRepositoryUrl(repositoryId)
  if (fallbackUrl) {
    return {
      id: fallbackUrl,
      label: labelFromRepositoryUrl(fallbackUrl),
      url: fallbackUrl,
    }
  }

  throw new Error("Select a repository before creating an agent.")
}

async function attachAgent(apiKey: string, agentId: string): Promise<SdkAgentLike> {
  if (agentSdk.resume) {
    return agentSdk.resume(agentId, { apiKey })
  }

  if (agentSdk.get) {
    return asRecord(await agentSdk.get(agentId, { apiKey })) as SdkAgentLike
  }

  throw new Error("This version of @cursor/sdk cannot attach to cloud agents.")
}

async function disposeAgent(agent: SdkAgentLike) {
  await agent[Symbol.asyncDispose]?.().catch(() => undefined)
}

async function readSettings(): Promise<Settings> {
  try {
    const raw = await fs.readFile(settingsPath, "utf8")
    return JSON.parse(raw) as Settings
  } catch (error) {
    if (isNodeFileError(error) && error.code === "ENOENT") {
      return {}
    }
    throw error
  }
}

async function writeSettings(settings: Settings) {
  await fs.mkdir(settingsDir, { recursive: true })
  await fs.writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`)
}

function normalizeAgent(rawAgent: unknown): AgentCard {
  const record = asRecord(rawAgent)
  const id =
    firstString(record, ["id", "agentId", "uuid"]) ?? `agent-${randomUUID()}`
  const status =
    normalizeAgentStatus(record) ?? normalizeAgentStatus(asRecord(record.latestRun))
  const repositoryRecord = firstRecord(record, ["repository", "repo", "cloud"])
  const repoString = firstStringFromArray(record.repos)
  const repositoryUrl =
    firstString(record, ["repositoryUrl", "repoUrl"]) ??
    firstString(repositoryRecord, ["url", "htmlUrl", "remoteUrl"]) ??
    normalizeRepositoryListUrl(repoString)
  const repository =
    firstString(record, ["repository", "repo", "repoName"]) ??
    firstString(repositoryRecord, ["fullName", "name", "slug"]) ??
    (repoString ? labelFromRepositoryString(repoString) : undefined) ??
    (repositoryUrl ? labelFromRepositoryUrl(repositoryUrl) : "No repository")
  const userRecord = firstRecord(record, ["createdBy", "user", "owner"])
  const createdAt = firstTimestamp(record, ["createdAt", "created_at"])
  const updatedAt =
    firstTimestamp(record, ["lastModified", "updatedAt", "updated_at", "lastActivityAt"]) ??
    firstTimestamp(asRecord(record.latestRun), ["updatedAt", "completedAt"])

  return {
    id,
    title:
      firstString(record, ["name", "title", "summary"]) ?? `Agent ${id.slice(0, 8)}`,
    status: status ?? (record.archived === true ? "archived" : "no_status"),
    latestRunId: undefined,
    durationMs: undefined,
    repository,
    repositoryUrl,
    branch:
      firstString(record, ["branch", "startingRef", "ref"]) ??
      firstString(repositoryRecord, ["branch", "startingRef", "defaultBranch"]),
    createdBy:
      firstString(userRecord, ["name", "email", "username"]) ??
      firstString(record, ["createdBy"]),
    createdAt,
    updatedAt,
    prUrl:
      firstString(record, ["prUrl", "pullRequestUrl"]) ??
      firstString(asRecord(record.pullRequest), ["url", "htmlUrl"]),
    latestMessage:
      firstString(record, ["latestMessage", "lastMessage", "prompt", "description"]) ??
      firstString(asRecord(record.latestRun), ["summary", "statusText"]),
    artifacts: [],
  }
}

function enrichAgentCardFromRuns(card: AgentCard, runs: RunSummary[]) {
  const latestRun = runs[0]
  if (!latestRun) {
    return
  }

  if (card.status !== "archived" && latestRun.status) {
    card.status = latestRun.status
  }

  card.latestRunId = latestRun.id
  card.durationMs = latestRun.durationMs
  card.updatedAt = card.updatedAt ?? latestRun.createdAt
  card.latestMessage = card.latestMessage ?? latestRun.result

  if (latestRun.branch) {
    card.branch = latestRun.branch
  }

  if (latestRun.prUrl) {
    card.prUrl = latestRun.prUrl
  }

  if (latestRun.repoUrl) {
    card.repositoryUrl = normalizeRepositoryListUrl(latestRun.repoUrl)
    card.repository = labelFromRepositoryString(latestRun.repoUrl)
  }
}

function normalizeRun(rawRun: unknown): RunSummary {
  const record = asRecord(rawRun)
  const gitRecord = asRecord(record.git ?? record._git)
  const branchRecord = firstRecordFromArray(gitRecord.branches)

  return {
    id: firstString(record, ["id", "runId"]),
    status: normalizeAgentStatus(record),
    createdAt: firstTimestamp(record, ["createdAt", "created_at"]),
    durationMs: firstNumber(record, ["durationMs", "_durationMs"]),
    result: firstString(record, ["result", "_result"]),
    branch: firstString(branchRecord, ["branch", "name"]),
    prUrl: firstString(branchRecord, ["prUrl", "pullRequestUrl"]),
    repoUrl: firstString(branchRecord, ["repoUrl", "repositoryUrl"]),
  }
}

function normalizeAgentStatus(record: UnknownRecord) {
  const rawStatus = firstString(record, [
    "status",
    "_status",
    "state",
    "lifecycleStatus",
    "runStatus",
    "agentStatus",
  ])

  if (!rawStatus) {
    return undefined
  }

  const normalized = rawStatus.toLowerCase()
  if (["unknown", "undefined", "null"].includes(normalized)) {
    return undefined
  }

  return rawStatus
}

function normalizeArtifact(rawArtifact: unknown): ArtifactPreview {
  const record = asRecord(rawArtifact)
  const artifactPath =
    firstString(record, ["path", "name", "filename", "filePath"]) ?? "artifact"
  const name = artifactPath.split("/").filter(Boolean).at(-1) ?? artifactPath
  const contentType = firstString(record, [
    "contentType",
    "mimeType",
    "type",
  ])
  const previewKind = getArtifactPreviewKind(artifactPath, contentType)

  return {
    path: artifactPath,
    name,
    size: firstNumber(record, ["size", "bytes", "contentLength"]),
    contentType,
    previewKind,
  }
}

function withArtifactMediaUrl(
  agentId: string,
  artifact: ArtifactPreview
): ArtifactPreview {
  if (artifact.previewKind === "file") {
    return artifact
  }

  return {
    ...artifact,
    mediaUrl: `/api/agents/${encodeURIComponent(
      agentId
    )}/artifacts/media?path=${encodeURIComponent(artifact.path)}`,
  }
}

function compareArtifactPreviews(a: ArtifactPreview, b: ArtifactPreview) {
  return artifactRank(a) - artifactRank(b)
}

function artifactRank(artifact: ArtifactPreview) {
  if (artifact.previewKind === "video") {
    return 0
  }
  if (artifact.previewKind === "image") {
    return 1
  }
  return 2
}

function normalizeModel(rawModel: unknown): ModelOption | null {
  const record = asRecord(rawModel)
  const id = firstString(record, ["id", "name"])
  if (!id) {
    return null
  }

  return {
    id,
    label: firstString(record, ["displayName", "label", "name"]) ?? id,
    description: firstString(record, ["description"]),
  }
}

function normalizeRepository(rawRepository: unknown): RepositoryOption | null {
  const record = asRecord(rawRepository)
  const url =
    normalizeRepositoryUrl(firstString(record, ["url", "htmlUrl", "remoteUrl"])) ??
    normalizeRepositoryUrl(firstString(record, ["cloneUrl", "sshUrl"]))
  if (!url) {
    return null
  }

  const label =
    firstString(record, ["fullName", "slug", "label", "name"]) ??
    labelFromRepositoryUrl(url)
  const [owner, name] = label.includes("/")
    ? label.split("/", 2)
    : labelFromRepositoryUrl(url).split("/", 2)

  return {
    id: firstString(record, ["id"]) ?? url,
    label,
    url,
    owner,
    name,
    defaultBranch: firstString(record, [
      "defaultBranch",
      "default_branch",
      "branch",
    ]),
  }
}

function extractArray(value: unknown, keys: string[]): unknown[] {
  if (Array.isArray(value)) {
    return value
  }

  const record = asRecord(value)
  for (const key of keys) {
    const candidate = record[key]
    if (Array.isArray(candidate)) {
      return candidate
    }
  }

  return []
}

function asRecord(value: unknown): UnknownRecord {
  return value && typeof value === "object" ? (value as UnknownRecord) : {}
}

function firstRecord(record: UnknownRecord, keys: string[]): UnknownRecord {
  for (const key of keys) {
    const value = record[key]
    if (value && typeof value === "object" && !Array.isArray(value)) {
      return value as UnknownRecord
    }
  }
  return {}
}

function firstRecordFromArray(value: unknown): UnknownRecord {
  if (!Array.isArray(value)) {
    return {}
  }

  const record = value.find(
    (item): item is UnknownRecord =>
      Boolean(item) && typeof item === "object" && !Array.isArray(item)
  )

  return record ?? {}
}

function firstString(
  record: UnknownRecord,
  keys: string[]
): string | undefined {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === "string" && value.trim()) {
      return value.trim()
    }
  }
  return undefined
}

function firstNumber(
  record: UnknownRecord,
  keys: string[]
): number | undefined {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === "number" && Number.isFinite(value)) {
      return value
    }
  }
  return undefined
}

function firstTimestamp(
  record: UnknownRecord,
  keys: string[]
): string | undefined {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === "number" && Number.isFinite(value)) {
      return new Date(value).toISOString()
    }
    if (typeof value === "string" && value.trim()) {
      return value.trim()
    }
  }
  return undefined
}

function firstStringFromArray(value: unknown): string | undefined {
  if (!Array.isArray(value)) {
    return undefined
  }

  return value.find(
    (item): item is string => typeof item === "string" && Boolean(item.trim())
  )
}

function normalizeRepositoryUrl(value: string | undefined): string | undefined {
  if (!value) {
    return undefined
  }

  const trimmed = value.trim().replace(/\.git$/, "")
  const sshMatch = trimmed.match(/^git@github\.com:(.+\/.+)$/)
  const sshUrlMatch = trimmed.match(/^ssh:\/\/git@github\.com\/(.+\/.+)$/)
  const httpsMatch = trimmed.match(/^https:\/\/github\.com\/(.+\/.+)$/)
  const repoPath = sshMatch?.[1] ?? sshUrlMatch?.[1] ?? httpsMatch?.[1]
  return repoPath ? `https://github.com/${repoPath}` : undefined
}

function normalizeRepositoryListUrl(value: string | undefined): string | undefined {
  if (!value) {
    return undefined
  }

  const trimmed = value.trim().replace(/\.git$/, "")
  if (/^https:\/\/github\.com\/.+\/.+/.test(trimmed)) {
    return trimmed
  }
  if (/^github\.com\/.+\/.+/.test(trimmed)) {
    return `https://${trimmed}`
  }
  if (/^[^/]+\/[^/]+$/.test(trimmed)) {
    return `https://github.com/${trimmed}`
  }

  return normalizeRepositoryUrl(trimmed)
}

function labelFromRepositoryUrl(url: string) {
  return url.replace(/^https:\/\/github\.com\//, "")
}

function labelFromRepositoryString(value: string) {
  return value
    .trim()
    .replace(/^https:\/\/github\.com\//, "")
    .replace(/^github\.com\//, "")
    .replace(/\.git$/, "")
}

function getArtifactPreviewKind(
  artifactPath: string,
  contentType?: string
): ArtifactPreview["previewKind"] {
  if (
    contentType?.startsWith("video/") ||
    /\.(mov|mp4|m4v|webm)$/i.test(artifactPath)
  ) {
    return "video"
  }

  if (contentType?.startsWith("image/")) {
    return "image"
  }

  if (/\.(avif|gif|jpe?g|png|svg|webp)$/i.test(artifactPath)) {
    return "image"
  }

  return "file"
}

function contentTypeForArtifactPath(artifactPath: string) {
  const normalized = artifactPath.toLowerCase()
  if (normalized.endsWith(".mp4") || normalized.endsWith(".m4v")) {
    return "video/mp4"
  }
  if (normalized.endsWith(".mov")) {
    return "video/quicktime"
  }
  if (normalized.endsWith(".webm")) {
    return "video/webm"
  }
  if (normalized.endsWith(".png")) {
    return "image/png"
  }
  if (normalized.endsWith(".jpg") || normalized.endsWith(".jpeg")) {
    return "image/jpeg"
  }
  if (normalized.endsWith(".webp")) {
    return "image/webp"
  }
  if (normalized.endsWith(".gif")) {
    return "image/gif"
  }
  if (normalized.endsWith(".svg")) {
    return "image/svg+xml"
  }
  return "application/octet-stream"
}

function isNodeFileError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error
}
