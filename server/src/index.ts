// cc-remote 服务端入口：REST + WebSocket + 静态托管

import { appendFileSync, existsSync } from 'node:fs'
import { networkInterfaces } from 'node:os'
import { join, resolve } from 'node:path'
import { isAuthorized, isLoopbackHost } from './auth'
import { keyFor, parseKey } from './backends/claude/backend'
import { listSessions, liveSessionInfo, readHistory, sanitizePath, type SessionInfo } from './backends/claude/discovery'
import { processManager, type ApprovalDecision, type SpawnOptions } from './backends/claude/processManager'
import { isInternalUserMessage, type CliMessage } from './backends/claude/protocol'
import { TranscriptTailer } from './backends/claude/tailer'
import { codexBackend, isCodexKey, keyForNew as codexKeyForNew, parseKey as codexParseKey } from './backends/codex/backend'
import { codexRuntime, type CodexSession } from './backends/codex/runtime'
import { config } from './config'
import { FsBrowseError, listDirectories, readGitBranch } from './fsbrowse'
import {
  appendLineage,
  generateClaudeBrief,
  generateCodexBrief,
  lineageFor,
  seedMessage,
  type HandoffDetail,
  type LineageRecord,
} from './handoff'

// ---------- sessionKey ----------
// 编码规则与解析见 backends/claude/backend.ts（s|slug|sid / n|cwd）

// ---------- WS 枢纽 ----------

interface PendingApproval {
  requestId: string
  toolName: string
  input: unknown
}

interface WSDataSession {
  key: string
  inbox?: never
}

interface WSDataInbox {
  inbox: true
  key?: never
}

type WSData = WSDataSession | WSDataInbox

interface Hub {
  key: string
  clients: Set<import('bun').ServerWebSocket<WSData>>
  pendingApprovals: Map<string, PendingApproval>
  /** 未 spawn 时缓存启动偏好；已 spawn 时记录当前选择，供 UI 重连恢复 */
  spawnOpts?: Partial<SpawnOptions>
  /** 除 effort 外、需要在进程启动后按顺序写入 stdin 的环境变量 */
  pendingEnv?: Record<string, string>
  /** 组合回滚正在等待 rewind_files 的 CLI 确认，期间禁止再切断当前会话。 */
  rewindPending?: boolean
  /** 未 spawn 时对 transcript JSONL 的实时跟踪（外部运行中的会话） */
  tailer?: TranscriptTailer
  /** tail 状态推送的节流时间戳 */
  tailStatusAt?: number
}

const hubs = new Map<string, Hub>()

// ---------- 全局收件箱（/ws/inbox）：跨会话审批/完成/错误汇总 ----------

interface InboxData {
  inbox: true
}

const inboxClients = new Set<import('bun').ServerWebSocket<WSDataInbox>>()

type InboxEvent =
  | { type: 'approval'; key: string; requestId: string; toolName: string; input: unknown }
  | { type: 'approval_resolved'; key: string; requestId: string }
  | { type: 'done'; key: string; ok: boolean }
  | { type: 'error'; key: string; message: string }

function publishInbox(ev: InboxEvent): void {
  if (inboxClients.size === 0) return
  const text = JSON.stringify(ev)
  for (const ws of inboxClients) {
    try {
      ws.send(text)
    } catch {}
  }
}

/** inbox 快照：所有 Hub 的待审批与忙闲状态（新连接建立时下发） */
function inboxSnapshot(): Record<string, unknown> {
  const approvals: unknown[] = []
  const states: Record<string, unknown>[] = []
  for (const hub of hubs.values()) {
    const st = statusOf(hub.key)
    if (st.spawned || st.busy || st.waiting) states.push({ key: hub.key, ...st })
    for (const a of hub.pendingApprovals.values()) {
      approvals.push({ type: 'approval', key: hub.key, ...a })
    }
  }
  return { type: 'snapshot', states, approvals }
}


function getHub(key: string): Hub {
  let h = hubs.get(key)
  if (!h) {
    h = { key, clients: new Set(), pendingApprovals: new Map() }
    hubs.set(key, h)
  }
  return h
}

function broadcast(hub: Hub, payload: unknown): void {
  const text = JSON.stringify(payload)
  for (const ws of hub.clients) {
    try {
      ws.send(text)
    } catch {}
  }
  // 错误事件同步进全局收件箱（审批/完成由各自路径单独发布）
  const kind = (payload as { kind?: string } | null | undefined)?.kind
  if (kind === 'error') {
    publishInbox({ type: 'error', key: hub.key, message: String((payload as { message?: unknown }).message ?? '') })
  }
}

function statusOf(key: string): Record<string, unknown> {
  if (isCodexKey(key)) return codexStatusOf(key)
  const s = processManager.get(key)
  const hub = hubs.get(key)
  const pending = hub?.pendingApprovals.size ?? 0
  // 未被本服务 spawn 的会话：读 pid 文件，把外部 CLI 的实时状态反映到 busy/waiting
  let live: { status: string; pid: number } | undefined
  if (!s || s.exited) {
    const parts = key.split('|')
    if (parts[0] === 's' && parts.length === 3) live = liveSessionInfo(parts[2])
  }
  const waiting = (s?.waiting ?? false) || pending > 0 || live?.status === 'waiting'
  // 审批等待也算 busy，防止误回收
  const busy = (s?.busy ?? false) || waiting || live?.status === 'busy'
  return {
    spawned: !!s && !s.exited,
    busy,
    waiting,
    sessionState: s?.sessionState ?? 'idle',
    sessionId: s?.sessionId,
    clients: s?.connectedClients ?? hub?.clients.size ?? 0,
    activeTaskCount: s?.activeTaskCount ?? 0,
    activeTasks: s?.backgroundTasks ?? [],
    usage: s?.tokenUsage,
    slashCommands: s?.slashCommands,
    model: hub?.spawnOpts?.model,
    permissionMode: hub?.spawnOpts?.permissionMode,
    effort: hub?.spawnOpts?.effort,
    tailing: !!hub?.tailer,
    liveStatus: live?.status,
  }
}

function pushStatus(hub: Hub, extra?: Record<string, unknown>): void {
  broadcast(hub, { kind: 'status', state: { ...statusOf(hub.key), ...extra } })
}

/** codex 会话状态：与 statusOf 同形，供列表 managed 字段与 WS status 复用 */
function codexStatusOf(key: string): Record<string, unknown> {
  const s = codexRuntime.get(key)
  const hub = hubs.get(key)
  const pending = hub?.pendingApprovals.size ?? 0
  const waiting = (s?.waiting ?? false) || pending > 0
  return {
    spawned: !!s && !s.exited,
    busy: (s?.busy ?? false) || waiting,
    waiting,
    sessionState: s?.sessionState ?? 'idle',
    sessionId: s?.sessionId,
    clients: s?.connectedClients ?? hub?.clients.size ?? 0,
    activeTaskCount: 0,
    activeTasks: [],
    usage: s?.tokenUsage,
    model: hub?.spawnOpts?.model,
    permissionMode: hub?.spawnOpts?.permissionMode,
    effort: hub?.spawnOpts?.effort,
    tailing: false,
  }
}

/** 两个后端共用的会话回调：CLI/翻译层消息广播、审批入 Hub 表、状态推动 */
function sessionCallbacks(hub: Hub) {
  return {
    onMessage: (msg: CliMessage) => {
      // 后台 Agent 完成通知会作为伪装成 user 的内部 XML 记录出现。
      // 生命周期本身已由 ProcessManager 消费为 system/task_notification；
      // 不再把原始内部载荷广播进主聊天或 rewind 历史。
      if (isInternalUserMessage(msg)) return
      broadcast(hub, { kind: 'cli', msg })
      // turn 收尾是收件箱的核心提醒信号（agent 跑完了）
      if (msg.type === 'result') {
        publishInbox({ type: 'done', key: hub.key, ok: msg.is_error !== true })
      }
    },
    onApprovalRequest: (req: { requestId: string; toolName: string; input: unknown }) => {
      hub.pendingApprovals.set(req.requestId, req)
      broadcast(hub, {
        kind: 'approval_request',
        requestId: req.requestId,
        toolName: req.toolName,
        input: req.input,
      })
      publishInbox({ type: 'approval', key: hub.key, requestId: req.requestId, toolName: req.toolName, input: req.input })
      pushStatus(hub)
      processManager.get(hub.key)?.notifyExternalGate()
    },
    onStatusChange: () => pushStatus(hub),
    onExit: (code: number) => {
      pushStatus(hub, { exited: true, exitCode: code, spawned: false, busy: false, waiting: false })
    },
  }
}

/** codex 会话懒启动：attach(x|) 或首条 user 消息时 resume/start 线程 */
async function ensureCodexSession(hub: Hub, opts?: Partial<SpawnOptions>): Promise<CodexSession | undefined> {
  const parsed = codexParseKey(hub.key)
  if (!parsed) {
    broadcast(hub, { kind: 'error', message: '无法解析 codex 会话 key' })
    return undefined
  }
  const spawnOpts = {
    cwd: parsed.cwd,
    resumeThreadId: parsed.resumeThreadId,
    permissionMode: config.permissionPolicy === 'bypass' ? 'bypassPermissions' : undefined,
    ...hub.spawnOpts,
    ...opts,
  }
  hub.spawnOpts = spawnOpts
  const s = codexRuntime.ensure(hub.key, spawnOpts, sessionCallbacks(hub))
  s.syncClients(hub.clients.size)
  try {
    await s.start()
  } catch (e) {
    broadcast(hub, { kind: 'error', message: e instanceof Error ? e.message : String(e) })
    pushStatus(hub)
    return undefined
  }
  pushStatus(hub)
  return s
}

// ---------- transcript tailer（外部会话实时跟踪） ----------

function stopTailer(hub: Hub): void {
  hub.tailer?.stop()
  hub.tailer = undefined
}

function throttledTailStatus(hub: Hub): void {
  const now = Date.now()
  if (now - (hub.tailStatusAt ?? 0) < 2000) return
  hub.tailStatusAt = now
  pushStatus(hub)
}

function startTailer(hub: Hub, from?: number): void {
  if (hub.tailer) return
  const parts = hub.key.split('|')
  if (parts[0] !== 's' || parts.length !== 3) return // 新会话还没有 transcript
  if (processManager.get(hub.key)) return // 已 spawn：live 流覆盖，无需 tail
  const path = join(config.claudeConfigDir, 'projects', parts[1], `${parts[2]}.jsonl`)
  hub.tailer = new TranscriptTailer(path, from, {
    onMessage: (msg) => {
      broadcast(hub, { kind: 'tail', msg })
      throttledTailStatus(hub)
    },
    onReset: () => {
      stopTailer(hub)
      broadcast(hub, { kind: 'tail_reset' })
      pushStatus(hub)
    },
    onTick: () => throttledTailStatus(hub),
  })
  hub.tailer.start()
  pushStatus(hub)
}

function rewindConversation(hub: Hub, userMessageId: string, scope: 'conversation' | 'both'): void {
  const current = processManager.get(hub.key)
  const parsed = parseKey(hub.key)
  const sid = current?.sessionId ?? parsed?.resumeSessionId
  if (!parsed || !sid) {
    broadcast(hub, { kind: 'error', message: '无法回滚：未知会话 ID' })
    return
  }
  // 先从 map 摘掉再 kill，避免旧 onExit 污染新会话。
  processManager.dispose(hub.key)
  hub.spawnOpts = { ...hub.spawnOpts, cwd: parsed.cwd, resumeSessionId: sid, resumeSessionAt: userMessageId }
  ensureSpawned(hub, undefined, parsed)
  const respawned = processManager.get(hub.key)
  if (!respawned || respawned.exited) {
    // ensureSpawned 已广播具体的 spawn 错误；不能向客户端虚报回滚成功。
    return
  }
  broadcast(hub, { kind: 'rewound', userMessageId, scope })
}

function ensureSpawned(
  hub: Hub,
  opts?: Partial<SpawnOptions>,
  parsedHint?: { cwd: string; resumeSessionId?: string; slug?: string },
): void {
  // parseKey 会反查 listSessions()（一次文件系统扫描）；调用方已解析过时直接复用
  const parsed = parsedHint ?? parseKey(hub.key)
  if (!parsed) {
    broadcast(hub, { kind: 'error', message: '无法解析会话（项目目录不存在？）' })
    return
  }
  const spawnOpts: SpawnOptions = {
    cwd: parsed.cwd,
    resumeSessionId: parsed.resumeSessionId,
    permissionMode: config.permissionPolicy === 'bypass' ? 'bypassPermissions' : undefined,
    ...hub.spawnOpts,
    ...opts,
  }
  hub.spawnOpts = spawnOpts
  try {
    const s = processManager.ensure(hub.key, spawnOpts, sessionCallbacks(hub))
    // spawn 成功（或已有存活进程）：live 流接管，停掉 transcript tailer 避免重复推送
    stopTailer(hub)
    // 懒 spawn：WS 可能在进程创建前已 open，对齐客户端引用计数
    s.syncClients(hub.clients.size)
    // 自定义 env 必须排在首条 user 消息之前写入；stdin 保证顺序。
    if (hub.pendingEnv && Object.keys(hub.pendingEnv).length > 0) {
      s.write({ type: 'update_environment_variables', variables: hub.pendingEnv })
      hub.pendingEnv = undefined
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    console.error(`[session ${hub.key}] spawn 失败:`, message)
    broadcast(hub, { kind: 'error', message })
  }
  // resumeSessionAt 是一次性 spawn 参数（命令行 args 已在 spawn() 内同步生成）。
  // 无论本次成败都不能留在 hub.spawnOpts 里，否则之后空闲回收后的普通 respawn
  // 会带着它再次截断同一条消息，静默丢弃回滚之后的新对话。
  if (hub.spawnOpts) delete hub.spawnOpts.resumeSessionAt
  pushStatus(hub)
}

function handleClientMessage(hub: Hub, raw: string): void {
  let data: Record<string, unknown>
  try {
    data = JSON.parse(raw)
  } catch {
    return
  }
  const session = () => processManager.get(hub.key)
  switch (data.kind) {
    case 'attach': {
      // 浏览历史只握手，不 spawn。发消息 / 切 model·mode·effort / rewind / btw 时再启动 CLI。
      // 若客户端显式传 warm:true，则预热 resume（用于主动续聊）。
      // codex：x| 会话 attach 即 resume（订阅实时事件）；xn| 新会话保持懒启动。
      if (isCodexKey(hub.key)) {
        if (data.warm === true || data.opts || hub.key.startsWith('x|')) {
          void ensureCodexSession(hub, data.opts as Partial<SpawnOptions> | undefined)
        } else {
          pushStatus(hub)
        }
      } else if (data.warm === true || data.opts) {
        ensureSpawned(hub, data.opts as Partial<SpawnOptions> | undefined)
      } else {
        pushStatus(hub)
      }
      for (const a of hub.pendingApprovals.values()) {
        broadcast(hub, { kind: 'approval_request', ...a })
      }
      break
    }
    case 'tail_subscribe': {
      // 客户端加载完历史后订阅 transcript 追加（from = 历史读取时的文件字节数，无缝衔接）
      // codex 的实时流走 app-server 订阅，无 tailer 概念
      if (!isCodexKey(hub.key)) {
        startTailer(hub, typeof data.from === 'number' ? data.from : undefined)
      }
      break
    }
    case 'user': {
      if (hub.rewindPending) {
        broadcast(hub, { kind: 'error', message: '正在恢复文件，请等待回滚完成后再发送消息' })
        return
      }
      const sendMode = data.sendMode === 'steer' || data.sendMode === 'queue' ? data.sendMode : undefined
      if (isCodexKey(hub.key)) {
        void (async () => {
          let s = codexRuntime.get(hub.key)
          if (!s || s.exited || !s.sessionId) {
            s = await ensureCodexSession(hub)
          }
          if (!s || s.exited) return // ensureCodexSession 已广播具体错误
          try {
            s.sendUserText(String(data.text ?? ''), sendMode)
            pushStatus(hub)
          } catch (e) {
            broadcast(hub, { kind: 'error', message: `发送失败: ${e}` })
            pushStatus(hub)
          }
        })()
        return
      }
      let s = session()
      if (!s || s.exited) {
        ensureSpawned(hub)
        s = session()
      }
      if (!s || s.exited) {
        // ensureSpawned 已广播具体错误
        return
      }
      try {
        // sendMode 直通：claude 侧 steer=priority 'now'（中断处理）、queue=服务端排队
        s.sendUserText(String(data.text ?? ''), sendMode)
        pushStatus(hub)
      } catch (e) {
        broadcast(hub, { kind: 'error', message: `发送失败: ${e}` })
        pushStatus(hub)
      }
      break
    }
    case 'control': {
      const subtype = String(data.subtype)
      const extra = (data.extra as Record<string, unknown>) ?? {}
      // 组合回滚等待期间，通用控制路径不得再发 rewind_files 与之竞争
      if (hub.rewindPending && subtype === 'rewind_files') {
        broadcast(hub, { kind: 'error', message: '已有回滚操作正在进行' })
        return
      }
      // codex：interrupt/set_model/set_permission_mode/compact 直接翻译；其余控制请求暂无对应物
      if (isCodexKey(hub.key)) {
        if (subtype === 'set_model' && extra.model) {
          hub.spawnOpts = { ...hub.spawnOpts, model: String(extra.model) }
        }
        if (subtype === 'set_permission_mode' && extra.mode) {
          hub.spawnOpts = { ...hub.spawnOpts, permissionMode: String(extra.mode) }
        }
        const s = codexRuntime.get(hub.key)
        if (s && !s.exited) {
          s.sendControl(subtype, extra)
        }
        pushStatus(hub)
        return
      }
      // 中断：未启动则无需操作
      if (subtype === 'interrupt') {
        const s = session()
        if (s && !s.exited) {
          try {
            s.sendControl(subtype, extra)
          } catch (e) {
            broadcast(hub, { kind: 'error', message: `中断失败: ${e}` })
          }
          pushStatus(hub)
        }
        return
      }
      // model/mode 都有等价 CLI 启动参数。未 spawn 时只缓存最终选择，
      // 等首条 user 消息触发 ensureSpawned；已 spawn 时才发送运行时控制。
      if (subtype === 'set_model' && extra.model) {
        hub.spawnOpts = { ...hub.spawnOpts, model: String(extra.model) }
      }
      if (subtype === 'set_permission_mode' && extra.mode) {
        hub.spawnOpts = { ...hub.spawnOpts, permissionMode: String(extra.mode) }
      }
      let s = session()
      if (!s || s.exited) {
        if (subtype === 'set_model' || subtype === 'set_permission_mode') {
          pushStatus(hub)
          return
        }
        // 其他控制可能没有 CLI 参数等价物，仍需进程承接。
        ensureSpawned(hub)
        s = session()
      }
      if (!s || s.exited) return
      try {
        s.sendControl(subtype, extra)
        pushStatus(hub)
      } catch (e) {
        broadcast(hub, { kind: 'error', message: `控制请求失败: ${e}` })
        pushStatus(hub)
      }
      break
    }
    case 'update_env': {
      // effort 有 --effort 启动参数。未 spawn 时只缓存，首条消息时应用；
      // 已 spawn 时通过 update_environment_variables 影响后续 turn。
      const variables = (data.variables as Record<string, string>) ?? {}
      const effort = variables.CLAUDE_CODE_EFFORT_LEVEL
      if (effort) hub.spawnOpts = { ...hub.spawnOpts, effort }
      if (isCodexKey(hub.key)) {
        // codex：映射为 reasoning effort（CodexSession.write 内部翻译）
        const s = codexRuntime.get(hub.key)
        if (s && !s.exited) {
          s.write({ type: 'update_environment_variables', variables })
        }
        pushStatus(hub)
        return
      }
      const otherVariables = Object.fromEntries(
        Object.entries(variables).filter(([key]) => key !== 'CLAUDE_CODE_EFFORT_LEVEL'),
      )
      const s = session()
      if (!s || s.exited) {
        if (Object.keys(otherVariables).length > 0) {
          hub.pendingEnv = { ...hub.pendingEnv, ...otherVariables }
        }
        pushStatus(hub)
        return
      }
      try {
        s.write({ type: 'update_environment_variables', variables })
        pushStatus(hub)
      } catch (e) {
        broadcast(hub, { kind: 'error', message: `更新环境变量失败: ${e}` })
        pushStatus(hub)
      }
      break
    }
    case 'rewind_conversation': {
      const at = String(data.userMessageId ?? '')
      if (!at) return
      if (isCodexKey(hub.key)) {
        // codex：分叉语义——thread/fork(beforeTurnId) 复制该轮之前的历史为新线程，
        // 原线程不动。userMessageId 即历史的轮首 userMessage 的 turnId。
        const tid = codexRuntime.get(hub.key)?.sessionId ?? codexParseKey(hub.key)?.resumeThreadId
        if (!tid) {
          broadcast(hub, { kind: 'error', message: 'codex 会话未就绪，无法分叉' })
          return
        }
        void codexRuntime
          .forkAt(tid, at)
          .then((newId) => {
            broadcast(hub, {
              kind: 'forked',
              targetKey: `x|${newId}`,
              targetSessionId: newId,
              fromTurnId: at,
            })
          })
          .catch((e) =>
            broadcast(hub, { kind: 'error', message: `分叉失败: ${e instanceof Error ? e.message : e}` }),
          )
        return
      }
      if (hub.rewindPending) {
        broadcast(hub, { kind: 'error', message: '已有回滚操作正在进行' })
        return
      }
      rewindConversation(hub, at, 'conversation')
      break
    }
    case 'rewind_both': {
      const at = String(data.userMessageId ?? '')
      if (!at) return
      if (isCodexKey(hub.key)) {
        broadcast(hub, { kind: 'error', message: 'Codex 没有文件检查点，不支持文件回滚（可用 git 管理代码历史）' })
        return
      }
      if (hub.rewindPending) {
        broadcast(hub, { kind: 'error', message: '已有回滚操作正在进行' })
        return
      }
      let s = session()
      if (!s || s.exited) {
        ensureSpawned(hub)
        s = session()
      }
      if (!s || s.exited) return

      // 官方 TUI 的“恢复代码和对话”也是两个动作。这里必须先收到文件
      // checkpoint 成功响应，才允许销毁旧进程并以 resume-session-at 截断对话。
      // rewind_files 没有 CLI 侧超时，大项目恢复可达分钟级，给足 120s。
      hub.rewindPending = true
      pushStatus(hub, { rewindPending: true })
      void s.sendControlAndWait('rewind_files', { user_message_id: at }, 120_000)
        .then(() => {
          if (processManager.get(hub.key) !== s || s.exited) {
            broadcast(hub, { kind: 'error', message: '恢复文件后会话已变化，未回滚对话' })
            return
          }
          rewindConversation(hub, at, 'both')
        })
        .catch((error) => {
          const detail = error instanceof Error ? error.message : String(error)
          broadcast(hub, { kind: 'error', message: `回滚文件失败，未回滚对话：${detail}` })
        })
        .finally(() => {
          hub.rewindPending = false
          pushStatus(hub, { rewindPending: false })
        })
      break
    }
    case 'btw': {
      // 侧问：fork 当前会话的一次性问答，不污染主会话
      const question = String(data.question ?? '').trim()
      if (isCodexKey(hub.key)) {
        const parsed = codexParseKey(hub.key)
        const tid = codexRuntime.get(hub.key)?.sessionId ?? parsed?.resumeThreadId
        if (!question || !tid) {
          broadcast(hub, { kind: 'btw_result', ok: false, text: '侧问需要已有会话（先发过至少一条消息）' })
          return
        }
        broadcast(hub, { kind: 'btw_pending', question })
        void codexRuntime
          .runEphemeralQuestion(tid, question, 180_000, (delta, thinking) => {
            broadcast(hub, { kind: 'btw_delta', question, delta, thinking: thinking || undefined })
          })
          .then((r) => broadcast(hub, { kind: 'btw_result', ok: true, question, text: r.text }))
          .catch((e) =>
            broadcast(hub, {
              kind: 'btw_result',
              ok: false,
              question,
              text: `侧问失败: ${e instanceof Error ? e.message : e}`,
            }),
          )
        return
      }
      const parsed = parseKey(hub.key)
      const sid = session()?.sessionId ?? parsed?.resumeSessionId
      if (!question || !parsed || !sid) {
        broadcast(hub, { kind: 'btw_result', ok: false, text: '侧问需要已有会话（先发过至少一条消息）' })
        return
      }
      runBtw(hub, parsed.cwd, sid, question)
      break
    }
    case 'query': {
      // 只读控制查询：mcp_status / get_settings / get_context_usage（claude 控制请求直通；
      // codex 仅 mcp_status 有对应物 mcpServerStatus/list）
      const id = String(data.id ?? '')
      const query = String(data.query ?? '')
      const reply = (payload: Record<string, unknown>) => broadcast(hub, { kind: 'query_result', id, ...payload })
      if (!id || !query) return
      if (isCodexKey(hub.key)) {
        if (query !== 'mcp_status') {
          reply({ ok: false, error: `codex 后端暂不支持 ${query}` })
          return
        }
        void codexRuntime
          .rpcRequest('mcpServerStatus/list', {})
          .then((d) => reply({ ok: true, data: d }))
          .catch((e) => reply({ ok: false, error: e instanceof Error ? e.message : String(e) }))
        return
      }
      let s = session()
      if (!s || s.exited) {
        ensureSpawned(hub)
        s = session()
      }
      if (!s || s.exited) {
        reply({ ok: false, error: '进程未运行' })
        return
      }
      s.sendControlAndWait(query, {}, 15_000)
        .then((d) => reply({ ok: true, data: d }))
        .catch((e) => reply({ ok: false, error: e instanceof Error ? e.message : String(e) }))
      break
    }
    case 'approval': {
      const requestId = String(data.requestId)
      hub.pendingApprovals.delete(requestId)
      if (isCodexKey(hub.key)) {
        const s = codexRuntime.get(hub.key)
        if (s && !s.exited) {
          try {
            s.sendApproval(requestId, data.decision as ApprovalDecision)
          } catch (e) {
            broadcast(hub, { kind: 'error', message: `审批回复失败: ${e}` })
          }
        }
        broadcast(hub, { kind: 'approval_resolved', requestId })
        publishInbox({ type: 'approval_resolved', key: hub.key, requestId })
        pushStatus(hub)
        return
      }
      const s = session()
      if (s && !s.exited) {
        try {
          s.sendApproval(requestId, data.decision as ApprovalDecision)
        } catch (e) {
          broadcast(hub, { kind: 'error', message: `审批回复失败: ${e}` })
        }
      }
      broadcast(hub, { kind: 'approval_resolved', requestId })
      publishInbox({ type: 'approval_resolved', key: hub.key, requestId })
      pushStatus(hub)
      s?.notifyExternalGate()
      break
    }
  }
}

// ---------- /btw 一次性侧问 ----------

import { resolveClaudeCommand } from './backends/claude/processManager'
import { spawn } from 'bun'

// ---------- 接力（handoff）编排 ----------

/**
 * POST /api/handoff { fromKey, toBackend, detail } → 立即应答；进度事件推到 fromKey 所在 Hub：
 * handoff_pending → handoff_done { targetKey, brief } / handoff_error { message }。
 * 目标会话由服务端直接创建并播种首条消息（无需浏览器在场）。
 */
function runHandoff(fromKey: string, toBackend: 'claude' | 'codex', detail: HandoffDetail): string | undefined {
  const sourceHub = hubs.get(fromKey)
  const fromBackend = isCodexKey(fromKey) ? ('codex' as const) : ('claude' as const)
  if (fromBackend === toBackend) return '接力目标必须与源会话是不同后端'

  // 源解析：cwd + 会话 id（codex 的 x| key 不含 cwd，需在异步路径里 thread/read 解析）
  let cwd: string | undefined
  let sourceId: string | undefined
  if (fromBackend === 'claude') {
    const parsed = parseKey(fromKey)
    cwd = parsed?.cwd
    sourceId = processManager.get(fromKey)?.sessionId ?? parsed?.resumeSessionId
    if (!cwd) return '无法确定源会话目录'
  } else {
    const parsed = codexParseKey(fromKey)
    cwd = parsed?.cwd
    sourceId = parsed?.resumeThreadId
  }
  if (!sourceId) return '源会话还没有任何消息，无法接力'

  const sid = sourceId
  void (async () => {
    try {
      // codex x| key：cwd 需要 thread/read 惰性解析
      const sourceCwd = cwd ?? (await codexRuntime.threadCwd(sid))
      if (!sourceCwd) throw new Error('无法确定源会话目录（thread/read 未返回 cwd）')
      if (sourceHub) broadcast(sourceHub, { kind: 'handoff_pending', toBackend })
      // 1. 源会话 fork 自摘要
      const { text: brief, usage } =
        fromBackend === 'claude'
          ? await generateClaudeBrief(sourceCwd, sid, detail)
          : await generateCodexBrief(sid, detail)
      if (sourceHub) broadcast(sourceHub, { kind: 'handoff_brief', brief })

      // 2. 目标会话播种（服务端直接发送首条消息）
      const targetKey = toBackend === 'codex' ? codexKeyForNew(sourceCwd) : `n|${encodeURIComponent(sourceCwd)}`
      const targetHub = getHub(targetKey)
      const seed = seedMessage(sourceCwd, fromBackend, brief)
      let targetSessionId: string | undefined
      if (toBackend === 'codex') {
        const s = await ensureCodexSession(targetHub)
        if (!s || s.exited) throw new Error('目标 codex 会话启动失败')
        s.sendUserText(seed)
        targetSessionId = s.sessionId
      } else {
        ensureSpawned(targetHub)
        const s = processManager.get(targetKey)
        if (!s || s.exited) throw new Error('目标 claude 会话启动失败')
        s.sendUserText(seed)
        targetSessionId = s.sessionId
      }
      // claude 的 sessionId 在 init 时才就绪：短轮询等待，随后回填真实 key（血缘导航用）
      if (toBackend === 'claude' && !targetSessionId) {
        const s = processManager.get(targetKey)
        const deadline = Date.now() + 30_000
        while (s && !s.sessionId && !s.exited && Date.now() < deadline) {
          await Bun.sleep(500)
        }
        targetSessionId = s?.sessionId
      }
      const toResolvedKey =
        toBackend === 'codex'
          ? targetSessionId
            ? `x|${targetSessionId}`
            : undefined
          : targetSessionId
            ? `s|${sanitizePath(sourceCwd)}|${targetSessionId}`
            : undefined
      const fromResolvedKey = (() => {
        if (fromBackend === 'claude') {
          if (fromKey.startsWith('s|')) return fromKey
          const sidNow = processManager.get(fromKey)?.sessionId
          return sidNow ? `s|${sanitizePath(sourceCwd)}|${sidNow}` : undefined
        }
        if (fromKey.startsWith('x|')) return fromKey
        const tidNow = codexRuntime.get(fromKey)?.sessionId
        return tidNow ? `x|${tidNow}` : undefined
      })()

      // 3. 血缘
      appendLineage({
        id: `ho-${Date.now().toString(36)}`,
        at: new Date().toISOString(),
        fromKey,
        toKey: targetKey,
        fromResolvedKey,
        toResolvedKey,
        fromBackend,
        toBackend,
        cwd: sourceCwd,
        detail,
        brief,
        briefUsage: usage,
      })
      if (sourceHub)
        broadcast(sourceHub, {
          kind: 'handoff_done',
          targetKey: toResolvedKey ?? targetKey,
          targetSessionId,
          toBackend,
          brief,
        })
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      if (sourceHub) broadcast(sourceHub, { kind: 'handoff_error', message })
    }
  })()
  return undefined
}

function runBtw(hub: Hub, cwd: string, sessionId: string, question: string): void {
  const { cmd, prefix } = resolveClaudeCommand()
  // Claude Code -p 支持 -n/--name：写入 custom-title，列表里可区分 fork 出来的侧问会话
  const oneLine = question.replace(/\s+/g, ' ').trim()
  const sessionName = `FORK: ${oneLine.length > 60 ? `${oneLine.slice(0, 57)}…` : oneLine}`
  let proc: ReturnType<typeof spawn>
  try {
    proc = spawn(
      [
        cmd,
        ...prefix,
        '-p',
        question,
        '--fork-session',
        '--resume',
        sessionId,
        '-n',
        sessionName,
        '--output-format',
        'stream-json',
        '--verbose',
        '--include-partial-messages',
      ],
      { cwd, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', env: { ...process.env } },
    )
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    broadcast(hub, { kind: 'btw_result', ok: false, question, text: `无法启动 claude CLI: ${message}` })
    return
  }
  broadcast(hub, { kind: 'btw_pending', question })

  // 逐行读 NDJSON：text/thinking 增量转发为 btw_delta，result 收尾
  const pump = async () => {
    const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader()
    const decoder = new TextDecoder()
    let buf = ''
    let finalText = ''
    let ok = true
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
      let nl: number
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim()
        buf = buf.slice(nl + 1)
        if (!line.startsWith('{')) continue
        let obj: Record<string, unknown>
        try {
          obj = JSON.parse(line)
        } catch {
          continue
        }
        if (obj.type === 'stream_event') {
          const ev = obj.event as { type?: string; delta?: { type?: string; text?: string; thinking?: string } } | undefined
          if (ev?.type === 'content_block_delta') {
            if (ev.delta?.type === 'text_delta' && ev.delta.text) {
              broadcast(hub, { kind: 'btw_delta', question, delta: ev.delta.text })
            } else if (ev.delta?.type === 'thinking_delta' && ev.delta.thinking) {
              broadcast(hub, { kind: 'btw_delta', question, delta: ev.delta.thinking, thinking: true })
            }
          }
        } else if (obj.type === 'result') {
          finalText = String(obj.result ?? '')
          ok = obj.is_error !== true
        }
      }
    }
    const code = await proc.exited
    broadcast(hub, { kind: 'btw_result', ok: ok && code === 0, question, text: finalText.trim() })
  }
  void pump().catch((e) => broadcast(hub, { kind: 'btw_result', ok: false, question, text: `侧问失败: ${e}` }))
}

// ---------- HTTP ----------

function json(data: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  })
}

function logWindowsPortState(stage: string, port: number): void {
  if (process.platform !== 'win32') return
  try {
    const result = Bun.spawnSync(['netstat.exe', '-ano', '-p', 'tcp'], {
      stdout: 'pipe',
      stderr: 'pipe',
      stdin: 'ignore',
    })
    const marker = `:${port}`
    const rows = result.stdout
      .toString()
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.includes(marker))
    console.log(
      `[port-diagnostic] stage=${stage} appPid=${process.pid} port=${port} rows=${rows.length}`,
    )
    for (const row of rows) console.log(`[port-diagnostic] ${row}`)
  } catch (e) {
    console.warn(`[port-diagnostic] stage=${stage} failed:`, e)
  }
}

const distDir = resolve(import.meta.dir, '../../web/dist')

const [bunMajor = 0, bunMinor = 0, bunPatch = 0] = Bun.version.split(/[.-]/).map(Number)
const hasWindowsSocketFix =
  process.platform !== 'win32' ||
  bunMajor > 1 ||
  bunMinor > 3 ||
  (bunMinor === 3 && bunPatch >= 15) ||
  Bun.version.includes('canary')

if (!hasWindowsSocketFix && process.env.CC_REMOTE_ALLOW_UNSAFE_BUN !== '1') {
  console.error(
    `[cc-remote] Bun ${Bun.version} on Windows has the inherited-listener bug oven-sh/bun#36936.`,
  )
  console.error('[cc-remote] Run `bun upgrade --canary` and restart the terminal. Server startup refused.')
  process.exit(1)
}

async function handleApi(req: Request, url: URL): Promise<Response | undefined> {
  if (url.pathname === '/api/sessions' && req.method === 'GET') {
    const sessions = listSessions()
    // 项目行 git 分支：按 cwd 各读一次（普通仓库与 worktree 都支持）
    const branchOf = (cwd?: string): string | undefined => {
      if (!cwd) return undefined
      if (!branchCache.has(cwd)) branchCache.set(cwd, readGitBranch(cwd))
      return branchCache.get(cwd)
    }
    const branchCache = new Map<string, string | undefined>()
    const claudeRows = sessions.map((s: SessionInfo) => ({
      ...s,
      backend: 'claude' as const,
      gitBranch: branchOf(s.cwd),
      key: keyFor(s.slug, s.sessionId),
      managed: statusOf(keyFor(s.slug, s.sessionId)),
    }))
    // codex 线程：app-server 未安装/未登录时静默降级为空列表，不拖垮 claude 列表
    let codexRows: Record<string, unknown>[] = []
    try {
      const threads = await codexBackend.listSessions()
      codexRows = threads.map((t) => ({
        sessionId: t.id,
        cwd: t.cwd,
        slug: 'codex',
        title: t.title,
        lastPrompt: t.lastPrompt,
        mtime: t.mtime,
        sizeBytes: 0,
        status: t.status,
        backend: 'codex' as const,
        gitBranch: branchOf(t.cwd),
        key: t.key,
        managed: codexStatusOf(t.key),
      }))
    } catch (e) {
      console.warn('[api] codex thread/list 失败（仅返回 claude 会话）:', e instanceof Error ? e.message : e)
    }
    return json([...codexRows, ...claudeRows])
  }
  if (url.pathname === '/api/sessions' && req.method === 'POST') {
    const body = (await req.json().catch(() => ({}))) as { cwd?: string; backend?: string }
    if (!body.cwd) return json({ error: '缺少 cwd' }, { status: 400 })
    if (body.backend === 'codex') {
      return json({ key: codexKeyForNew(body.cwd), slug: 'codex', backend: 'codex' })
    }
    return json({ key: `n|${encodeURIComponent(body.cwd)}`, slug: sanitizePath(body.cwd), backend: 'claude' })
  }
  if (url.pathname === '/api/fs/list' && req.method === 'GET') {
    // searchParams.get 已完成 URL 解码，禁止再 decodeURIComponent（含 % 的路径会被二次解码破坏）
    const target = url.searchParams.get('path') ?? ''
    try {
      return json(listDirectories(target))
    } catch (e) {
      if (e instanceof FsBrowseError) return json({ error: e.message }, { status: e.status })
      const message = e instanceof Error ? e.message : String(e)
      return json({ error: message }, { status: 500 })
    }
  }
  if (url.pathname === '/api/sessions/rename' && req.method === 'POST') {
    const body = (await req.json().catch(() => ({}))) as { key?: string; title?: string }
    const title = body.title?.trim()
    if (!body.key || !title) return json({ error: '缺少 key 或 title' }, { status: 400 })
    // codex：官方 API，loaded/stored thread 均可
    if (isCodexKey(body.key)) {
      const threadId = body.key.split('|')[1]
      if (!threadId) return json({ error: '无法解析 threadId' }, { status: 400 })
      try {
        await codexRuntime.rpcRequest('thread/name/set', { threadId, name: title })
        return json({ ok: true })
      } catch (e) {
        return json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 })
      }
    }
    // claude：仅离线会话（在线会话的 transcript 由 CLI 持有，改名走其内部路径）
    const parts = body.key.split('|')
    if (parts[0] !== 's' || parts.length !== 3) return json({ error: '仅支持已有 claude 会话' }, { status: 400 })
    const [, slug, sessionId] = parts
    if (processManager.get(body.key) || liveSessionInfo(sessionId)) {
      return json({ error: '会话正在运行，请在 CLI 退出后改名' }, { status: 409 })
    }
    const file = join(config.claudeConfigDir, 'projects', slug, `${sessionId}.jsonl`)
    if (!existsSync(file)) return json({ error: 'transcript 不存在' }, { status: 404 })
    try {
      // 与官方 /rename 相同的条目形状；discovery 读取时后者优先
      appendFileSync(file, JSON.stringify({ type: 'custom-title', sessionId, customTitle: title }) + '\n')
      return json({ ok: true })
    } catch (e) {
      return json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 })
    }
  }
  if (url.pathname === '/api/handoff' && req.method === 'POST') {
    const body = (await req.json().catch(() => ({}))) as {
      fromKey?: string
      toBackend?: string
      detail?: HandoffDetail
    }
    if (!body.fromKey) return json({ error: '缺少 fromKey' }, { status: 400 })
    if (body.toBackend !== 'claude' && body.toBackend !== 'codex') {
      return json({ error: 'toBackend 必须是 claude 或 codex' }, { status: 400 })
    }
    const detail: HandoffDetail =
      body.detail === 'brief' || body.detail === 'detailed' ? body.detail : 'standard'
    const error = runHandoff(body.fromKey, body.toBackend, detail)
    if (error) return json({ error }, { status: 400 })
    return json({ ok: true })
  }
  if (url.pathname === '/api/lineage' && req.method === 'GET') {
    const key = url.searchParams.get('key') ?? ''
    const records = lineageFor(key)
    // 为链上每个 key 附带导航所需的节点元数据（前端接力链渲染用）
    const nodes: Record<string, Record<string, unknown>> = {}
    for (const r of records) {
      for (const k of [r.fromKey, r.toKey, r.fromResolvedKey, r.toResolvedKey]) {
        if (!k || nodes[k]) continue
        const parts = k.split('|')
        if (parts[0] === 's' && parts.length === 3) {
          nodes[k] = { key: k, backend: 'claude', slug: parts[1], sessionId: parts[2], cwd: r.cwd }
        } else if (parts[0] === 'x' && parts.length === 2) {
          nodes[k] = { key: k, backend: 'codex', slug: 'codex', sessionId: parts[1], cwd: r.cwd }
        } else if (parts[0] === 'n' || parts[0] === 'xn') {
          nodes[k] = {
            key: k,
            backend: parts[0] === 'xn' ? 'codex' : 'claude',
            slug: parts[0] === 'xn' ? 'codex' : sanitizePath(decodeURIComponent(parts[1] ?? '')),
            sessionId: 'new',
            cwd: r.cwd,
          }
        }
      }
    }
    return json({ records, nodes })
  }
  const histMatch = url.pathname.match(/^\/api\/history\/([^/]+)\/([^/]+)$/)
  if (histMatch && req.method === 'GET') {
    const [, slug, sessionId] = histMatch
    // fileBytes = 本次实际读取的字节数，前端拿它作为 tailer 的起始偏移
    return json(readHistory(slug, sessionId))
  }
  // codex 历史：thread/read includeTurns（只读），无 tailer 偏移概念
  const codexHistMatch = url.pathname.match(/^\/api\/codex\/history\/([^/]+)$/)
  if (codexHistMatch && req.method === 'GET') {
    try {
      const messages = await codexBackend.readHistory(codexHistMatch[1])
      return json({ messages, fileBytes: 0 })
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      return json({ error: message }, { status: 500 })
    }
  }
  // codex 模型目录（model/list）：模型 id/显示名/effort 列表/默认 effort
  if (url.pathname === '/api/codex/models' && req.method === 'GET') {
    try {
      const models = await codexRuntime.listModels()
      return json({ models })
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      return json({ error: message }, { status: 500 })
    }
  }
  if (url.pathname === '/api/config' && req.method === 'GET') {
    return json({
      permissionPolicy: config.permissionPolicy,
      permissionModes: ['default', 'acceptEdits', 'auto', 'plan', 'bypassPermissions'],
      effortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
      models: ['haiku', 'sonnet', 'opus', 'fable'],
      authRequired: !!config.authToken,
    })
  }
  return undefined
}

let server: ReturnType<typeof Bun.serve<WSData>>

// 绑定非回环地址却不配置 token = 把"任意目录起会话 + 任意命令执行"裸奔到网络上，拒绝启动
if (!isLoopbackHost(config.host) && !config.authToken) {
  console.error(`[cc-remote] 拒绝启动：host=${config.host} 为非回环地址，但未配置 authToken。`)
  console.error('[cc-remote] 请在 cc-remote.config.json 设置 "authToken" 或设置环境变量 CC_REMOTE_TOKEN。')
  process.exit(1)
}

try {
  server = Bun.serve<WSData>({
    port: config.port,
    hostname: config.host,
    async fetch(req, srv) {
      const url = new URL(req.url)

      // 数据面/控制面统一鉴权（静态壳不鉴权，JS 中无敏感数据）
      const guarded = url.pathname.startsWith('/api/') || url.pathname.startsWith('/ws/')
      if (guarded && !isAuthorized(req, url)) {
        return json({ error: 'unauthorized' }, { status: 401 })
      }

      const wsMatch = url.pathname.match(/^\/ws\/sessions\/(.+)$/)
      if (wsMatch) {
        const key = decodeURIComponent(wsMatch[1])
        if (srv.upgrade(req, { data: { key } })) return undefined
        return new Response('WebSocket upgrade failed', { status: 400 })
      }

      // 全局收件箱频道：跨会话审批/完成/错误汇总
      if (url.pathname === '/ws/inbox') {
        if (srv.upgrade(req, { data: { inbox: true } })) return undefined
        return new Response('WebSocket upgrade failed', { status: 400 })
      }

      if (url.pathname.startsWith('/api/')) {
        const res = await handleApi(req, url)
        if (res) return res
        return json({ error: 'not found' }, { status: 404 })
      }

      // 静态托管 web/dist
      if (existsSync(distDir)) {
        const p = join(distDir, url.pathname === '/' ? 'index.html' : url.pathname)
        const f = Bun.file(p)
        if (await f.exists()) return new Response(f)
        const index = Bun.file(join(distDir, 'index.html')) // SPA 回退
        if (await index.exists()) return new Response(index)
      }
      return new Response('cc-remote server (web 未构建，请用 vite dev 或 bun run build)', { status: 200 })
    },
    websocket: {
      open(ws) {
        if (ws.data.inbox) {
          inboxClients.add(ws as import('bun').ServerWebSocket<WSDataInbox>)
          ws.send(JSON.stringify(inboxSnapshot()))
          return
        }
        const hub = getHub(ws.data.key)
        hub.clients.add(ws)
        processManager.get(ws.data.key)?.attachClient()
        codexRuntime.get(ws.data.key)?.attachClient()
        ws.send(JSON.stringify({ kind: 'status', state: statusOf(ws.data.key) }))
        for (const a of hub.pendingApprovals.values()) {
          ws.send(JSON.stringify({ kind: 'approval_request', ...a }))
        }
      },
      message(ws, raw) {
        if (ws.data.inbox) return // inbox 频道只发不收
        const hub = getHub(ws.data.key)
        try {
          handleClientMessage(hub, typeof raw === 'string' ? raw : raw.toString())
        } catch (e) {
          const message = e instanceof Error ? e.message : String(e)
          console.error(`[ws ${hub.key}] 处理消息异常:`, message)
          try {
            ws.send(JSON.stringify({ kind: 'error', message }))
          } catch {}
        }
      },
      close(ws) {
        if (ws.data.inbox) {
          inboxClients.delete(ws as import('bun').ServerWebSocket<WSDataInbox>)
          return
        }
        const hub = hubs.get(ws.data.key)
        if (!hub) return
        hub.clients.delete(ws)
        // 不变量：任何后端的会话句柄存活期间，其 Hub 必须存活——
        // 否则重连时复用旧会话，其回调会把事件广播进已删除的 Hub（消息黑洞）。
        const alive = isCodexKey(ws.data.key)
          ? (() => {
              const s = codexRuntime.get(ws.data.key)
              s?.detachClient()
              return !!s && !s.exited
            })()
          : (() => {
              const s = processManager.get(ws.data.key)
              s?.detachClient()
              return !!s
            })()
        if (hub.clients.size === 0) {
          stopTailer(hub)
          if (!alive) hubs.delete(ws.data.key)
        }
      },
    },
  })
} catch (e) {
  const msg = e instanceof Error ? e.message : String(e)
  console.error(
    `[cc-remote] bind failed port=${config.port} pid=${process.pid} ppid=${process.ppid} bun=${Bun.version}: ${msg}`,
  )
  logWindowsPortState('bind-failed', config.port)
  if (process.platform === 'win32') {
    console.error(
      '[cc-remote] 若 LISTENING PID 已不存在，通常是 Bun <=1.3.14 的 socket handle 继承问题；先升级 canary。已形成且找不到持有进程的绑定需重启 Windows 一次。',
    )
  }
  process.exit(1)
}

// 通配绑定（0.0.0.0/::）时二维码与日志要显示可路由的局域网地址
function lanAddress(): string {
  for (const addrs of Object.values(networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family === 'IPv4' && !a.internal) return a.address
    }
  }
  return 'localhost'
}
const displayHost = isLoopbackHost(config.host)
  ? 'localhost'
  : config.host === '0.0.0.0' || config.host === '::'
    ? lanAddress()
    : config.host
const accessUrl = `http://${displayHost}:${server.port}/${config.authToken ? `?token=${config.authToken}` : ''}`
console.log(
  `[cc-remote] listening on ${accessUrl} pid=${process.pid} ppid=${process.ppid} bun=${Bun.version}`,
)
console.log(`[cc-remote] permissionPolicy=${config.permissionPolicy} claudeConfigDir=${config.claudeConfigDir}`)
if (!config.authToken) {
  console.log('[cc-remote] 未配置 authToken，仅监听回环地址。需要局域网访问时：配置 authToken 并设置 host。')
}

// 局域网模式：打印扫码即入的终端二维码（URL 已带 token）
if (!isLoopbackHost(config.host)) {
  try {
    const { default: QRCode } = await import('qrcode')
    console.log(await QRCode.toString(accessUrl, { type: 'terminal', small: true }))
  } catch (e) {
    console.warn('[cc-remote] 二维码生成失败（不影响服务）:', e)
  }
}

let shuttingDown = false
async function shutdown(reason: string): Promise<void> {
  if (shuttingDown) {
    console.warn(`[cc-remote] shutdown already in progress; repeated=${reason}`)
    return
  }
  shuttingDown = true
  const started = performance.now()
  console.log(`[cc-remote] shutdown begin reason=${reason} pid=${process.pid}`)

  // 先发起 listener/连接关闭，再清 Claude 子进程。Bun <=1.3.14 在 Windows
  // 会让这些子进程继承监听 handle；两边都完成前绝不能 process.exit()。
  let stopPromise: Promise<void>
  try {
    console.log('[cc-remote] server.stop(true) begin')
    stopPromise = Promise.resolve(server.stop(true))
  } catch (e) {
    console.error('[cc-remote] server.stop(true) invoke failed:', e)
    stopPromise = Promise.resolve()
  }

  try {
    processManager.disposeAll()
    codexRuntime.disposeAll()
  } catch (e) {
    console.error('[cc-remote] disposeAll 失败:', e)
  }

  const timeout = new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 5_000))
  const stopped = stopPromise.then(
    () => 'stopped' as const,
    (e) => {
      console.error('[cc-remote] server.stop(true) rejected:', e)
      return 'failed' as const
    },
  )
  const result = await Promise.race([stopped, timeout])
  console.log(
    `[cc-remote] shutdown server=${result} elapsedMs=${Math.round(performance.now() - started)}`,
  )

  if (result === 'timeout') {
    // 到这里 listener 已调用 stop，强退只是最后兜底；正常路径不应触发。
    console.error('[cc-remote] shutdown timed out after 5s; forcing exit')
    process.exit(1)
  }
  logWindowsPortState('after-stop', config.port)
  console.log(`[cc-remote] shutdown complete elapsedMs=${Math.round(performance.now() - started)}`)
  process.exit(0)
}

process.on('SIGINT', () => void shutdown('SIGINT'))
process.on('SIGTERM', () => void shutdown('SIGTERM'))
process.on('exit', (code) => {
  console.log(`[cc-remote] process exit pid=${process.pid} code=${code} shuttingDown=${shuttingDown}`)
})
