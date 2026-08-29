// anyplane 服务端入口：REST + WebSocket + 静态托管

import { appendFileSync, existsSync } from 'node:fs'
import { networkInterfaces } from 'node:os'
import { join, resolve } from 'node:path'
import { hostAllowed, isAuthorized, isLoopbackHost, jsonContentTypeRequired, originAllowed } from './auth'
import { keyFor, keyForBranch, keyForNew, parseKey, splitExistingKey, type ParsedKey } from './backends/claude/backend'
import { listSessions, liveSessionInfo, readHistory, sanitizePath, type SessionInfo } from './backends/claude/discovery'
import { resolveTierModelNames } from './backends/claude/modelNames'
import { processManager, type ApprovalDecision, type SpawnOptions } from './backends/claude/processManager'
import { isInternalUserMessage, type CliMessage } from './backends/claude/protocol'
import { TranscriptTailer } from './backends/claude/tailer'
import { isCodexKey, keyForNew as codexKeyForNew, listSessions as listCodexSessions, parseKey as codexParseKey, readHistory as readCodexHistory, splitThreadId } from './backends/codex/backend'
import { codexRuntime, type CodexSession } from './backends/codex/runtime'
import { config, defaultPermissionMode } from './config'
import { isOwnServerProcess, takeoverStaleListeners } from './portTakeover'
import { archiveClaudeSession, listTrash, restoreClaudeSession } from './archive'
import { FsBrowseError, listDirectories, readGitBranch } from './fsbrowse'
import { resolveUpload } from './uploads'
import {
  addSubscription,
  pushToAll,
  pushWebhooksToAll,
  removeSubscription,
  subscriptionCount,
  vapidPublicKey,
  validSecret,
  webhookCount,
  type PushPayload,
} from './push'
import {
  appendLineage,
  briefPrompt,
  generateClaudeBrief,
  generateCodexBrief,
  lineageFor,
  seedMessage,
  type HandoffDetail,
} from './handoff'
import { errorMessage, hasWindowsSocketFix } from './util'

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
  /** 下行保活定时器（见 websocket handler 注释） */
  keepalive?: ReturnType<typeof setInterval>
}

interface WSDataInbox {
  inbox: true
  key?: never
  keepalive?: ReturnType<typeof setInterval>
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
  /** 当前目标（claude /goal 由出站消息解析跟踪；codex 由 thread/goal/* 通知驱动） */
  goal?: { condition: string; since: number }
  /** /clear 触发的对话重置：conversation_reset 到达后置位，紧随的 init 完成 Hub 重键 */
  pendingRekey?: boolean
  /** 当前会话的 sessionId（每次 system/init 更新；/clear 重键后是新值） */
  sessionId?: string
  /** 已为哪个 sessionId 生成过 AI 标题（按会话去重，/clear 后的新会话自然再触发一次） */
  titleGeneratedFor?: string
  /** 首条 user 消息原文（标题素材）：init 未到时先记账，maybeGenerateTitle 两路触发 */
  pendingTitleText?: string
  /** sessionNameOf 的 s| key cwd 缓存：parseKey 反查 listSessions 至多一次（'' = 已查过、未知） */
  nameCwd?: string
}

const hubs = new Map<string, Hub>()

// ---------- 全局收件箱（/ws/inbox）：跨会话审批/完成/错误汇总 ----------

const inboxClients = new Set<import('bun').ServerWebSocket<WSDataInbox>>()

type InboxEvent =
  | { type: 'approval'; key: string; requestId: string; toolName: string; input: unknown }
  | { type: 'approval_resolved'; key: string; requestId: string }
  | { type: 'done'; key: string; ok: boolean }
  | { type: 'error'; key: string; message: string }

function publishInbox(ev: InboxEvent): void {
  if (inboxClients.size > 0) {
    const text = JSON.stringify(ev)
    for (const ws of inboxClients) {
      try {
        ws.send(text)
      } catch {}
    }
  }
  fanoutPush(ev)
}

// ---------- Web Push 分发（订阅为 0 时零开销） ----------

/** 会话显示名：项目目录 basename（approval 只在 spawn 后发生，spawnOpts.cwd 必有）。
 *  s| 未 spawn 时经 parseKey 反查真实 cwd——每 Hub 至多一次（缓存在 hub.nameCwd，
 *  避免推送事件触发反复 listSessions 全盘扫描）；b|/n|/xn| 的 cwd 内嵌在 key 里直接取。
 *  parseKey 也查不到（slug 目录已删）时以 slug 末段近似。 */
function sessionNameOf(key: string): string {
  const base = (cwd: string) => cwd.replace(/\/+$/, '').split('/').pop() ?? cwd
  const hub = hubs.get(key)
  if (hub?.spawnOpts?.cwd) return base(hub.spawnOpts.cwd)
  const parts = key.split('|')
  try {
    if ((parts[0] === 'b' || parts[0] === 'n' || parts[0] === 'xn') && parts[1]) {
      return base(decodeURIComponent(parts[1]))
    }
  } catch {
    // key 内嵌 cwd 不是合法 URI 编码（状态损坏/构造输入）：落 key 截断，不影响推送分发
    return key.slice(0, 18)
  }
  if (parts[0] === 's') {
    if (hub && hub.nameCwd === undefined) hub.nameCwd = parseKey(key)?.cwd ?? ''
    if (hub?.nameCwd) return base(hub.nameCwd)
    // slug 是 sanitizePath(cwd)：末段即目录名（近似，仅推送显示用）
    if (parts[1]) return parts[1].split('-').pop() ?? key.slice(0, 18)
  }
  return key.slice(0, 18)
}

/** 审批输入摘要：Bash 给命令、Edit/Write 给路径，其余给 JSON 截断 */
function summarizeInput(toolName: string, input: unknown): string {
  const obj = (input ?? {}) as Record<string, unknown>
  if (toolName === 'Bash') return String(obj.command ?? '').slice(0, 400)
  if (obj.file_path) return String(obj.file_path)
  if (obj.path) return String(obj.path)
  const json = JSON.stringify(input ?? {})
  return json.length > 300 ? json.slice(0, 300) + '…' : json
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/**
 * webhook 审批确认页（GET /api/approval-page 的 HTML）。
 * 故意零依赖零外链（微信内置浏览器可达性）；k/r/s 由页面 JS 从自身 URL 读取，
 * 服务端只注入已转义的工具名与摘要，不把 secret 写进 HTML。
 */
function approvalPageHtml(key: string, pending?: PendingApproval): string {
  const session = escapeHtml(sessionNameOf(key))
  const tool = pending ? escapeHtml(pending.toolName) : ''
  const summary = pending ? escapeHtml(summarizeInput(pending.toolName, pending.input)) : ''
  const inner = pending
    ? `<p class="meta">${session}</p>
  <h1>需要审批 · ${tool}</h1>
  <pre>${summary}</pre>
  <div class="row">
    <button class="ok" onclick="act('allow')">允许</button>
    <button class="no" onclick="act('deny')">拒绝</button>
  </div>
  <p id="st" class="meta"></p>`
    : `<h1>审批已处理</h1>
  <p class="meta">${session} · 该请求已被裁决或不存在，无需操作</p>`
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<title>审批 · AnyPlane</title>
<style>
  body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#16130f;color:#e8e2d9;font:14px/1.6 ui-monospace,SFMono-Regular,Menlo,monospace}
  .card{box-sizing:border-box;width:100%;max-width:26rem;margin:1rem;padding:1.25rem;border:1px solid #3a332a;border-radius:.5rem;background:#1e1a15}
  h1{font-size:1rem;margin:.25rem 0 .75rem}
  .meta{color:#8a8175;font-size:.75rem;word-break:break-all}
  pre{white-space:pre-wrap;word-break:break-all;background:#16130f;border:1px solid #3a332a;border-radius:.375rem;padding:.625rem;font-size:.75rem;max-height:40vh;overflow:auto}
  .row{display:flex;gap:.625rem;margin-top:1rem}
  button{flex:1;padding:.75rem;border-radius:.375rem;border:1px solid;font-size:.875rem;cursor:pointer;background:transparent;color:inherit}
  button:disabled{opacity:.4;cursor:default}
  .ok{border-color:#6f9f6f;color:#9fce9f}
  .no{border-color:#9f6f6f;color:#ce9f9f}
</style>
</head>
<body>
<div class="card">${inner}</div>
<script>
async function act(d){
  document.querySelectorAll('button').forEach(function(b){b.disabled=true})
  var st=document.getElementById('st')
  st.textContent='提交中…'
  var p=new URL(location.href).searchParams
  try{
    var resp=await fetch('/api/approval-action?k='+encodeURIComponent(p.get('k')||'')+'&r='+encodeURIComponent(p.get('r')||'')+'&d='+d+'&s='+encodeURIComponent(p.get('s')||''),{method:'POST'})
    var j=await resp.json()
    st.textContent=j.ok?(d==='allow'?'✓ 已允许':'✓ 已拒绝'):('失败：'+(j.error||resp.status))
    if(!j.ok)document.querySelectorAll('button').forEach(function(b){b.disabled=false})
  }catch(e){
    st.textContent='网络错误，请重试'
    document.querySelectorAll('button').forEach(function(b){b.disabled=false})
  }
}
</script>
</body>
</html>`
}

function fanoutPush(ev: InboxEvent): void {
  if (subscriptionCount() === 0 && webhookCount() === 0) return
  if (ev.type === 'approval_resolved') return // 审批已处理，无需推送（通知 tag 替换语义下保留现状即可）
  const session = sessionNameOf(ev.key)
  let payload: PushPayload
  if (ev.type === 'approval') {
    payload = {
      type: 'approval',
      title: `需要审批 · ${ev.toolName}`,
      body: `${session}｜${summarizeInput(ev.toolName, ev.input)}`,
      key: ev.key,
      session,
      requestId: ev.requestId,
      // 能力 URL：secret 由 pushToAll 按订阅逐个补全（每个订阅一个能力密钥）
      actions: {
        allow: `/api/approval-action?k=${encodeURIComponent(ev.key)}&r=${encodeURIComponent(ev.requestId)}&d=allow&s=`,
        deny: `/api/approval-action?k=${encodeURIComponent(ev.key)}&r=${encodeURIComponent(ev.requestId)}&d=deny&s=`,
      },
      tag: `ccr-a-${ev.requestId}`,
    }
  } else if (ev.type === 'done') {
    payload = {
      type: 'done',
      title: `${ev.ok ? '✓ 完成' : '✗ 结束（有错）'} · ${session}`,
      body: '会话已空闲，点击查看结果',
      key: ev.key,
      session,
      tag: `ccr-d-${ev.key}`,
    }
  } else {
    payload = {
      type: 'error',
      title: `⚠ 出错 · ${session}`,
      body: ev.message.slice(0, 300),
      key: ev.key,
      session,
      tag: `ccr-e-${ev.key}`,
    }
  }
  void pushToAll(payload).catch((e) => console.warn('[push] fanout 异常:', e))
  void pushWebhooksToAll(payload).catch((e) => console.warn('[push] webhook fanout 异常:', e))
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

function broadcastError(hub: Hub, message: string): void {
  broadcast(hub, { kind: 'error', message })
}

/** 两后端会话状态的公共字段（claude/codex 会话句柄结构化同形，契约见 backends/types.ts 末尾） */
function baseStatusOf(
  s:
    | {
        exited: boolean
        busy: boolean
        waiting: boolean
        sessionState: string
        sessionId: string | undefined
        connectedClients: number
        tokenUsage: unknown
      }
    | undefined,
  hub: Hub | undefined,
  waiting: boolean,
): Record<string, unknown> {
  return {
    spawned: !!s && !s.exited,
    busy: (s?.busy ?? false) || waiting,
    waiting,
    sessionState: s?.sessionState ?? 'idle',
    sessionId: s?.sessionId,
    clients: s?.connectedClients ?? hub?.clients.size ?? 0,
    usage: s?.tokenUsage,
    permissionMode: hub?.spawnOpts?.permissionMode,
    effort: hub?.spawnOpts?.effort,
  }
}

/** liveHint：调用方（/api/sessions）刚做过 pid 扫描时传入复用，避免每行各扫一次；
 *  显式 null 表示"已知不在线"（跳过扫描），undefined 才现扫 */
function statusOf(key: string, liveHint?: { status: string; pid: number } | null): Record<string, unknown> {
  if (isCodexKey(key)) return codexStatusOf(key)
  const s = processManager.get(key)
  const hub = hubs.get(key)
  const pending = hub?.pendingApprovals.size ?? 0
  // 未被本服务 spawn 的会话：读 pid 文件，把外部 CLI 的实时状态反映到 busy/waiting
  let live: { status: string; pid: number } | undefined
  if (!s || s.exited) {
    const ek = splitExistingKey(key)
    if (ek) live = liveHint === undefined ? liveSessionInfo(ek.sessionId) : (liveHint ?? undefined)
  }
  const waiting = (s?.waiting ?? false) || pending > 0 || live?.status === 'waiting'
  const st = baseStatusOf(s, hub, waiting)
  if (live?.status === 'busy') st.busy = true // 审批等待与外部进程 busy 都算 busy，防止误回收
  return {
    ...st,
    activeTaskCount: s?.activeTaskCount ?? 0,
    activeTasks: s?.backgroundTasks ?? [],
    slashCommands: s?.slashCommands,
    // spawnOpts.model 是用户显式选择（未 spawn 时的待应用值）；initModel 是进程 init 报告的解析后 ID。
    // 后者让重连 attach 的页面不必等下一轮就能显示模型（StatusPill 再经 modelNames 映射成配置名）
    model: hub?.spawnOpts?.model ?? s?.initModel,
    tailing: !!hub?.tailer,
    liveStatus: live?.status,
    goal: hub?.goal ?? null,
  }
}

function pushStatus(hub: Hub, extra?: Record<string, unknown>): void {
  broadcast(hub, { kind: 'status', state: { ...statusOf(hub.key), ...extra } })
}

/** codex 会话状态：与 statusOf 同形，供列表 managed 字段与 WS status 复用 */
function codexStatusOf(key: string): Record<string, unknown> {
  const s = codexRuntime.get(key)
  const hub = hubs.get(key)
  const waiting = (s?.waiting ?? false) || (hub?.pendingApprovals.size ?? 0) > 0
  return {
    ...baseStatusOf(s, hub, waiting),
    activeTaskCount: 0,
    activeTasks: [],
    model: hub?.spawnOpts?.model,
    tailing: false,
    goal: s?.goal ?? null,
  }
}

/**
 * 官方 AI 标题（generate_session_title）：首条真实 user 消息 × 首个 init 双条件齐备即触发。
 * 两路调用——user 消息时（sessionId 已知）与 init 到达时（消息已记账）；按 sessionId 去重，
 * /clear 重键后的新会话自然再生成一次。CLI persist 把 ai-title 写进 transcript，
 * discovery 标题链（custom-title > ai-title > summary > 首条消息）自动接住，列表轮询内出现。
 */
function maybeGenerateTitle(hub: Hub): void {
  const sid = hub.sessionId
  const text = hub.pendingTitleText
  if (!sid || !text || hub.titleGeneratedFor === sid) return
  const s = processManager.get(hub.key)
  if (!s) return
  hub.titleGeneratedFor = sid
  hub.pendingTitleText = undefined
  void s
    .generateSessionTitle(text)
    .then((title) => {
      if (title) console.log(`[title] ${sessionNameOf(hub.key)} → ${title}`)
    })
    .catch(() => {}) // 标题失败无害：列表回退首条消息摘要
}

/** 两个后端共用的会话回调：CLI/翻译层消息广播、审批入 Hub 表、状态推动 */
function sessionCallbacks(hub: Hub) {
  return {
    onMessage: (msg: CliMessage) => {
      // 后台 Agent 完成通知会作为伪装成 user 的内部 XML 记录出现。
      // 生命周期本身已由 ProcessManager 消费为 system/task_notification；
      // 不再把原始内部载荷广播进主聊天或 rewind 历史。
      if (isInternalUserMessage(msg)) return
      // /clear（别名 /reset /new）：CLI 发 conversation_reset 并以新 session_id 续跑。
      // Hub 随之重键到 s|slug|<newSid>——新会话页承载后续对话，旧 transcript 原样留存。
      if (msg.type === 'conversation_reset') {
        hub.pendingRekey = true
        return // 原始事件不进主抄本，迁移以 moved 事件表达
      }
      if (hub.pendingRekey && msg.type === 'system' && msg.subtype === 'init') {
        hub.pendingRekey = false
        const newSid = String(msg.session_id ?? '')
        const cwd = hub.spawnOpts?.cwd ?? parseKey(hub.key)?.cwd
        if (newSid && cwd) {
          const newKey = keyFor(sanitizePath(cwd), newSid)
          const oldKey = hub.key
          hubs.delete(oldKey)
          hub.goal = undefined // 上下文已清，goal 与待审批随之失效
          hub.pendingApprovals.clear()
          hub.pendingTitleText = undefined // 旧会话的标题素材不带给新会话
          hub.key = newKey
          hubs.set(newKey, hub)
          // 进程 map 同步重键：否则按新 key 查不到进程会再 spawn 一个（双进程同 transcript）
          processManager.rekey(oldKey, newKey)
          // 重键后同步改写存活连接的 data.key：message 路由（getHub(ws.data.key)）依赖它，
          // 否则旧 key 上的后续消息会新建空 Hub（消息黑洞）
          for (const ws of hub.clients) {
            if (!ws.data.inbox) ws.data.key = newKey
          }
          // 已知限制：新 transcript 文件尚未落盘时 parseKey 无法反查 cwd（进程存活期间无影响，
          // spawnOpts 持有 cwd；空闲回收后若文件仍未写则报"无法解析会话"）
          broadcast(hub, { kind: 'moved', targetKey: newKey, targetSessionId: newSid, reason: 'clear' })
          pushStatus(hub)
        }
      }
      // 每个 init 都更新会话身份（首次 spawn 与 /clear 重键共用；rekey 分支不落 return，会走到这里）
      if (msg.type === 'system' && msg.subtype === 'init') {
        hub.sessionId = String(msg.session_id ?? '') || undefined
        maybeGenerateTitle(hub) // 首条消息可能已记账在等 sessionId
      }
      broadcast(hub, { kind: 'cli', msg })
      // turn 收尾是收件箱的核心提醒信号（agent 跑完了）
      if (msg.type === 'result') {
        publishInbox({ type: 'done', key: hub.key, ok: msg.is_error !== true })
        // claude /goal：goal 激活期间 turn 只会因"条件达成"结束（Stop hook 拦截其余收尾），
        // 所以 result 到达即视为目标完成（用户中断也会到此，chip 随之清除，语义可接受）
        if (hub.goal) {
          hub.goal = undefined
          pushStatus(hub)
        }
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
    broadcastError(hub, '无法解析 codex 会话 key')
    return undefined
  }
  const spawnOpts = {
    cwd: parsed.cwd,
    resumeThreadId: parsed.resumeThreadId,
    permissionMode: defaultPermissionMode(),
    ...hub.spawnOpts,
    ...opts,
  }
  hub.spawnOpts = spawnOpts
  const s = codexRuntime.ensure(hub.key, spawnOpts, sessionCallbacks(hub))
  s.syncClients(hub.clients.size)
  try {
    await s.start()
  } catch (e) {
    broadcastError(hub, errorMessage(e))
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
  const ek = splitExistingKey(hub.key)
  if (!ek) return // 新会话还没有 transcript
  if (processManager.get(hub.key)) return // 已 spawn：live 流覆盖，无需 tail
  const path = join(config.claudeConfigDir, 'projects', ek.slug, `${ek.sessionId}.jsonl`)
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
    broadcastError(hub, '无法回滚：未知会话 ID')
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
  parsedHint?: ParsedKey,
): void {
  // parseKey 会反查 listSessions()（一次文件系统扫描）；调用方已解析过时直接复用
  const parsed = parsedHint ?? parseKey(hub.key)
  if (!parsed) {
    broadcastError(hub, '无法解析会话（项目目录不存在？）')
    return
  }
  const spawnOpts: SpawnOptions = {
    cwd: parsed.cwd,
    resumeSessionId: parsed.resumeSessionId,
    forkFromSessionId: parsed.forkFromSessionId,
    permissionMode: defaultPermissionMode(),
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
    console.error(`[session ${hub.key}] spawn 失败:`, e) // 原对象打日志保留堆栈
    broadcastError(hub, errorMessage(e))
  }
  // resumeSessionAt 是一次性 spawn 参数（命令行 args 已在 spawn() 内同步生成）。
  // 无论本次成败都不能留在 hub.spawnOpts 里，否则之后空闲回收后的普通 respawn
  // 会带着它再次截断同一条消息，静默丢弃回滚之后的新对话。
  delete hub.spawnOpts.resumeSessionAt
  pushStatus(hub)
}

/** claude 会话的就绪检查：未运行则触发懒 spawn；仍未就绪返回 undefined（ensureSpawned 已广播具体错误） */
function ensureClaudeSession(hub: Hub): ReturnType<typeof processManager.get> {
  let s = processManager.get(hub.key)
  if (!s || s.exited) {
    ensureSpawned(hub)
    s = processManager.get(hub.key)
  }
  return s && !s.exited ? s : undefined
}

/** 回滚进行中拒绝新操作：返回 true 表示已拒绝（错误已广播） */
function rewindBusy(hub: Hub, message = '已有回滚操作正在进行'): boolean {
  if (!hub.rewindPending) return false
  broadcastError(hub, message)
  return true
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
      if (rewindBusy(hub, '正在恢复文件，请等待回滚完成后再发送消息')) return
      const sendMode = data.sendMode === 'steer' || data.sendMode === 'queue' ? data.sendMode : undefined
      // 图片附件：服务端统一校验（类型/大小），claude 并 content blocks，codex 落盘走 localImage
      const attachments = (
        Array.isArray(data.attachments) ? (data.attachments as Array<Record<string, unknown>>) : []
      ).map((a) => ({
        name: String(a.name ?? 'image'),
        mediaType: String(a.mediaType ?? 'image/png'),
        dataBase64: String(a.dataBase64 ?? ''),
      }))
      if (isCodexKey(hub.key)) {
        void (async () => {
          let s = codexRuntime.get(hub.key)
          if (!s || s.exited || !s.sessionId) {
            s = await ensureCodexSession(hub)
          }
          if (!s || s.exited) return // ensureCodexSession 已广播具体错误
          try {
            s.sendUserText(String(data.text ?? ''), sendMode, attachments)
            pushStatus(hub)
          } catch (e) {
            broadcastError(hub, `发送失败: ${errorMessage(e)}`)
            pushStatus(hub)
          }
        })()
        return
      }
      const s = ensureClaudeSession(hub)
      if (!s) return // ensureSpawned 已广播具体错误
      try {
        // sendMode 直通：claude 侧 steer=priority 'now'（中断处理）、queue=服务端排队
        const text = String(data.text ?? '')
        s.sendUserText(text, sendMode, attachments)
        // /goal 是 claude 的本地斜杠命令（2.1.139+）：goal 状态不进 stream-json，
        // 这里从出站文本跟踪 chip 状态；result 到达时清除（见 onMessage）
        const goalMatch = text.match(/^\/goal\s*(.*)$/i)
        if (goalMatch) {
          const arg = goalMatch[1].trim()
          if (!arg) {
            // /goal 无参 = 查询状态，本地输出，不改变跟踪
          } else if (/^(clear|stop|off|reset|none|cancel)$/i.test(arg)) {
            hub.goal = undefined
          } else {
            hub.goal = { condition: arg, since: Date.now() }
          }
          pushStatus(hub)
        }
        // 记录首条真实 user 消息作为标题素材（斜杠首消息不算会话主题，跳过）；
        // 实际触发在 maybeGenerateTitle——需要 sessionId（init 可能尚未到达）。
        // 条件显式写：titleGeneratedFor 与 sessionId 同 undefined 时也必须放行（全新 Hub）
        if (text.trim() && !text.startsWith('/') && !(hub.titleGeneratedFor && hub.titleGeneratedFor === hub.sessionId)) {
          hub.pendingTitleText ??= text
          maybeGenerateTitle(hub)
        }
        pushStatus(hub)
      } catch (e) {
        broadcastError(hub, `发送失败: ${errorMessage(e)}`)
        pushStatus(hub)
      }
      break
    }
    case 'control': {
      const subtype = String(data.subtype)
      const extra = (data.extra as Record<string, unknown>) ?? {}
      // 组合回滚等待期间，通用控制路径不得再发 rewind_files 与之竞争
      if (hub.rewindPending && subtype === 'rewind_files') {
        broadcastError(hub, '已有回滚操作正在进行')
        return
      }
      // model/mode 都有等价启动参数：先缓存最终选择（未 spawn 时首条消息应用），
      // 已 spawn 时再发运行时控制。两个后端同此序。
      if (subtype === 'set_model' && extra.model) {
        hub.spawnOpts = { ...hub.spawnOpts, model: String(extra.model) }
      }
      if (subtype === 'set_permission_mode' && extra.mode) {
        hub.spawnOpts = { ...hub.spawnOpts, permissionMode: String(extra.mode) }
      }
      // codex：interrupt/set_model/set_permission_mode/compact 直接翻译；其余控制请求暂无对应物
      if (isCodexKey(hub.key)) {
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
            broadcastError(hub, `中断失败: ${errorMessage(e)}`)
          }
          pushStatus(hub)
        }
        return
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
        broadcastError(hub, `控制请求失败: ${errorMessage(e)}`)
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
        broadcastError(hub, `更新环境变量失败: ${errorMessage(e)}`)
        pushStatus(hub)
      }
      break
    }
    case 'branch': {
      // 分叉当前会话：claude 懒分叉（b| key，首条消息才 --fork-session），
      // codex 走既有 thread/fork（RewindPicker 的"从此处分叉"）；这里只处理 claude。
      if (isCodexKey(hub.key)) {
        broadcastError(hub, 'Codex 请用回滚面板的「从此处分叉」')
        return
      }
      const parsed = parseKey(hub.key)
      const srcSid = session()?.sessionId ?? parsed?.resumeSessionId ?? parsed?.forkFromSessionId
      if (!parsed || !srcSid) {
        broadcastError(hub, '分叉需要已有会话（先发过至少一条消息）')
        return
      }
      const branchKey = keyForBranch(parsed.cwd, srcSid)
      // 预建 Hub 并缓存分叉源：首条 user 消息 ensureSpawned 时经 parseKey 拿到 forkFromSessionId
      const branchHub = getHub(branchKey)
      // /branch <名字>：透传给分叉 spawn 的 -n（列表页可区分分支用途）
      const branchName = String(data.name ?? '').trim()
      if (branchName) branchHub.spawnOpts = { ...branchHub.spawnOpts, sessionName: branchName }
      broadcast(hub, { kind: 'forked', targetKey: branchKey, branchOf: srcSid, ...(branchName ? { name: branchName } : {}) })
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
          broadcastError(hub, 'codex 会话未就绪，无法分叉')
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
          .catch((e) => broadcastError(hub, `分叉失败: ${errorMessage(e)}`))
        return
      }
      if (rewindBusy(hub)) return
      rewindConversation(hub, at, 'conversation')
      break
    }
    case 'rewind_both': {
      const at = String(data.userMessageId ?? '')
      if (!at) return
      if (isCodexKey(hub.key)) {
        broadcastError(hub, 'Codex 没有文件检查点，不支持文件回滚（可用 git 管理代码历史）')
        return
      }
      if (rewindBusy(hub)) return
      const s = ensureClaudeSession(hub)
      if (!s) return

      // 官方 TUI 的“恢复代码和对话”也是两个动作。这里必须先收到文件
      // checkpoint 成功响应，才允许销毁旧进程并以 resume-session-at 截断对话。
      // rewind_files 没有 CLI 侧超时，大项目恢复可达分钟级，给足 120s。
      hub.rewindPending = true
      pushStatus(hub, { rewindPending: true })
      void s.sendControlAndWait('rewind_files', { user_message_id: at }, 120_000)
        .then(() => {
          if (processManager.get(hub.key) !== s || s.exited) {
            broadcastError(hub, '恢复文件后会话已变化，未回滚对话')
            return
          }
          rewindConversation(hub, at, 'both')
        })
        .catch((error) => {
          broadcastError(hub, `回滚文件失败，未回滚对话：${errorMessage(error)}`)
        })
        .finally(() => {
          hub.rewindPending = false
          pushStatus(hub, { rewindPending: false })
        })
      break
    }
    case 'btw': {
      // 侧问：借用当前会话上下文的一次性问答，不进主会话历史
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
            broadcast(hub, { kind: 'btw_result', ok: false, question, text: `侧问失败: ${errorMessage(e)}` }),
          )
        return
      }
      // claude：官方 side_question 控制通道（进程内轻量 fork，共享 prompt cache，
      // 不产生磁盘 FORK 会话）。无流式增量，应答单次返回。
      const parsed = parseKey(hub.key)
      const sid = session()?.sessionId ?? parsed?.resumeSessionId ?? parsed?.forkFromSessionId
      if (!question || !parsed || !sid) {
        broadcast(hub, { kind: 'btw_result', ok: false, text: '侧问需要已有会话（先发过至少一条消息）' })
        return
      }
      const s = ensureClaudeSession(hub)
      if (!s) return // ensureSpawned 已广播具体错误
      broadcast(hub, { kind: 'btw_pending', question })
      s.sideQuestion(question)
        .then((text) => broadcast(hub, { kind: 'btw_result', ok: true, question, text }))
        .catch((e) =>
          broadcast(hub, { kind: 'btw_result', ok: false, question, text: `侧问失败: ${errorMessage(e)}` }),
        )
      break
    }
    case 'query': {
      // 带应答的控制请求通道：只读查询（mcp_status / get_settings / get_context_usage）
      // 与 MCP 管理动作（mcp_reconnect / mcp_toggle，经 extra 传参）共用；
      // codex 仅 mcp_status 有对应物 mcpServerStatus/list（动作类一律拒绝）
      const id = String(data.id ?? '')
      const query = String(data.query ?? '')
      const extra = (data.extra as Record<string, unknown> | undefined) ?? {}
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
          .catch((e) => reply({ ok: false, error: errorMessage(e) }))
        return
      }
      const s = ensureClaudeSession(hub)
      if (!s) {
        reply({ ok: false, error: '进程未运行' })
        return
      }
      // 重连/启用是完整 MCP 握手，慢于普通查询，给足超时
      const timeoutMs = query === 'mcp_reconnect' || query === 'mcp_toggle' ? 30_000 : 15_000
      s.sendControlAndWait(query, extra, timeoutMs)
        .then((d) => reply({ ok: true, data: d }))
        .catch((e) => reply({ ok: false, error: errorMessage(e) }))
      break
    }
    case 'approval': {
      const requestId = String(data.requestId)
      resolveApproval(hub, requestId, data.decision as ApprovalDecision)
      break
    }
  }
}

/**
 * 审批解析共享路径：WS approval 消息与推送直接审批（/api/approval-action）共用。
 * 返回 false 表示 requestId 已不在 pending（重复点击/已在别处处理）。
 */
function resolveApproval(hub: Hub, requestId: string, decision: ApprovalDecision): boolean {
  if (!hub.pendingApprovals.delete(requestId)) return false
  const codex = isCodexKey(hub.key)
  const s = codex ? codexRuntime.get(hub.key) : processManager.get(hub.key)
  if (s && !s.exited) {
    try {
      s.sendApproval(requestId, decision)
    } catch (e) {
      broadcastError(hub, `审批回复失败: ${errorMessage(e)}`)
    }
  } else {
    // 会话已退出/未就绪：决定无处投递（上游请求将自行超时），本地照常解析并告知用户
    broadcastError(hub, '会话未在运行，审批未能送达（该请求会在上游自行超时）')
  }
  if (!codex) s?.notifyExternalGate()
  broadcast(hub, { kind: 'approval_resolved', requestId })
  publishInbox({ type: 'approval_resolved', key: hub.key, requestId })
  pushStatus(hub)
  return true
}

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
      //    claude 源在线时走 side_question 控制通道（进程内 fork，零冷启动、不留 FORK 会话）；
      //    离线才 spawn 一次性 --fork-session --bare 进程
      const { text: brief, usage } = await (async () => {
        if (fromBackend === 'claude') {
          const live = processManager.get(fromKey)
          if (live && !live.exited) {
            try {
              const text = await live.sideQuestion(briefPrompt(detail))
              if (text.trim()) return { text, usage: undefined }
            } catch {
              // side_question 失败回落 fork spawn（如 CLI 版本过旧无此通道）
            }
          }
          return generateClaudeBrief(sourceCwd, sid, detail)
        }
        return generateCodexBrief(sid, detail)
      })()
      if (sourceHub) broadcast(sourceHub, { kind: 'handoff_brief', brief })

      // 2. 目标会话播种（服务端直接发送首条消息）
      const targetKey = toBackend === 'codex' ? codexKeyForNew(sourceCwd) : keyForNew(sourceCwd)
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
        const deadline = Date.now() + 30_000
        // 每轮重新取句柄：等待期间旧进程可能退出并被重生，旧引用拿不到新 sessionId
        for (;;) {
          const cur = processManager.get(targetKey)
          if (!cur || cur.sessionId || cur.exited || Date.now() >= deadline) {
            targetSessionId = cur?.sessionId
            break
          }
          await Bun.sleep(500)
        }
      }
      const toResolvedKey =
        toBackend === 'codex'
          ? targetSessionId
            ? `x|${targetSessionId}`
            : undefined
          : targetSessionId
            ? keyFor(sanitizePath(sourceCwd), targetSessionId)
            : undefined
      const fromResolvedKey = (() => {
        if (fromBackend === 'claude') {
          if (fromKey.startsWith('s|')) return fromKey
          const sidNow = processManager.get(fromKey)?.sessionId
          return sidNow ? keyFor(sanitizePath(sourceCwd), sidNow) : undefined
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
      const message = errorMessage(e)
      if (sourceHub) broadcast(sourceHub, { kind: 'handoff_error', message })
    }
  })()
  return undefined
}

// ---------- HTTP ----------

function json(data: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  })
}

/** POST JSON body：解析失败按 {} 处理（各 handler 自行做字段校验） */
async function readJsonBody<T>(req: Request): Promise<T> {
  return (await req.json().catch(() => ({}))) as T
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

if (!hasWindowsSocketFix() && process.env.ANYPLANE_ALLOW_UNSAFE_BUN !== '1') {
  console.error(
    `[anyplane] Bun ${Bun.version} on Windows has the inherited-listener bug oven-sh/bun#36936.`,
  )
  console.error('[anyplane] Run `bun upgrade` (need >= 1.4.0) and restart the terminal. Server startup refused.')
  process.exit(1)
}

async function handleApi(req: Request, url: URL): Promise<Response | undefined> {
  // ---------- Web Push 订阅管理 ----------
  if (url.pathname === '/api/push/public-key' && req.method === 'GET') {
    return json({ publicKey: vapidPublicKey(), subscriptions: subscriptionCount(), webhooks: webhookCount() })
  }
  if (url.pathname === '/api/push/subscriptions' && req.method === 'POST') {
    const body = await readJsonBody<{ endpoint?: string; keys?: { p256dh: string; auth: string } }>(req)
    if (!body.endpoint || !body.keys?.p256dh || !body.keys?.auth) {
      return json({ error: 'endpoint 与 keys.p256dh/auth 必填' }, { status: 400 })
    }
    let secret: string
    try {
      secret = addSubscription(
        { endpoint: body.endpoint, keys: body.keys },
        req.headers.get('user-agent') ?? undefined,
      ).secret
    } catch (e) {
      return json({ error: errorMessage(e) }, { status: 400 })
    }
    console.log(`[push] 新订阅（共 ${subscriptionCount()}）：${body.endpoint.slice(0, 60)}…`)
    return json({ ok: true, secret })
  }
  if (url.pathname === '/api/push/subscriptions' && req.method === 'DELETE') {
    const body = await readJsonBody<{ endpoint?: string }>(req)
    return json({ ok: body.endpoint ? removeSubscription(body.endpoint) : false })
  }
  // 推送通道自检：向全部订阅与 webhook 通道 fanout 一条测试通知（不带审批能力，点击落应用首页）
  if (url.pathname === '/api/push/test' && req.method === 'POST') {
    const payload: PushPayload = {
      type: 'done',
      title: '测试通知 · AnyPlane',
      body: '推送链路可达：全部订阅与 webhook 通道会同时收到这一条。',
      key: '',
      session: 'anyplane',
      tag: 'ccr-test',
    }
    const [push, hooks] = await Promise.all([pushToAll(payload), pushWebhooksToAll(payload)])
    return json({
      ok: true,
      subscriptions: subscriptionCount(),
      webhooks: webhookCount(),
      sent: push.sent + hooks.sent,
      pruned: push.pruned,
    })
  }
  // 推送直接审批（能力 URL：secret 鉴权，不走 authToken——该 URL 只经加密推送投递到订阅设备）
  if (url.pathname === '/api/approval-action' && req.method === 'POST') {
    const key = url.searchParams.get('k') ?? ''
    const requestId = url.searchParams.get('r') ?? ''
    const decision = url.searchParams.get('d') ?? ''
    const secret = url.searchParams.get('s') ?? ''
    if (!validSecret(secret)) return json({ ok: false, error: '无效的能力密钥' }, { status: 403 })
    if (decision !== 'allow' && decision !== 'deny') {
      return json({ ok: false, error: 'd 只接受 allow/deny' }, { status: 400 })
    }
    const hub = hubs.get(key)
    if (!hub || !hub.pendingApprovals.has(requestId)) {
      return json({ ok: false, error: '该审批已处理或不存在' }, { status: 409 })
    }
    const pending = hub.pendingApprovals.get(requestId)!
    const ok = resolveApproval(
      hub,
      requestId,
      decision === 'allow'
        ? { behavior: 'allow', updatedInput: pending.input }
        : { behavior: 'deny', message: '用户在推送通知上拒绝了该操作' },
    )
    console.log(`[push] 通知直接审批 ${decision}：${sessionNameOf(key)} · ${pending.toolName}`)
    return json({ ok })
  }
  // webhook 通知的审批确认页（Bark/Server酱 无原生按钮：点链接进此页，按钮再 POST 到 approval-action）。
  // GET 只渲染不执行——通知链接被预览/抓取也不会误触审批。能力 URL 模型同 approval-action。
  if (url.pathname === '/api/approval-page' && req.method === 'GET') {
    const key = url.searchParams.get('k') ?? ''
    const requestId = url.searchParams.get('r') ?? ''
    const secret = url.searchParams.get('s') ?? ''
    if (!validSecret(secret)) return new Response('无效的能力密钥', { status: 403 })
    const pending = hubs.get(key)?.pendingApprovals.get(requestId)
    return new Response(approvalPageHtml(key, pending), {
      headers: { 'content-type': 'text/html; charset=utf-8' },
    })
  }
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
      // listSessions 已扫过 pid 文件，复用其结果，不为每行再扫一次（null = 已知不在线）
      managed: statusOf(
        keyFor(s.slug, s.sessionId),
        s.live ? { status: s.status, pid: s.live.pid } : null,
      ),
    }))
    // codex 线程：app-server 未安装/未登录时静默降级为空列表，不拖垮 claude 列表
    let codexRows: Record<string, unknown>[] = []
    try {
      const threads = await listCodexSessions()
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
    const body = await readJsonBody<{ cwd?: string; backend?: string }>(req)
    if (!body.cwd) return json({ error: '缺少 cwd' }, { status: 400 })
    if (body.backend === 'codex') {
      return json({ key: codexKeyForNew(body.cwd), slug: 'codex', backend: 'codex' })
    }
    return json({ key: keyForNew(body.cwd), slug: sanitizePath(body.cwd), backend: 'claude' })
  }
  if (url.pathname === '/api/fs/list' && req.method === 'GET') {
    // searchParams.get 已完成 URL 解码，禁止再 decodeURIComponent（含 % 的路径会被二次解码破坏）
    const target = url.searchParams.get('path') ?? ''
    try {
      return json(listDirectories(target))
    } catch (e) {
      if (e instanceof FsBrowseError) return json({ error: e.message }, { status: e.status })
      return json({ error: errorMessage(e) }, { status: 500 })
    }
  }
  if (url.pathname === '/api/sessions/archive' && req.method === 'POST') {
    const body = await readJsonBody<{ key?: string }>(req)
    if (!body.key) return json({ error: '缺少 key' }, { status: 400 })
    try {
      if (isCodexKey(body.key)) {
        const threadId = splitThreadId(body.key)
        if (!threadId) return json({ error: '无法解析 threadId' }, { status: 400 })
        await codexRuntime.rpcRequest('thread/archive', { threadId })
        return json({ ok: true })
      }
      const ek = splitExistingKey(body.key)
      if (!ek) return json({ error: '仅支持已有会话' }, { status: 400 })
      if (processManager.get(body.key) || liveSessionInfo(ek.sessionId)) {
        return json({ error: '会话正在运行，无法归档' }, { status: 409 })
      }
      archiveClaudeSession(ek.slug, ek.sessionId)
      return json({ ok: true })
    } catch (e) {
      return json({ error: errorMessage(e) }, { status: 500 })
    }
  }
  if (url.pathname === '/api/sessions/restore' && req.method === 'POST') {
    const body = await readJsonBody<{ key?: string }>(req)
    if (!body.key) return json({ error: '缺少 key' }, { status: 400 })
    try {
      if (isCodexKey(body.key)) {
        const threadId = splitThreadId(body.key)
        if (!threadId) return json({ error: '无法解析 threadId' }, { status: 400 })
        await codexRuntime.rpcRequest('thread/unarchive', { threadId })
        return json({ ok: true })
      }
      const ek = splitExistingKey(body.key)
      if (!ek) return json({ error: '仅支持 claude 会话恢复' }, { status: 400 })
      restoreClaudeSession(ek.slug, ek.sessionId)
      return json({ ok: true })
    } catch (e) {
      return json({ error: errorMessage(e) }, { status: 500 })
    }
  }
  // 归档/回收站列表：codex archived + claude trash 合并
  if (url.pathname === '/api/sessions/archived' && req.method === 'GET') {
    const claudeTrash = listTrash().map((t) => ({
      key: t.key,
      sessionId: t.sessionId,
      slug: t.slug,
      backend: 'claude' as const,
      trashedAt: t.trashedAt,
      sizeBytes: t.sizeBytes,
    }))
    let codexArchived: Record<string, unknown>[] = []
    try {
      const res = (await codexRuntime.rpcRequest('thread/list', { archived: true, limit: 100 })) as {
        data?: Array<Record<string, unknown>>
      }
      codexArchived = (res.data ?? []).map((t) => ({
        key: `x|${String(t.id)}`,
        sessionId: String(t.id),
        slug: 'codex',
        backend: 'codex' as const,
        title: typeof t.name === 'string' ? t.name : undefined,
        lastPrompt: typeof t.preview === 'string' ? t.preview : undefined,
        cwd: typeof t.cwd === 'string' ? t.cwd : undefined,
        mtime: Number(t.updatedAt ?? t.createdAt ?? 0) * 1000,
      }))
    } catch (e) {
      console.warn('[api] codex archived 列表失败:', e instanceof Error ? e.message : e)
    }
    return json({ entries: [...codexArchived, ...claudeTrash] })
  }
  if (url.pathname === '/api/sessions/rename' && req.method === 'POST') {
    const body = await readJsonBody<{ key?: string; title?: string }>(req)
    const title = body.title?.trim()
    if (!body.key || !title) return json({ error: '缺少 key 或 title' }, { status: 400 })
    // codex：官方 API，loaded/stored thread 均可
    if (isCodexKey(body.key)) {
      const threadId = splitThreadId(body.key)
      if (!threadId) return json({ error: '无法解析 threadId' }, { status: 400 })
      try {
        await codexRuntime.rpcRequest('thread/name/set', { threadId, name: title })
        return json({ ok: true })
      } catch (e) {
        return json({ error: errorMessage(e) }, { status: 500 })
      }
    }
    // claude：仅离线会话（在线会话的 transcript 由 CLI 持有，改名走其内部路径）
    const ek = splitExistingKey(body.key)
    if (!ek) return json({ error: '仅支持已有 claude 会话' }, { status: 400 })
    const { slug, sessionId } = ek
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
      return json({ error: errorMessage(e) }, { status: 500 })
    }
  }
  if (url.pathname === '/api/handoff' && req.method === 'POST') {
    const body = await readJsonBody<{ fromKey?: string; toBackend?: string; detail?: HandoffDetail }>(req)
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
  // 上传图片：仅 ~/.anyplane/uploads/ 内的 hash 命名文件（resolveUpload 边界校验）
  const uploadMatch = url.pathname.match(/^\/api\/uploads\/([^/]+)$/)
  if (uploadMatch && req.method === 'GET') {
    const path = resolveUpload(uploadMatch[1])
    if (!path) return json({ error: 'not found' }, { status: 404 })
    const ext = path.split('.').pop() ?? ''
    const mime =
      ({ jpg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp' })[ext] ??
      'application/octet-stream'
    return new Response(Bun.file(path), {
      headers: { 'content-type': mime, 'cache-control': 'public, max-age=31536000, immutable' },
    })
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
      const messages = await readCodexHistory(codexHistMatch[1])
      return json({ messages, fileBytes: 0 })
    } catch (e) {
      return json({ error: errorMessage(e) }, { status: 500 })
    }
  }
  // codex 模型目录（model/list）：模型 id/显示名/effort 列表/默认 effort
  if (url.pathname === '/api/codex/models' && req.method === 'GET') {
    try {
      const models = await codexRuntime.listModels()
      return json({ models })
    } catch (e) {
      return json({ error: errorMessage(e) }, { status: 500 })
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
  // 各档实际配置的模型名（StatusPill 透传显示；每次调用实时读盘，配置改动即见）
  if (url.pathname === '/api/claude/model-names' && req.method === 'GET') {
    return json({ models: resolveTierModelNames(url.searchParams.get('cwd') ?? undefined) })
  }
  return undefined
}

let server: ReturnType<typeof Bun.serve<WSData>>

// 跨源防护的实现已移至 auth.ts（可单测）；此处仅保留启动守卫说明：
// WebSocket 不受同源策略约束、text/plain 简单请求不触发 preflight——
// 默认无 token 时恶意网页可经受害者浏览器直连回环服务（CSWSH/CSRF → RCE）。
// 浏览器在 WS 握手与跨源 POST 时必定携带 Origin；非浏览器客户端（e2e 脚本/curl）不带。
// 配置 authToken 后 token 即防线，这些检查不生效（行为与旧版完全一致）。

// 绑定非回环地址却不配置 token = 把"任意目录起会话 + 任意命令执行"裸奔到网络上，拒绝启动
if (!isLoopbackHost(config.host) && !config.authToken) {
  console.error(`[anyplane] 拒绝启动：host=${config.host} 为非回环地址，但未配置 authToken。`)
  console.error('[anyplane] 请在 anyplane.config.json 设置 "authToken" 或设置环境变量 ANYPLANE_TOKEN。')
  process.exit(1)
}

function createServer(): ReturnType<typeof Bun.serve<WSData>> {
  return Bun.serve<WSData>({
    port: config.port,
    hostname: config.host,
    async fetch(req, srv) {
      const url = new URL(req.url)

      // 数据面/控制面统一鉴权（静态壳不鉴权，JS 中无敏感数据）
      // /api/approval-action 与 /api/approval-page 例外：推送直接审批走能力 URL（per-subscription/webhook
      // secret），SW 回POST与微信/Bark 内打开确认页都没有页面登录态，秘密本身即凭据
      //（且仅对 pending 中的 requestId 有效）
      const guarded =
        (url.pathname.startsWith('/api/') || url.pathname.startsWith('/ws/')) &&
        url.pathname !== '/api/approval-action' &&
        url.pathname !== '/api/approval-page'
      if (guarded && !isAuthorized(req, url)) {
        return json({ error: 'unauthorized' }, { status: 401 })
      }

      // 跨源防护：仅在无 token 模式生效（此时唯一防线）。approval-action 走能力 URL，
      // SW 回 POST 无页面 Origin 语义，且其鉴权是 per-subscription secret，不在此约束。
      // hostAllowed 在最前：DNS rebinding 下 Origin 与 Host 同为攻击者域名，
      // Origin↔Host 一致性天然失效，Host 回环白名单才是不依赖攻击者行为的锚点。
      if (!config.authToken && guarded) {
        if (!hostAllowed(req)) {
          return json({ error: 'host not allowed' }, { status: 403 })
        }
        if (!originAllowed(req)) {
          return json({ error: 'origin not allowed' }, { status: 403 })
        }
        if (!jsonContentTypeRequired(req, url)) {
          return json({ error: 'content-type must be application/json' }, { status: 415 })
        }
      }

      const wsMatch = url.pathname.match(/^\/ws\/sessions\/(.+)$/)
      if (wsMatch) {
        let key: string
        try {
          key = decodeURIComponent(wsMatch[1])
        } catch {
          return json({ error: 'bad session key encoding' }, { status: 400 })
        }
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
      return new Response('anyplane server (web 未构建，请用 vite dev 或 bun run build)', { status: 200 })
    },
    websocket: {
      // 30s 协议层下行 ping：前端 ReconnectingSocket 没有应用层心跳，空闲会话的 /ws 长连接
      // 可能数分钟无任何消息——Bun.serve 默认 idleTimeout=120s 会把它静默掐断（前端重连虽无感，
      // 但审批/事件推送会落在重连窗口里）；经 gateway 访问时也能为后端腿持续制造下行流量。
      open(ws) {
        ws.data.keepalive = setInterval(() => {
          try {
            ws.ping()
          } catch {}
        }, 30_000)
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
          console.error(`[ws ${hub.key}] 处理消息异常:`, e) // 原对象打日志保留堆栈
          try {
            ws.send(JSON.stringify({ kind: 'error', message: errorMessage(e) }))
          } catch {}
        }
      },
      close(ws) {
        if (ws.data.keepalive) clearInterval(ws.data.keepalive)
        if (ws.data.inbox) {
          inboxClients.delete(ws as import('bun').ServerWebSocket<WSDataInbox>)
          return
        }
        let hub = hubs.get(ws.data.key)
        if (!hub) {
          // 会话可能因 /clear 重键（hub.key 已换成新 s| key）：按客户端成员资格找回
          for (const h of hubs.values()) {
            if (h.clients.has(ws)) {
              hub = h
              break
            }
          }
        }
        if (!hub) return
        hub.clients.delete(ws)
        // 不变量：任何后端的会话句柄存活期间，其 Hub 必须存活——
        // 否则重连时复用旧会话，其回调会把事件广播进已删除的 Hub（消息黑洞）。
        // 用 hub.key 而非 ws.data.key：重键后进程注册在新 key 下
        const codex = isCodexKey(hub.key)
        const s = codex ? codexRuntime.get(hub.key) : processManager.get(hub.key)
        s?.detachClient()
        const alive = codex ? !!s && !s.exited : !!s
        if (hub.clients.size === 0) {
          stopTailer(hub)
          if (!alive) hubs.delete(hub.key)
        }
      },
    },
  })
}

// EADDRINUSE 且占用者是本仓库残留 server → 接管后重试一次；外来进程占用则原样报错
async function bindServer(): Promise<ReturnType<typeof Bun.serve<WSData>>> {
  try {
    return createServer()
  } catch (e) {
    const msg = errorMessage(e)
    const addrInUse = msg.includes('EADDRINUSE') || (e as { code?: string }).code === 'EADDRINUSE'
    if (!addrInUse) throw e
    console.error(`[anyplane] :${config.port} 已被占用，尝试接管本仓库残留进程…`)
    if ((await takeoverStaleListeners(config.port, isOwnServerProcess)) !== 'freed') throw e
    console.log(`[anyplane] :${config.port} 残留已清理，重新绑定`)
    return createServer()
  }
}

try {
  server = await bindServer()
} catch (e) {
  const msg = errorMessage(e)
  console.error(
    `[anyplane] bind failed port=${config.port} pid=${process.pid} ppid=${process.ppid} bun=${Bun.version}: ${msg}`,
  )
  logWindowsPortState('bind-failed', config.port)
  if (process.platform === 'win32') {
    console.error(
      '[anyplane] 若 LISTENING PID 已不存在，通常是 Bun <=1.3.14 的 socket handle 继承问题；升级到 1.4.0+。已形成且找不到持有进程的绑定需重启 Windows 一次。',
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
  `[anyplane] listening on ${accessUrl} pid=${process.pid} ppid=${process.ppid} bun=${Bun.version}`,
)
console.log(`[anyplane] permissionPolicy=${config.permissionPolicy} claudeConfigDir=${config.claudeConfigDir}`)
if (!config.authToken) {
  console.log('[anyplane] 未配置 authToken，仅监听回环地址。需要局域网访问时：配置 authToken 并设置 host。')
}

// 局域网模式：打印扫码即入的终端二维码（URL 已带 token）
if (!isLoopbackHost(config.host)) {
  try {
    const { default: QRCode } = await import('qrcode')
    console.log(await QRCode.toString(accessUrl, { type: 'terminal', small: true }))
  } catch (e) {
    console.warn('[anyplane] 二维码生成失败（不影响服务）:', e)
  }
}

let shuttingDown = false
async function shutdown(reason: string): Promise<void> {
  if (shuttingDown) {
    console.warn(`[anyplane] shutdown already in progress; repeated=${reason}`)
    return
  }
  shuttingDown = true
  const started = performance.now()
  console.log(`[anyplane] shutdown begin reason=${reason} pid=${process.pid}`)

  // 先发起 listener/连接关闭，再清 Claude 子进程。Bun <=1.3.14（修复于 1.4.0）在 Windows
  // 会让这些子进程继承监听 handle；两边都完成前绝不能 process.exit()。
  let stopPromise: Promise<void>
  try {
    console.log('[anyplane] server.stop(true) begin')
    stopPromise = Promise.resolve(server.stop(true))
  } catch (e) {
    console.error('[anyplane] server.stop(true) invoke failed:', e)
    stopPromise = Promise.resolve()
  }

  try {
    processManager.disposeAll()
    codexRuntime.disposeAll()
  } catch (e) {
    console.error('[anyplane] disposeAll 失败:', e)
  }

  const timeout = new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 5_000))
  const stopped = stopPromise.then(
    () => 'stopped' as const,
    (e) => {
      console.error('[anyplane] server.stop(true) rejected:', e)
      return 'failed' as const
    },
  )
  const result = await Promise.race([stopped, timeout])
  console.log(
    `[anyplane] shutdown server=${result} elapsedMs=${Math.round(performance.now() - started)}`,
  )

  if (result === 'timeout') {
    // 到这里 listener 已调用 stop，强退只是最后兜底；正常路径不应触发。
    console.error('[anyplane] shutdown timed out after 5s; forcing exit')
    process.exit(1)
  }
  logWindowsPortState('after-stop', config.port)
  console.log(`[anyplane] shutdown complete elapsedMs=${Math.round(performance.now() - started)}`)
  process.exit(0)
}

process.on('SIGINT', () => void shutdown('SIGINT'))
process.on('SIGTERM', () => void shutdown('SIGTERM'))
process.on('exit', (code) => {
  console.log(`[anyplane] process exit pid=${process.pid} code=${code} shuttingDown=${shuttingDown}`)
})
