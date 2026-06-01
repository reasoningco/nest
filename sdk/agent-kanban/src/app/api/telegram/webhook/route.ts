import { timingSafeEqual } from "node:crypto"

import {
  createCloudAgent,
  listCloudAgents,
  listRepositories,
  requireCursorApiKey,
  requireRole,
} from "@/lib/agents/server"
import type { AgentCard, CreateAgentInput } from "@/lib/agents/types"
import {
  auditEvent,
  listJetsonAgentLaunches,
  recordJetsonAgentLaunch,
  type AuditActor,
} from "@/lib/nest-store"
import {
  jetsonAgentRequest,
  loadJetsonAgentConfig,
} from "@/lib/jetson-agent/client"
import type {
  JetsonCloneRepoResponse,
  JetsonPromptResponse,
  JetsonRepo,
  JetsonSelectRepoResponse,
  JetsonStatusResponse,
  JetsonTailResponse,
} from "@/lib/jetson-agent/types"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

type TelegramConfig =
  | {
      configured: true
      allowedChatIds: Set<string>
      botToken: string
      webhookSecret: string
    }
  | {
      configured: false
      reason: string
    }

type TelegramUpdate = {
  callback_query?: TelegramCallbackQuery
  message?: TelegramMessage
  edited_message?: TelegramMessage
}

type TelegramMessage = {
  message_id: number
  text?: string
  chat?: {
    id?: number | string
    title?: string
    username?: string
    type?: string
  }
  from?: {
    id?: number
    first_name?: string
    last_name?: string
    username?: string
  }
}

type TelegramCallbackQuery = {
  id: string
  data?: string
  message?: TelegramMessage
}

type TelegramInlineKeyboardMarkup = {
  inline_keyboard: Array<
    Array<{
      callback_data?: string
      text: string
      url?: string
    }>
  >
}

type TelegramSentMessage = {
  message_id: number
  chat: {
    id?: number | string
  }
  text?: string
}

type ParsedCommand = {
  args: string
  name: string
}

type CommandReply = string | null

type CursorLaunchTarget = {
  branch?: string
  prompt: string
  repositoryId: string
}

type JetsonPromptTarget = {
  prompt: string
  repoTarget?: string
}

type TelegramActor = AuditActor & {
  role: "operator"
  sessionId: string
  userEmail: string | undefined
  userName: string | undefined
}

type TailWatchState = {
  chatId: string
  endAt: number
  intervalMs: number
  lines: number
  messageId: number
  timer: ReturnType<typeof setInterval>
  updating: boolean
}

declare global {
  var __nestTelegramTailWatchers: Map<string, TailWatchState> | undefined
}

const tailWatchers =
  globalThis.__nestTelegramTailWatchers ?? new Map<string, TailWatchState>()
globalThis.__nestTelegramTailWatchers = tailWatchers

export async function GET() {
  const cfg = loadTelegramConfig()
  return Response.json({
    ok: cfg.configured,
    reason: cfg.configured ? undefined : cfg.reason,
    commands: [
      "/claude <task>",
      "/cursor <repo-id-or-url> | <task>",
      "/both <repo-id-or-url> | <task>",
      "/clone <git-url>",
      "/key <enter|ctrl-c|1>",
      "/type <text>",
      "/repos [search]",
      "/jetson-repos",
      "/agents",
      "/status",
      "/tail [lines]",
      "/watch [seconds]",
      "/id",
      "/help",
    ],
  })
}

export async function POST(request: Request) {
  const cfg = loadTelegramConfig()
  if (!cfg.configured) {
    return Response.json({ error: cfg.reason }, { status: 503 })
  }

  const secret = request.headers.get("x-telegram-bot-api-secret-token") ?? ""
  if (!safeEquals(secret, cfg.webhookSecret)) {
    return Response.json({ error: "Invalid Telegram webhook secret." }, { status: 401 })
  }

  const update = (await request.json()) as TelegramUpdate
  if (update.callback_query) {
    await handleCallbackQuery(cfg, update.callback_query)
    return Response.json({ ok: true })
  }

  const message = update.message ?? update.edited_message
  const chatId = message?.chat?.id == null ? "" : String(message.chat.id)
  if (!message || !chatId) {
    return Response.json({ ok: true })
  }

  const parsed = parseCommand(message.text ?? "")
  if (!parsed) {
    await sendTelegramText(
      cfg,
      chatId,
      "Send /help for commands. Plain messages are ignored so tasks do not launch accidentally.",
      message.message_id,
    )
    return Response.json({ ok: true })
  }

  if (!isAllowedCommand(cfg, chatId, parsed.name)) {
    await sendTelegramText(
      cfg,
      chatId,
      [
        "This chat is not allowed to launch agents.",
        `Chat id: ${chatId}`,
        "Add it to TELEGRAM_ALLOWED_CHAT_IDS on the NEST server.",
      ].join("\n"),
      message.message_id,
    )
    return Response.json({ ok: true })
  }

  try {
    const actor = actorForTelegramMessage(message)
    const reply = await executeCommand(
      request,
      parsed,
      actor,
      chatId,
      cfg,
      message.message_id,
    )
    if (reply) {
      await sendTelegramText(cfg, chatId, reply, message.message_id)
    }
  } catch (error) {
    await sendTelegramText(
      cfg,
      chatId,
      `Command failed: ${errorMessage(error)}`,
      message.message_id,
    )
  }

  return Response.json({ ok: true })
}

async function executeCommand(
  request: Request,
  command: ParsedCommand,
  actor: TelegramActor,
  chatId: string,
  cfg: Extract<TelegramConfig, { configured: true }>,
  replyToMessageId: number,
): Promise<CommandReply> {
  switch (command.name) {
    case "start":
    case "help":
      return helpText()
    case "id":
      return `Chat id: ${chatId}`
    case "claude":
    case "jetson":
      return sendJetsonPrompt(command.args, actor)
    case "cursor":
      return launchCursorAgent(request, command.args, actor)
    case "both":
    case "all":
      return launchBoth(request, command.args, actor)
    case "clone":
      return cloneJetsonRepository(command.args)
    case "key":
    case "keys":
      return sendJetsonKey(command.args)
    case "type":
      return typeJetsonText(command.args)
    case "repos":
      return listCursorRepositories(request, command.args)
    case "jetson-repos":
    case "jetsonrepos":
      return listJetsonRepositories(command.args)
    case "agents":
      return listRecentAgents(request)
    case "status":
      return jetsonStatus()
    case "tail":
      return jetsonTail(command.args)
    case "watch":
    case "tail-live":
    case "live":
      return startJetsonTailWatch(cfg, chatId, command.args, replyToMessageId)
    default:
      return `Unknown command: /${command.name}\n\n${helpText()}`
  }
}

async function sendJetsonPrompt(args: string, actor: TelegramActor) {
  const target = parseJetsonPromptTarget(args)
  if (!target.prompt) {
    throw new Error("Usage: /claude <task>")
  }

  const cfg = loadJetsonAgentConfig()
  if (!cfg.configured) {
    throw new Error(cfg.reason)
  }

  const selectedRepo = await selectJetsonRepoIfRequested(cfg, target.repoTarget)
  const autonomousPrompt = buildJetsonAutonomousPrompt(target.prompt)
  const result = await jetsonAgentRequest<JetsonPromptResponse>(
    cfg,
    "/api/prompt",
    {
      method: "POST",
      body: JSON.stringify({ prompt: autonomousPrompt }),
    },
  )

  const record = recordJetsonAgentLaunch({
    actor,
    title: `Telegram Claude: ${taskTitle(target.prompt)}`,
    prompt: autonomousPrompt,
    repositoryLabel: selectedRepo?.label || result.repo || "Jetson",
    tail: result.tail,
  })
  auditEvent({
    actor,
    action: "telegram.jetson_prompt",
    resourceType: "jetson_agent",
    resourceId: record.id,
    metadata: { repo: result.repo },
  })

  return [
    "Sent to Jetson Claude.",
    `Record: ${record.id}`,
    selectedRepo?.path ? `Selected repo: ${selectedRepo.path}` : null,
    result.repo ? `Repo: ${result.repo}` : null,
    "",
    trimTail(result.tail),
  ]
    .filter(Boolean)
    .join("\n")
}

async function launchCursorAgent(
  request: Request,
  args: string,
  actor: TelegramActor,
) {
  const target = parseCursorLaunchTarget(args)
  const session = await requireRole(request, "operator")
  const apiKey = requireCursorApiKey(session)
  const input: CreateAgentInput = {
    autoCreatePR: envBoolean("TELEGRAM_CURSOR_AUTO_CREATE_PR", true),
    branch: target.branch,
    modelId: envString("TELEGRAM_DEFAULT_CURSOR_MODEL") || "auto",
    name: `Telegram: ${taskTitle(target.prompt)}`,
    prompt: buildCursorPrompt(target.prompt),
    repositoryId: target.repositoryId,
  }

  const { agent } = await createCloudAgent(apiKey, input, actor)
  return formatAgentCreated("Launched Cursor Cloud Agent.", agent)
}

async function launchBoth(
  request: Request,
  args: string,
  actor: TelegramActor,
) {
  const target = parseCursorLaunchTarget(args)
  const jetsonReply = await sendJetsonPrompt(
    `${target.repositoryId} | ${target.prompt}`,
    actor,
  )

  try {
    const cursorReply = await launchCursorAgent(
      request,
      formatCursorLaunchArgs(target),
      actor,
    )
    return [jetsonReply, "", cursorReply].join("\n")
  } catch (error) {
    return [
      jetsonReply,
      "",
      `Cursor launch failed after Jetson was sent: ${errorMessage(error)}`,
    ].join("\n")
  }
}

async function cloneJetsonRepository(args: string) {
  const url = args.trim()
  if (!url) {
    throw new Error("Usage: /clone <git-url>")
  }
  if (!looksLikeGitUrl(url)) {
    throw new Error("Clone target must be an HTTP(S), SSH, or git@ Git URL.")
  }

  const cfg = loadJetsonAgentConfig()
  if (!cfg.configured) {
    throw new Error(cfg.reason)
  }

  const clone = await jetsonAgentRequest<JetsonCloneRepoResponse>(
    cfg,
    "/api/repo/clone",
    {
      method: "POST",
      body: JSON.stringify({ url }),
    },
  )
  const select = await selectJetsonRepoPath(cfg, clone.repo.path)

  return [
    "Cloned Jetson repository.",
    `Repo: ${clone.repo.name}`,
    `Path: ${clone.repo.path}`,
    select.currentRepo ? `Selected repo: ${select.currentRepo}` : null,
    clone.repo.output ? "" : null,
    trimTail(clone.repo.output),
  ]
    .filter(Boolean)
    .join("\n")
}

async function sendJetsonKey(args: string) {
  const key = args.trim()
  if (!key) {
    throw new Error("Usage: /key <enter|esc|tab|up|down|left|right|ctrl-c|ctrl-d|1>")
  }

  const result = await sendJetsonKeyPress(key)
  return ["Sent key to Jetson Claude.", "", trimTail(result.tail)]
    .filter(Boolean)
    .join("\n")
}

async function sendJetsonKeyPress(key: string) {
  const cfg = loadJetsonAgentConfig()
  if (!cfg.configured) {
    throw new Error(cfg.reason)
  }

  return jetsonAgentRequest<{ ok: boolean; tail: string }>(
    cfg,
    "/api/keys",
    {
      method: "POST",
      body: JSON.stringify({ key }),
    },
  )
}

async function typeJetsonText(args: string) {
  const text = args.trim()
  if (!text) {
    throw new Error("Usage: /type <text>")
  }

  const cfg = loadJetsonAgentConfig()
  if (!cfg.configured) {
    throw new Error(cfg.reason)
  }

  const result = await jetsonAgentRequest<{ ok: boolean; tail: string }>(
    cfg,
    "/api/keys",
    {
      method: "POST",
      body: JSON.stringify({ text, enter: true }),
    },
  )

  return ["Typed into Jetson Claude.", "", trimTail(result.tail)]
    .filter(Boolean)
    .join("\n")
}

async function listCursorRepositories(request: Request, args: string) {
  const session = await requireRole(request, "viewer")
  const apiKey = requireCursorApiKey(session)
  const query = args.trim().toLowerCase()
  const repositories = (await listRepositories(apiKey))
    .filter((repo) => {
      if (!query) return true
      return [repo.id, repo.label, repo.url, repo.owner, repo.name]
        .filter(Boolean)
        .some((value) => value?.toLowerCase().includes(query))
    })
    .slice(0, 12)

  if (repositories.length === 0) {
    return query
      ? `No repositories matched "${query}".`
      : "No linked Cursor repositories are available."
  }

  return [
    "Repositories:",
    ...repositories.map((repo) =>
      [
        `- ${repo.label}`,
        `id: ${repo.id}`,
        repo.defaultBranch ? `branch: ${repo.defaultBranch}` : null,
        repo.url,
      ]
        .filter(Boolean)
        .join("\n  "),
    ),
    "",
    "Launch with: /cursor <repo-id-or-url> | <task>",
  ].join("\n")
}

async function listJetsonRepositories(args: string) {
  const cfg = loadJetsonAgentConfig()
  if (!cfg.configured) {
    throw new Error(cfg.reason)
  }
  const query = args.trim().toLowerCase()
  const status = await jetsonAgentRequest<JetsonStatusResponse>(cfg, "/api/status")
  const repos = status.repos
    .filter((repo) => {
      if (!query) return true
      return [repo.name, repo.path, repo.branch]
        .filter(Boolean)
        .some((value) => value?.toLowerCase().includes(query))
    })
    .slice(0, 16)

  if (repos.length === 0) {
    return query
      ? `No Jetson repositories matched "${query}".`
      : "No Jetson repositories are available."
  }

  return [
    `Current Jetson repo: ${status.currentRepo || "none"}`,
    "Jetson repositories:",
    ...repos.map((repo) =>
      [
        `- ${repo.name}`,
        `path: ${repo.path}`,
        repo.branch ? `branch: ${repo.branch}` : null,
      ]
        .filter(Boolean)
        .join("\n  "),
    ),
    "",
    "Launch with: /claude <name-or-path> | <task>",
  ].join("\n")
}

async function listRecentAgents(request: Request) {
  const session = await requireRole(request, "viewer")
  const apiKey = session.apiKey?.trim()
  const cursorAgents = apiKey
    ? (await listCloudAgents(apiKey, { limit: 8 }).catch(() => ({ agents: [] })))
        .agents
    : []
  const jetsonAgents = listJetsonAgentLaunches().slice(0, 6)

  const lines = ["Recent agents:"]
  if (jetsonAgents.length > 0) {
    lines.push("Jetson:")
    lines.push(
      ...jetsonAgents.map((agent) =>
        `- ${agent.title} (${agent.status}) ${agent.created_at}`,
      ),
    )
  }
  if (cursorAgents.length > 0) {
    lines.push("Cursor:")
    lines.push(...cursorAgents.map((agent) => `- ${agent.title} (${agent.status})`))
  }
  if (lines.length === 1) {
    lines.push("No recent agents found.")
  }
  return lines.join("\n")
}

async function jetsonStatus() {
  const cfg = loadJetsonAgentConfig()
  if (!cfg.configured) {
    throw new Error(cfg.reason)
  }
  const status = await jetsonAgentRequest<JetsonStatusResponse>(cfg, "/api/status")
  return [
    `Jetson: ${status.ok ? "ok" : "not ok"}`,
    `Host: ${status.host}`,
    `Session: ${status.sessionName}`,
    `Window: ${status.windowName}`,
    `Repo: ${status.currentRepo}`,
    status.windows.length > 0 ? `Windows: ${status.windows.join(", ")}` : null,
    "",
    trimTail(status.tail),
  ]
    .filter(Boolean)
    .join("\n")
}

async function jetsonTail(args: string) {
  const cfg = loadJetsonAgentConfig()
  if (!cfg.configured) {
    throw new Error(cfg.reason)
  }
  const lines = parsePositiveInt(args.trim(), 80)
  const tail = await jetsonAgentRequest<JetsonTailResponse>(
    cfg,
    `/api/tail?lines=${lines}`,
  )
  return trimTail(tail.tail) || "No Jetson output yet."
}

async function startJetsonTailWatch(
  telegramCfg: Extract<TelegramConfig, { configured: true }>,
  chatId: string,
  args: string,
  replyToMessageId: number,
) {
  const { lines, seconds } = parseWatchArgs(args)
  const initialText = await buildTailWatchText(lines, Date.now() + seconds * 1000)
  stopTailWatchForChat(chatId)

  const [message] = await sendTelegramText(
    telegramCfg,
    chatId,
    initialText,
    replyToMessageId,
    watchKeyboard(true),
  )
  if (!message) {
    throw new Error("Telegram did not return a watch message to edit.")
  }

  const state: TailWatchState = {
    chatId,
    endAt: Date.now() + seconds * 1000,
    intervalMs: 5000,
    lines,
    messageId: message.message_id,
    timer: setInterval(() => {
      void refreshTailWatch(telegramCfg, state).catch(() => {
        clearInterval(state.timer)
        tailWatchers.delete(watchKey(state.chatId, state.messageId))
      })
    }, 5000),
    updating: false,
  }
  tailWatchers.set(watchKey(chatId, message.message_id), state)

  return null
}

async function handleCallbackQuery(
  cfg: Extract<TelegramConfig, { configured: true }>,
  callback: TelegramCallbackQuery,
) {
  const chatId = callback.message?.chat?.id == null ? "" : String(callback.message.chat.id)
  const messageId = callback.message?.message_id
  if (!chatId || !messageId) {
    await answerCallbackQuery(cfg, callback.id, "No message found.")
    return
  }
  if (!cfg.allowedChatIds.has(chatId)) {
    await answerCallbackQuery(cfg, callback.id, "This chat is not allowed.")
    return
  }

  const data = callback.data ?? ""
  const key = watchKey(chatId, messageId)
  const state = tailWatchers.get(key)

  if (data === "watch:refresh") {
    if (state) {
      await refreshTailWatch(cfg, state, true)
      await answerCallbackQuery(cfg, callback.id, "Refreshed.")
    } else {
      await editTelegramMessageText(
        cfg,
        chatId,
        messageId,
        await buildTailWatchText(120, Date.now(), "Snapshot"),
        watchKeyboard(false),
      )
      await answerCallbackQuery(cfg, callback.id, "Snapshot refreshed.")
    }
    return
  }

  if (data === "watch:stop") {
    if (state) {
      await stopTailWatch(cfg, state, "Stopped")
    } else {
      await editTelegramMessageText(
        cfg,
        chatId,
        messageId,
        await buildTailWatchText(120, Date.now(), "Stopped"),
        watchKeyboard(false),
      )
    }
    await answerCallbackQuery(cfg, callback.id, "Stopped.")
    return
  }

  if (data.startsWith("key:")) {
    const keyName = data.slice("key:".length)
    await sendJetsonKeyPress(keyName)
    if (state) {
      await refreshTailWatch(cfg, state, true)
    }
    await answerCallbackQuery(cfg, callback.id, `Sent ${keyName}.`)
    return
  }

  await answerCallbackQuery(cfg, callback.id)
}

async function refreshTailWatch(
  cfg: Extract<TelegramConfig, { configured: true }>,
  state: TailWatchState,
  force = false,
) {
  if (state.updating) {
    return
  }
  if (!force && Date.now() >= state.endAt) {
    await stopTailWatch(cfg, state, "Finished")
    return
  }

  state.updating = true
  try {
    await editTelegramMessageText(
      cfg,
      state.chatId,
      state.messageId,
      await buildTailWatchText(state.lines, state.endAt),
      watchKeyboard(true),
    )
  } finally {
    state.updating = false
  }
}

async function stopTailWatch(
  cfg: Extract<TelegramConfig, { configured: true }>,
  state: TailWatchState,
  label: "Finished" | "Stopped",
) {
  clearInterval(state.timer)
  tailWatchers.delete(watchKey(state.chatId, state.messageId))
  await editTelegramMessageText(
    cfg,
    state.chatId,
    state.messageId,
    await buildTailWatchText(state.lines, Date.now(), label),
    watchKeyboard(false),
  )
}

function stopTailWatchForChat(chatId: string) {
  for (const [key, state] of tailWatchers) {
    if (state.chatId === chatId) {
      clearInterval(state.timer)
      tailWatchers.delete(key)
    }
  }
}

async function buildTailWatchText(
  lines: number,
  endAt: number,
  label = "Live",
) {
  const cfg = loadJetsonAgentConfig()
  if (!cfg.configured) {
    throw new Error(cfg.reason)
  }
  const [status, tailResponse] = await Promise.all([
    jetsonAgentRequest<JetsonStatusResponse>(cfg, "/api/status"),
    jetsonAgentRequest<JetsonTailResponse>(cfg, `/api/tail?lines=${lines}`),
  ])
  const secondsLeft = Math.max(0, Math.ceil((endAt - Date.now()) / 1000))
  const tail = trimText(tailResponse.tail || status.tail, 3000)

  return [
    `Jetson tail: ${label}`,
    `Repo: ${status.currentRepo || "none"}`,
    `Host: ${status.host}`,
    `Updated: ${new Date().toISOString()}`,
    label === "Live" ? `Auto-refresh: every 5s for ${secondsLeft}s` : null,
    `Lines: ~${lines}`,
    "",
    tail || "No Jetson output yet.",
  ]
    .filter(Boolean)
    .join("\n")
}

function parseWatchArgs(args: string) {
  const values = args
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((value) => Number.parseInt(value, 10))
    .filter((value) => Number.isFinite(value) && value > 0)
  return {
    seconds: Math.min(values[0] ?? 180, 600),
    lines: Math.min(values[1] ?? 120, 300),
  }
}

function watchKeyboard(active: boolean): TelegramInlineKeyboardMarkup {
  return {
    inline_keyboard: [
      active
        ? [
            { text: "Refresh", callback_data: "watch:refresh" },
            { text: "Stop", callback_data: "watch:stop" },
          ]
        : [{ text: "Refresh snapshot", callback_data: "watch:refresh" }],
      [
        { text: "Ctrl-C", callback_data: "key:ctrl-c" },
        { text: "Enter", callback_data: "key:enter" },
      ],
      [{ text: "Open NEST", url: nestBaseUrl() }],
    ],
  }
}

function watchKey(chatId: string, messageId: number) {
  return `${chatId}:${messageId}`
}

function parseCursorLaunchTarget(args: string): CursorLaunchTarget {
  const text = args.trim()
  if (!text) {
    throw new Error("Usage: /cursor <repo-id-or-url> | <task>")
  }

  const delimiter = text.indexOf("|")
  const defaultRepositoryId = envString("TELEGRAM_DEFAULT_REPOSITORY_ID")

  if (delimiter === -1) {
    if (!defaultRepositoryId) {
      throw new Error(
        "No repository was provided. Use /cursor <repo-id-or-url> | <task> or set TELEGRAM_DEFAULT_REPOSITORY_ID.",
      )
    }
    return {
      branch: envString("TELEGRAM_DEFAULT_CURSOR_BRANCH"),
      prompt: text,
      repositoryId: defaultRepositoryId,
    }
  }

  const target = parseRepositoryTarget(text.slice(0, delimiter).trim())
  const prompt = text.slice(delimiter + 1).trim()
  if (!target.repositoryId) {
    throw new Error("Repository id or URL is required before the | delimiter.")
  }
  if (!prompt) {
    throw new Error("Task is required after the | delimiter.")
  }

  return {
    branch: target.branch ?? envString("TELEGRAM_DEFAULT_CURSOR_BRANCH"),
    prompt,
    repositoryId: target.repositoryId,
  }
}

function parseJetsonPromptTarget(args: string): JetsonPromptTarget {
  const text = args.trim()
  if (!text) {
    throw new Error("Usage: /claude <task>")
  }

  const delimiter = text.indexOf("|")
  if (delimiter === -1) {
    return {
      prompt: text,
      repoTarget: envString("TELEGRAM_DEFAULT_JETSON_REPO"),
    }
  }

  const repoTarget = text.slice(0, delimiter).trim()
  const prompt = text.slice(delimiter + 1).trim()
  if (!repoTarget) {
    throw new Error("Jetson repo name, path, or Git URL is required before the | delimiter.")
  }
  if (!prompt) {
    throw new Error("Task is required after the | delimiter.")
  }
  return { prompt, repoTarget }
}

async function selectJetsonRepoIfRequested(
  cfg: Extract<ReturnType<typeof loadJetsonAgentConfig>, { configured: true }>,
  repoTarget: string | undefined,
) {
  const target = repoTarget?.trim()
  if (!target) {
    return undefined
  }

  if (looksLikeGitUrl(target)) {
    const clone = await jetsonAgentRequest<JetsonCloneRepoResponse>(
      cfg,
      "/api/repo/clone",
      {
        method: "POST",
        body: JSON.stringify({ url: target }),
      },
    )
    const select = await selectJetsonRepoPath(cfg, clone.repo.path)
    return {
      label: clone.repo.name || select.currentRepo,
      path: select.currentRepo || clone.repo.path,
    }
  }

  const status = await jetsonAgentRequest<JetsonStatusResponse>(cfg, "/api/status")
  const matched = matchJetsonRepo(status.repos, target)
  const path = matched?.path || target
  const select = await selectJetsonRepoPath(cfg, path)
  return {
    label: matched?.name || select.currentRepo || path,
    path: select.currentRepo || path,
  }
}

async function selectJetsonRepoPath(
  cfg: Extract<ReturnType<typeof loadJetsonAgentConfig>, { configured: true }>,
  path: string,
) {
  return jetsonAgentRequest<JetsonSelectRepoResponse>(
    cfg,
    "/api/repo/select",
    {
      method: "POST",
      body: JSON.stringify({ path }),
    },
  )
}

function matchJetsonRepo(repos: JetsonRepo[], target: string) {
  const normalized = target.trim().toLowerCase()
  return repos.find((repo) => {
    const name = repo.name.toLowerCase()
    const path = repo.path.toLowerCase()
    return (
      name === normalized ||
      path === normalized ||
      path.endsWith(`/${normalized}`) ||
      path.endsWith(`/${normalized.replace(/^.*\//, "")}`)
    )
  })
}

function looksLikeGitUrl(value: string) {
  return (
    /^https?:\/\//i.test(value) ||
    /^git@/i.test(value) ||
    /^ssh:\/\//i.test(value)
  )
}

function parseRepositoryTarget(rawTarget: string) {
  let target = rawTarget.trim()
  let branch: string | undefined
  const branchFlag = target.match(/^(.*?)\s+--branch\s+(.+)$/)
  if (branchFlag) {
    target = branchFlag[1].trim()
    branch = branchFlag[2].trim()
  } else {
    const hashIndex = target.lastIndexOf("#")
    if (hashIndex > 0 && hashIndex < target.length - 1) {
      branch = target.slice(hashIndex + 1).trim()
      target = target.slice(0, hashIndex).trim()
    }
  }
  return { branch, repositoryId: target }
}

function formatCursorLaunchArgs(target: CursorLaunchTarget) {
  const branch = target.branch ? ` --branch ${target.branch}` : ""
  return `${target.repositoryId}${branch} | ${target.prompt}`
}

function formatAgentCreated(prefix: string, agent: AgentCard) {
  return [
    prefix,
    `Agent: ${agent.title}`,
    `ID: ${agent.id}`,
    `Status: ${agent.status}`,
    agent.repository ? `Repo: ${agent.repository}` : null,
    agent.branch ? `Branch: ${agent.branch}` : null,
    agent.prUrl ? `PR: ${agent.prUrl}` : null,
  ]
    .filter(Boolean)
    .join("\n")
}

function buildJetsonAutonomousPrompt(prompt: string) {
  return [
    "You are the Jetson autonomous software development agent controlled from Telegram through NEST.",
    "Run independently. Do not wait for the Telegram user to answer interactive permission prompts.",
    "Use non-interactive execution paths and dangerous/skip-permission CLI modes when a local agent CLI would otherwise block on confirmation.",
    "You have permission to inspect files, edit code, run builds/tests, commit, and push when the task requires it.",
    "When asked to commit or push, work from the selected repository, inspect git status, pull or rebase if the branch is behind, commit the requested changes, and push to origin.",
    "",
    "Task:",
    prompt,
    "",
    "Report progress in the terminal output and leave a concise final status when finished.",
  ].join("\n")
}

function buildCursorPrompt(prompt: string) {
  return [
    "You are a Cursor Cloud Agent launched from Telegram through NEST.",
    "Work independently, make the requested code changes, run relevant verification, and leave a concise final status.",
    "",
    "Task:",
    prompt,
  ].join("\n")
}

function parseCommand(text: string): ParsedCommand | null {
  const trimmed = text.trim()
  if (!trimmed.startsWith("/")) {
    return null
  }

  const [rawCommand, ...rest] = trimmed.split(/\s+/)
  const name = rawCommand.slice(1).split("@")[0].toLowerCase()
  if (!name) {
    return null
  }
  return { args: rest.join(" ").trim(), name }
}

function isAllowedCommand(
  cfg: Extract<TelegramConfig, { configured: true }>,
  chatId: string,
  command: string,
) {
  if (cfg.allowedChatIds.has(chatId)) {
    return true
  }
  return cfg.allowedChatIds.size === 0 && (command === "help" || command === "id")
}

function actorForTelegramMessage(message: TelegramMessage): TelegramActor {
  const from = message.from
  const name = [from?.first_name, from?.last_name].filter(Boolean).join(" ")
  const username = from?.username ? `@${from.username}` : undefined
  return {
    role: "operator",
    sessionId: `telegram:${message.chat?.id ?? "unknown"}`,
    userEmail: undefined,
    userName: (username ?? name) || "Telegram user",
  }
}

function loadTelegramConfig(): TelegramConfig {
  const botToken = envString("TELEGRAM_BOT_TOKEN")
  const webhookSecret = envString("TELEGRAM_WEBHOOK_SECRET")
  if (!botToken || !webhookSecret) {
    return {
      configured: false,
      reason:
        "TELEGRAM_BOT_TOKEN and TELEGRAM_WEBHOOK_SECRET must be set in the agent-kanban server environment.",
    }
  }

  return {
    configured: true,
    allowedChatIds: new Set(envList("TELEGRAM_ALLOWED_CHAT_IDS")),
    botToken,
    webhookSecret,
  }
}

async function sendTelegramText(
  cfg: Extract<TelegramConfig, { configured: true }>,
  chatId: string,
  text: string,
  replyToMessageId?: number,
  replyMarkup?: TelegramInlineKeyboardMarkup,
) {
  const messages: TelegramSentMessage[] = []
  for (const chunk of splitTelegramText(text)) {
    messages.push(
      await sendTelegramMessage(
        cfg,
        chatId,
        chunk,
        replyToMessageId,
        messages.length === 0 ? replyMarkup : undefined,
      ),
    )
  }
  return messages
}

async function sendTelegramMessage(
  cfg: Extract<TelegramConfig, { configured: true }>,
  chatId: string,
  text: string,
  replyToMessageId?: number,
  replyMarkup?: TelegramInlineKeyboardMarkup,
) {
  return telegramApi<TelegramSentMessage>(cfg, "sendMessage", {
    chat_id: chatId,
    disable_web_page_preview: true,
    reply_markup: replyMarkup,
    reply_to_message_id: replyToMessageId,
    text,
  })
}

async function editTelegramMessageText(
  cfg: Extract<TelegramConfig, { configured: true }>,
  chatId: string,
  messageId: number,
  text: string,
  replyMarkup?: TelegramInlineKeyboardMarkup,
) {
  try {
    await telegramApi<TelegramSentMessage | true>(cfg, "editMessageText", {
      chat_id: chatId,
      disable_web_page_preview: true,
      message_id: messageId,
      reply_markup: replyMarkup,
      text: trimText(text, 3900),
    })
  } catch (error) {
    const message = errorMessage(error)
    if (!message.includes("message is not modified")) {
      throw error
    }
  }
}

async function answerCallbackQuery(
  cfg: Extract<TelegramConfig, { configured: true }>,
  callbackQueryId: string,
  text?: string,
) {
  await telegramApi<true>(cfg, "answerCallbackQuery", {
    callback_query_id: callbackQueryId,
    text,
  })
}

async function telegramApi<T>(
  cfg: Extract<TelegramConfig, { configured: true }>,
  method: string,
  body: Record<string, unknown>,
) {
  const response = await fetch(
    `https://api.telegram.org/bot${cfg.botToken}/${method}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
  )
  const text = await response.text()
  let payload: { description?: string; ok?: boolean; result?: T } | null = null
  try {
    payload = text ? JSON.parse(text) : null
  } catch {
    payload = null
  }
  if (!response.ok || payload?.ok === false) {
    throw new Error(
      `Telegram ${method} ${response.status}: ${payload?.description || text}`,
    )
  }
  return payload?.result as T
}

function splitTelegramText(text: string) {
  const maxLength = 3900
  const chunks: string[] = []
  let remaining = text.trim() || "Done."
  while (remaining.length > maxLength) {
    let splitAt = remaining.lastIndexOf("\n", maxLength)
    if (splitAt < 1000) {
      splitAt = maxLength
    }
    chunks.push(remaining.slice(0, splitAt).trimEnd())
    remaining = remaining.slice(splitAt).trimStart()
  }
  chunks.push(remaining)
  return chunks
}

function helpText() {
  return [
    "NEST Telegram control",
    "",
    "Choose runtime:",
    "/claude <task> - run Jetson Claude Code in the current/default Jetson repo",
    "/jetson <task> - same as /claude",
    "/cursor <repo-id-or-url> | <task> - launch a Cursor Cloud Agent",
    "/both <repo-id-or-url> | <task> - send the task to Jetson, then launch Cursor",
    "",
    "Choose repo:",
    "/clone <git-url> - clone a repo onto Jetson and select it",
    "/jetson-repos [search] - list repos available on Jetson",
    "/claude <jetson-repo-name-or-path-or-git-url> | <task>",
    "/repos [search] - list linked Cursor repositories",
    "/cursor <repo-id-or-url>#<branch> | <task>",
    "",
    "Examples:",
    "/claude ChefOS | run tests and summarize failures",
    "/clone https://github.com/reasoningco/crm.git",
    "/cursor https://github.com/org/repo.git | fix the lint errors",
    "/both https://github.com/org/repo.git#main | investigate the build failure",
    "/key enter",
    "/type 1",
    "",
    "Status:",
    "/watch [seconds] - live-edit one Telegram message with Jetson tail",
    "/key <enter|esc|tab|up|down|left|right|ctrl-c|ctrl-d|1> - press a key in Jetson Claude",
    "/type <text> - paste text into Jetson Claude and press Enter",
    "/agents - list recent Jetson and Cursor agents",
    "/status - show Jetson status",
    "/tail [lines] - show Jetson terminal output",
    "/id - show this chat id for TELEGRAM_ALLOWED_CHAT_IDS setup",
  ].join("\n")
}

function taskTitle(task: string) {
  const collapsed = task.replace(/\s+/g, " ").trim()
  if (!collapsed) {
    return "task"
  }
  return collapsed.length > 54 ? `${collapsed.slice(0, 51).trim()}...` : collapsed
}

function trimTail(tail: string | undefined) {
  const text = tail?.trim()
  if (!text) {
    return ""
  }
  return text.length > 1800 ? text.slice(text.length - 1800) : text
}

function trimText(text: string, maxLength: number) {
  if (text.length <= maxLength) {
    return text
  }
  return text.slice(text.length - maxLength)
}

function nestBaseUrl() {
  return (
    envString("NEST_PUBLIC_BASE_URL") ??
    envString("NEXT_PUBLIC_NEST_BASE_URL") ??
    "https://nest.reasoning.company"
  ).replace(/\/+$/, "")
}

function parsePositiveInt(raw: string, fallback: number) {
  if (!raw) {
    return fallback
  }
  const value = Number.parseInt(raw, 10)
  if (!Number.isFinite(value) || value <= 0) {
    return fallback
  }
  return Math.min(value, 300)
}

function envString(name: string) {
  return process.env[name]?.trim() || undefined
}

function envList(name: string) {
  return (process.env[name] ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
}

function envBoolean(name: string, fallback: boolean) {
  const value = process.env[name]?.trim().toLowerCase()
  if (!value) {
    return fallback
  }
  if (["1", "true", "yes", "on"].includes(value)) {
    return true
  }
  if (["0", "false", "no", "off"].includes(value)) {
    return false
  }
  return fallback
}

function safeEquals(actual: string, expected: string) {
  const actualBytes = Buffer.from(actual)
  const expectedBytes = Buffer.from(expected)
  return (
    actualBytes.length === expectedBytes.length &&
    timingSafeEqual(actualBytes, expectedBytes)
  )
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}
