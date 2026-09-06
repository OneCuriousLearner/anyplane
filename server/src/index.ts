// anyplane 服务端入口：REST + WebSocket + 静态托管

import { appendFileSync, existsSync } from 'node:fs'
import { networkInterfaces } from 'node:os'
import { join, resolve } from 'node:path'
import { hostAllowed, isAuthorized, isLoopbackHost, jsonContentTypeRequired, originAllowed } from './auth'
import { keyFor, keyForNew, parseKey, splitExistingKey } from './backends/claude/backend'
import { listSessions, liveSessionInfo, readHistory, sanitizePath, type SessionInfo } from './backends/claude/discovery'
import { resolveTierModelNames } from './backends/claude/modelNames'
import { processManager } from './backends/claude/processManager'
import { isInternalUserMessage, type CliMessage } from './backends/claude/protocol'
import type { TranscriptTailer } from './backends/claude/tailer'
import { isCodexKey, keyForNew as codexKeyForNew, listSessions as listCodexSessions, readHistory as readCodexHistory, splitThreadId } from './backends/codex/backend'
import { codexRuntime } from './backends/codex/runtime'
import { initBackendPorts, portFor } from './backends/port'
import type { ApprovalDecision, SpawnOptions } from './backends/types'
import { config } from './config'
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
  lineageFor,
  seedMessage,
  type HandoffDetail,
} from './handoff'
import { errorMessage, escapeHtml, hasWindowsSocketFix } from './util'
import { startupVersionProbe } from './driftGuard'
import { decisionOfRule, matchApprovalRule } from './approvalRules'
import { errFields, log } from './log'
import { pushCliRing, replayCliSince } from './cliReplay'

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

export interface Hub {
  key: string
  clients: Set<import('bun').ServerWebSocket<WSData>>
  pendingApprovals: Map<string, PendingApproval>
  /** 下行 cli 事件的单调序号（重连补发用，见 cliReplay.ts） */
  cliSeq?: number
  /** 最近 CLI_RING_CAP 条可落盘 cli 事件的环形缓冲（不含 stream_event） */
  cliRing?: Array<{ seq: number; payload: Record<string, unknown> }>
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
  /** sessionNameOf 的 s|/x| key cwd 缓存：反查（listSessions / CodexSession.cwd）至多一次（'' = 已查过、未知） */
  nameCwd?: string
}

const hubs = new Map<string, Hub>()

// BackendPort 适配器的回调注入（装配层一次性注册；适配器禁止 import 本模块。
// 被引用的均为函数声明，依赖 hoisting 而非 ESM 加载顺序）
initBackendPorts({
  broadcast,
  broadcastError,
  pushStatus,
  sessionCallbacks,
  getHub,
  sessionNameOf,
  rewindBusy,
})

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
  // x|：cwd 不在 key 里，取已加载 CodexSession 的 cwd（thread/read 解析后即有；
  // 推送/审批页恰好在会话存活期触发）。取不到时落 key 截断，不做同步 RPC
  if (parts[0] === 'x') {
    if (hub && hub.nameCwd === undefined) hub.nameCwd = codexRuntime.get(key)?.cwd ?? ''
    if (hub?.nameCwd) return base(hub.nameCwd)
  }
  return key.slice(0, 18)
}

/** 审批输入摘要（推送通知/审批页）：按工具挑裁决所需的关键字段，其余给 JSON 截断。
 *  与 web 端 toolSummary 同族但取舍不同——审批场景 Bash 必须给 command 本体
 *  （description 是作者给的说明文字，不能作为裁决依据；web 卡片下方另有详情区才可用它打头）。 */
function summarizeInput(toolName: string, input: unknown): string {
  const obj = (input ?? {}) as Record<string, unknown>
  if (toolName === 'Bash') return String(obj.command ?? '').slice(0, 400)
  if (toolName === 'Glob' || toolName === 'Grep') return String(obj.pattern ?? '')
  if (toolName === 'WebSearch') return String(obj.query ?? '')
  if (toolName === 'WebFetch') return String(obj.url ?? '')
  if (toolName === 'Agent') return String(obj.description ?? obj.prompt ?? '').slice(0, 300)
  if (obj.file_path) return String(obj.file_path)
  if (obj.path) return String(obj.path)
  if (obj.grantRoot) return String(obj.grantRoot)
  const json = JSON.stringify(input ?? {})
  return json.length > 300 ? json.slice(0, 300) + '…' : json
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
  void pushToAll(payload).catch((e) => log.warn('[push] fanout 异常:', e))
  void pushWebhooksToAll(payload).catch((e) => log.warn('[push] webhook fanout 异常:', e))
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

/** 待审批重放：WS 接入（单播）与 attach（广播）共用——未裁决的审批补发给目标 */
function replayApprovals(hub: Hub, send: (payload: unknown) => void): void {
  for (const a of hub.pendingApprovals.values()) {
    send({ kind: 'approval_request', ...a })
  }
}

function broadcast(hub: Hub, payload: unknown): void {
  const kindForRing = (payload as { kind?: string } | null | undefined)?.kind
  if (kindForRing === 'cli') pushCliRing(hub, payload as Record<string, unknown>)
  const text = JSON.stringify(payload)
  for (const ws of hub.clients) {
    try {
      ws.send(text)
    } catch (e) {
      // 向刚关闭的连接发送是竞态常态（close 处理器尚未跑到），属预期内噪声——
      // 降到 debug 而非吞掉：排查"消息没收到"时开 ANYPLANE_LOG_LEVEL=debug 就能看见
      log.debug(`[ws ${hub.key}] 下行发送失败（连接可能已关闭）`, errFields(e))
    }
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

/** liveHint：调用方（/api/sessions）刚做过 pid 扫描时传入复用，避免每行各扫一次；
 *  显式 null 表示"已知不在线"（跳过扫描），undefined 才现扫。
 *  hydrateContext：仅单会话 attach/pushStatus 路径开启（离线时读 transcript 尾部补
 *  上下文占用）；列表端点禁止开启（N 行 × 文件读）。
 *  实现已按后端收敛进适配器（backends/port.ts 的 portFor 分发；公共字段见 baseStatusOf）。 */
function statusOf(key: string, liveHint?: { status: string; pid: number } | null, hydrateContext = false): Record<string, unknown> {
  return portFor(key).statusOf(key, { hub: hubs.get(key), liveHint, hydrateContext })
}

function pushStatus(hub: Hub, extra?: Record<string, unknown>): void {
  broadcast(hub, { kind: 'status', state: { ...statusOf(hub.key, undefined, true), ...extra } })
}

/** onStatusChange 的 leading+trailing 节流：并行后台任务的 task_progress 心跳每秒可触发多次，
 *  statusOf 构造+广播是纯派生数据，窗口内合并即可。leading 立即发（busy/idle 转移零延迟），
 *  窗口内后续变更合并为 trailing 一发——终态只是延迟 ≤300ms，不会丢失。
 *  仅挂 onStatusChange 一路；审批/退出/attach 等事件路径仍直调 pushStatus 保证即时。 */
const STATUS_THROTTLE_MS = 300
const statusThrottle = new WeakMap<Hub, { timer: ReturnType<typeof setTimeout> | null; dirty: boolean }>()

function throttledPushStatus(hub: Hub): void {
  let st = statusThrottle.get(hub)
  if (!st) {
    st = { timer: null, dirty: false }
    statusThrottle.set(hub, st)
  }
  if (st.timer) {
    st.dirty = true
    return
  }
  pushStatus(hub)
  st.timer = setTimeout(() => {
    st.timer = null
    // Hub 可能已回收删除：确认还是同一个 Hub 再补发
    if (st.dirty && hubs.get(hub.key) === hub) {
      st.dirty = false
      pushStatus(hub)
    }
  }, STATUS_THROTTLE_MS)
  st.timer.unref?.()
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
        portFor(hub.key).maybeGenerateTitle(hub) // 首条消息可能已记账在等 sessionId（codex no-op）
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
      // 审批规则引擎：按序首条命中即自动裁决——不进 pending、不推送、不打扰，
      // 但广播 approval_auto 留痕事件（UI 灰底卡 + 服务端日志），审计可回溯。
      // 规则只做服务端裁决，绝不进入推送能力 URL 路径。
      const auto = matchApprovalRule(config.approvalRules ?? [], req.toolName, req.input)
      if (auto) {
        const label = auto.rule.note ?? `approvalRules[${auto.index}]`
        log.info(`[approval] ${hub.key} 规则自动${auto.rule.action === 'allow' ? '放行' : '拒绝'} ${req.toolName}（${label}）`)
        broadcast(hub, {
          kind: 'approval_auto',
          requestId: req.requestId,
          toolName: req.toolName,
          input: req.input,
          action: auto.rule.action,
          rule: label,
        })
        const s = isCodexKey(hub.key) ? codexRuntime.get(hub.key) : processManager.get(hub.key)
        if (s) s.sendApproval(req.requestId, decisionOfRule(auto.rule, req.input))
        else log.warn(`[approval] ${hub.key} 会话句柄已不存在，自动裁决无法送达`)
        return
      }
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
    onStatusChange: () => throttledPushStatus(hub),
    onExit: (code: number) => {
      pushStatus(hub, { exited: true, exitCode: code, spawned: false, busy: false, waiting: false })
    },
  }
}

/** 回滚进行中拒绝新操作：返回 true 表示已拒绝（错误已广播） */
function rewindBusy(hub: Hub, message = '已有回滚操作正在进行'): boolean {
  if (!hub.rewindPending) return false
  broadcastError(hub, message)
  return true
}

function handleClientMessage(
  hub: Hub,
  raw: string,
  /** 发起方连接：仅重连补发需要单播（其余一律 hub 级广播） */
  ws?: import('bun').ServerWebSocket<WSData>,
): void {
  let data: Record<string, unknown>
  try {
    data = JSON.parse(raw)
  } catch (e) {
    // 曾是静默 return：协议漂移/帧截断时表现为"消息就是没了"，零线索。
    // 客户端不可能合法发出非 JSON，这一定是 bug 或攻击面探测，按 error 留痕。
    log.error(`[ws ${hub.key}] 上行非 JSON 帧，已丢弃`, { bytes: raw.length, head: raw.slice(0, 120), ...errFields(e) })
    return
  }
  switch (data.kind) {
    case 'attach': {
      // 浏览历史只握手，不 spawn。发消息 / 切 model·mode·effort / rewind / btw 时再启动 CLI。
      // 各后端的 attach 策略（warm 预热、codex x| 即 resume）见适配器 onAttach。
      portFor(hub.key).onAttach(hub, data)
      replayApprovals(hub, (p) => broadcast(hub, p))
      // 重连补发：客户端带上断线前的最高 seq，取回这期间错过的 cli 事件。
      // **必须单播**：走 broadcast 会让补发内容重新入环并分配新序号（自我污染），
      // 且已在线的其他客户端会收到重复投递。
      const fromSeq = typeof data.fromSeq === 'number' ? data.fromSeq : undefined
      if (fromSeq !== undefined && ws) {
        const unicast = (p: unknown) => {
          try {
            ws.send(JSON.stringify(p))
          } catch (e) {
            log.debug(`[ws ${hub.key}] 补发单播失败`, errFields(e))
          }
        }
        // 环里已挤掉起点时告知缺口，由前端重载历史补全（transcript 是权威事实源）
        const gap = replayCliSince(hub, fromSeq, unicast)
        if (gap) {
          log.info(`[ws ${hub.key}] 补发存在缺口，通知客户端重载历史`, { fromSeq, ringFrom: hub.cliRing?.[0]?.seq })
          unicast({ kind: 'replay_gap', fromSeq })
        }
      }
      break
    }
    case 'tail_subscribe': {
      // 客户端加载完历史后订阅 transcript 追加（from = 历史读取时的文件字节数，无缝衔接）；
      // codex 的实时流走 app-server 订阅，无 tailer 概念（适配器内 no-op）
      portFor(hub.key).startTailer(hub, typeof data.from === 'number' ? data.from : undefined)
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
      const text = String(data.text ?? '')
      void (async () => {
        const port = portFor(hub.key)
        const s = await port.ensureForSend(hub)
        if (!s) return // 适配器已广播具体错误
        try {
          // sendMode 直通：claude 侧 steer=priority 'now'（中断处理）、queue=服务端排队
          s.sendUserText(text, sendMode, attachments)
          // 后端特定的发送后跟踪（claude：/goal 出站跟踪 + 标题素材记账；codex 无）
          port.afterUserSent?.(hub, text)
          pushStatus(hub)
        } catch (e) {
          broadcastError(hub, `发送失败: ${errorMessage(e)}`)
          pushStatus(hub)
        }
      })()
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
      portFor(hub.key).deliverControl(hub, subtype, extra)
      break
    }
    case 'update_env': {
      // effort 有 --effort 启动参数。未 spawn 时只缓存，首条消息时应用；
      // 已 spawn 时通过 update_environment_variables 影响后续 turn。
      const variables = (data.variables as Record<string, string>) ?? {}
      const effort = variables.CLAUDE_CODE_EFFORT_LEVEL
      if (effort) hub.spawnOpts = { ...hub.spawnOpts, effort }
      portFor(hub.key).updateEnv(hub, variables)
      break
    }
    case 'branch': {
      // 分叉当前会话：claude 懒分叉（b| key，首条消息才 --fork-session），
      // codex 走既有 thread/fork（RewindPicker 的"从此处分叉"，适配器内拒绝并引导）
      portFor(hub.key).branch(hub, String(data.name ?? ''))
      break
    }
    case 'rewind_conversation': {
      const at = String(data.userMessageId ?? '')
      if (!at) return
      // claude=原地截断重 spawn；codex=thread/fork 分叉语义（rewindPending 守卫在适配器内）
      portFor(hub.key).rewindConversation(hub, at)
      break
    }
    case 'rewind_both': {
      const at = String(data.userMessageId ?? '')
      if (!at) return
      // 组合回滚：claude 先 rewind_files 再截断；codex 无文件检查点（适配器内拒绝）
      portFor(hub.key).rewindBoth(hub, at)
      break
    }
    case 'btw': {
      // 侧问：借用当前会话上下文的一次性问答，不进主会话历史
      const question = String(data.question ?? '').trim()
      // btw_pending 必须先于校验失败分支发出：前端卡片由它创建，
      // 否则校验失败的 btw_result 找不到卡（按 question 配对）被静默丢弃，用户零反馈
      if (question) broadcast(hub, { kind: 'btw_pending', question })
      portFor(hub.key).btw(hub, question)
      break
    }
    case 'query': {
      // 带应答的控制请求通道：只读查询（mcp_status / get_settings / get_context_usage）
      // 与 MCP 管理动作（mcp_reconnect / mcp_toggle，经 extra 传参）共用；
      // codex 仅 mcp_status 有对应物 mcpServerStatus/list（动作类一律拒绝，见适配器）
      const id = String(data.id ?? '')
      const query = String(data.query ?? '')
      const extra = (data.extra as Record<string, unknown> | undefined) ?? {}
      const reply = (payload: Record<string, unknown>) => broadcast(hub, { kind: 'query_result', id, ...payload })
      if (!id || !query) return
      portFor(hub.key).query(hub, query, extra, reply)
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
  const fromPort = portFor(fromKey)
  const fromBackend = fromPort.name
  if (fromBackend === toBackend) return '接力目标必须与源会话是不同后端'

  // 源解析：cwd + 会话 id（codex 的 x| key 不含 cwd，需在异步路径里惰性解析）
  const src = fromPort.handoffSource(fromKey)
  if (fromBackend === 'claude' && !src.cwd) return '无法确定源会话目录'
  if (!src.sourceId) return '源会话还没有任何消息，无法接力'

  const sid = src.sourceId
  void (async () => {
    try {
      // codex x| key：cwd 需要 thread/read 惰性解析
      const sourceCwd = src.cwd ?? (await fromPort.handoffCwdOf(fromKey, sid))
      if (!sourceCwd) throw new Error('无法确定源会话目录（thread/read 未返回 cwd）')
      if (sourceHub) broadcast(sourceHub, { kind: 'handoff_pending', toBackend })
      // 1. 源会话 fork 自摘要
      //    claude 源在线时走 side_question 控制通道（进程内 fork，零冷启动、不留 FORK 会话）；
      //    离线才 spawn 一次性 --fork-session --bare 进程
      const { text: brief, usage } = await fromPort.forkBriefForHandoff(fromKey, sourceCwd, sid, detail)
      if (sourceHub) broadcast(sourceHub, { kind: 'handoff_brief', brief })

      // 2. 目标会话播种（服务端直接发送首条消息；启动失败抛错）
      const targetKey = toBackend === 'codex' ? codexKeyForNew(sourceCwd) : keyForNew(sourceCwd)
      const targetHub = getHub(targetKey)
      const seed = seedMessage(sourceCwd, fromBackend, brief)
      const targetSessionId = await portFor(targetKey).seedHandoffTarget(targetHub, seed)
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
          const sidNow = fromPort.sessionOf(fromKey)?.sessionId
          return sidNow ? keyFor(sanitizePath(sourceCwd), sidNow) : undefined
        }
        if (fromKey.startsWith('x|')) return fromKey
        const tidNow = fromPort.sessionOf(fromKey)?.sessionId
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
    log.info(
      `[port-diagnostic] stage=${stage} appPid=${process.pid} port=${port} rows=${rows.length}`,
    )
    for (const row of rows) log.info(`[port-diagnostic] ${row}`)
  } catch (e) {
    log.warn(`[port-diagnostic] stage=${stage} failed:`, e)
  }
}

const distDir = resolve(import.meta.dir, '../../web/dist')

if (!hasWindowsSocketFix() && process.env.ANYPLANE_ALLOW_UNSAFE_BUN !== '1') {
  log.error(
    `[anyplane] Bun ${Bun.version} on Windows has the inherited-listener bug oven-sh/bun#36936.`,
  )
  log.error('[anyplane] Run `bun upgrade` (need >= 1.4.0) and restart the terminal. Server startup refused.')
  process.exit(1)
}

// ---------- /api/sessions 的 git 分支缓存 ----------
// 列表被前端轮询，每个 cwd 的分支读取是 2-3 次同步文件 IO；分支变化不需要秒级新鲜度，30s TTL。
const BRANCH_CACHE_TTL_MS = 30_000
const branchCache = new Map<string, { branch: string | undefined; at: number }>()

function branchOfCached(cwd?: string): string | undefined {
  if (!cwd) return undefined
  const hit = branchCache.get(cwd)
  if (hit && Date.now() - hit.at < BRANCH_CACHE_TTL_MS) return hit.branch
  const branch = readGitBranch(cwd) // 普通仓库与 worktree 都支持
  branchCache.set(cwd, { branch, at: Date.now() })
  return branch
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
    log.info(`[push] 新订阅（共 ${subscriptionCount()}）：${body.endpoint.slice(0, 60)}…`)
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
    log.info(`[push] 通知直接审批 ${decision}：${sessionNameOf(key)} · ${pending.toolName}`)
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
    const claudeRows = sessions.map((s: SessionInfo) => ({
      ...s,
      backend: 'claude' as const,
      gitBranch: branchOfCached(s.cwd),
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
        gitBranch: branchOfCached(t.cwd),
        key: t.key,
        managed: statusOf(t.key),
      }))
    } catch (e) {
      log.warn('[api] codex thread/list 失败（仅返回 claude 会话）:', e instanceof Error ? e.message : e)
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
      log.warn('[api] codex archived 列表失败:', e instanceof Error ? e.message : e)
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
        } else if (parts[0] === 'b' && parts.length === 3) {
          // 懒分叉源（分叉后从未 spawn 或被回收，fromResolvedKey 缺省时记录里仍是 b| key）：
          // 缺节点会让前端接力链按钮 disabled（死按钮）；sessionId 内嵌的是分叉源 id
          nodes[k] = {
            key: k,
            backend: 'claude',
            slug: sanitizePath(decodeURIComponent(parts[1] ?? '')),
            sessionId: parts[2],
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
  log.error(`[anyplane] 拒绝启动：host=${config.host} 为非回环地址，但未配置 authToken。`)
  log.error('[anyplane] 请在 anyplane.config.json 设置 "authToken" 或设置环境变量 ANYPLANE_TOKEN。')
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
        portFor(ws.data.key).sessionOf(ws.data.key)?.attachClient()
        ws.send(JSON.stringify({ kind: 'status', state: statusOf(ws.data.key, undefined, true) }))
        replayApprovals(hub, (p) => ws.send(JSON.stringify(p)))
      },
      message(ws, raw) {
        if (ws.data.inbox) return // inbox 频道只发不收
        const hub = getHub(ws.data.key)
        try {
          handleClientMessage(hub, typeof raw === 'string' ? raw : raw.toString(), ws as import('bun').ServerWebSocket<WSData>)
        } catch (e) {
          log.error(`[ws ${hub.key}] 处理消息异常:`, e) // 原对象打日志保留堆栈
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
        const port = portFor(hub.key)
        port.sessionOf(hub.key)?.detachClient()
        const alive = port.hasLiveSession(hub.key)
        if (hub.clients.size === 0) {
          port.stopTailer(hub)
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
    log.error(`[anyplane] :${config.port} 已被占用，尝试接管本仓库残留进程…`)
    if ((await takeoverStaleListeners(config.port, isOwnServerProcess)) !== 'freed') throw e
    log.info(`[anyplane] :${config.port} 残留已清理，重新绑定`)
    return createServer()
  }
}

try {
  server = await bindServer()
} catch (e) {
  const msg = errorMessage(e)
  log.error(
    `[anyplane] bind failed port=${config.port} pid=${process.pid} ppid=${process.ppid} bun=${Bun.version}: ${msg}`,
  )
  logWindowsPortState('bind-failed', config.port)
  if (process.platform === 'win32') {
    log.error(
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
log.info(
  `[anyplane] listening on ${accessUrl} pid=${process.pid} ppid=${process.ppid} bun=${Bun.version}`,
)
log.info(`[anyplane] permissionPolicy=${config.permissionPolicy} claudeConfigDir=${config.claudeConfigDir}`)
if (!config.authToken) {
  log.info('[anyplane] 未配置 authToken，仅监听回环地址。需要局域网访问时：配置 authToken 并设置 host。')
}

// 局域网模式：打印扫码即入的终端二维码（URL 已带 token）
if (!isLoopbackHost(config.host)) {
  try {
    const { default: QRCode } = await import('qrcode')
    log.info(await QRCode.toString(accessUrl, { type: 'terminal', small: true }))
  } catch (e) {
    log.warn('[anyplane] 二维码生成失败（不影响服务）:', e)
  }
}

// 协议漂移预警：CLI 版本前进而未跑过对应检查时提醒（不阻塞启动）
try {
  startupVersionProbe()
} catch (e) {
  log.warn('[drift] 版本探测失败（不影响服务）:', e)
}

// 审批规则引擎：加载即生效（坏规则在 config 加载时已 fail fast）
if (config.approvalRules?.length) {
  log.info(`[approval] 审批规则引擎已启用：${config.approvalRules.length} 条规则，按序首条命中`)
}

let shuttingDown = false
async function shutdown(reason: string): Promise<void> {
  if (shuttingDown) {
    log.warn(`[anyplane] shutdown already in progress; repeated=${reason}`)
    return
  }
  shuttingDown = true
  const started = performance.now()
  log.info(`[anyplane] shutdown begin reason=${reason} pid=${process.pid}`)

  // 先发起 listener/连接关闭，再清 Claude 子进程。Bun <=1.3.14（修复于 1.4.0）在 Windows
  // 会让这些子进程继承监听 handle；两边都完成前绝不能 process.exit()。
  let stopPromise: Promise<void>
  try {
    log.info('[anyplane] server.stop(true) begin')
    stopPromise = Promise.resolve(server.stop(true))
  } catch (e) {
    log.error('[anyplane] server.stop(true) invoke failed:', e)
    stopPromise = Promise.resolve()
  }

  try {
    processManager.disposeAll()
    codexRuntime.disposeAll()
  } catch (e) {
    log.error('[anyplane] disposeAll 失败:', e)
  }

  const timeout = new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 5_000))
  const stopped = stopPromise.then(
    () => 'stopped' as const,
    (e) => {
      log.error('[anyplane] server.stop(true) rejected:', e)
      return 'failed' as const
    },
  )
  const result = await Promise.race([stopped, timeout])
  log.info(
    `[anyplane] shutdown server=${result} elapsedMs=${Math.round(performance.now() - started)}`,
  )

  if (result === 'timeout') {
    // 到这里 listener 已调用 stop，强退只是最后兜底；正常路径不应触发。
    log.error('[anyplane] shutdown timed out after 5s; forcing exit')
    process.exit(1)
  }
  logWindowsPortState('after-stop', config.port)
  log.info(`[anyplane] shutdown complete elapsedMs=${Math.round(performance.now() - started)}`)
  process.exit(0)
}

process.on('SIGINT', () => void shutdown('SIGINT'))
process.on('SIGTERM', () => void shutdown('SIGTERM'))
process.on('exit', (code) => {
  log.info(`[anyplane] process exit pid=${process.pid} code=${code} shuttingDown=${shuttingDown}`)
})
