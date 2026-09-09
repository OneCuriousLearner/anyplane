// CodexRuntime：单个 codex app-server 进程托管全部 Codex 线程。
// CodexSession 实现与 ClaudeSession 同形的会话句柄（契约见 backends/types.ts 末尾注释），
// 事件经 ThreadTranslator 翻译成 claude stream-json 形状后走统一回调。

import type { ApprovalDecision, BackgroundTask, SessionCallbacks } from '../types'
import type { CliMessage } from '../claude/protocol'
import { saveUpload } from '../../uploads'
import { errorMessage } from '../../util'
import { config } from '../../config'
import { RpcClient, RpcError } from './rpc'
import { appendReasoning, readReasoning } from './reasoningStore'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { Glob } from 'bun'
import {
  collabAgentMsgs,
  itemsToHistory,
  mapThreadStatus,
  partialToolResultMsg,
  reasoningText,
  subAgentActivityMsgs,
  turnCompletedMsg,
  ThreadTranslator,
  type HistoryMessage,
  type ThreadItem,
} from './translate'
import { log } from '../../log'

type Params = Record<string, unknown>

/** readHistory 双轨共享的 turn 归一形状：legacy 来自 thread/read includeTurns，
 *  paginated 来自 turns/list 元数据 + items/list 按 turnId 归组 */
interface HistoryTurn {
  id?: string
  startedAt?: number | null
  completedAt?: number | null
  items?: ThreadItem[]
}

export interface CodexSpawnOpts {
  cwd?: string
  resumeThreadId?: string
  model?: string
  /** claude 风格权限模式或 codex 预设 → approvalPolicy/sandbox 近似映射 */
  permissionMode?: string
  /** reasoning effort（turn/start 的 effort 字段），懒启动时缓存 */
  effort?: string
}

/** claude permissionMode 或 codex 预设 → codex {approvalPolicy, sandbox}（近似映射）
 *  codex 预设（UI 原生展示）：
 *    readOnly      = read-only + on-request（只读·询问）
 *    workspace     = workspace-write + on-request（工作区·询问）
 *    workspaceAuto = workspace-write + never（工作区·免审，类比 --full-auto）
 *    fullAccess    = danger-full-access + never（完全访问）
 *  注意：sandbox 值用于 thread/start 的 kebab-case `sandbox` 字段；
 *  turn/start·settings/update 的 `sandboxPolicy` 对象是另一套 camelCase 枚举，用 sandboxPolicyOf 转换。 */
export function mapPermissionMode(mode?: string): { approvalPolicy?: string; sandbox?: string } {
  switch (mode) {
    case 'readOnly':
    case 'plan': // claude 名称的近似映射（spawnOpts 缓存/接力默认值可能带过来）
      return { approvalPolicy: 'on-request', sandbox: 'read-only' }
    case 'workspaceAuto':
    case 'acceptEdits':
    case 'auto':
      return { approvalPolicy: 'never', sandbox: 'workspace-write' }
    case 'fullAccess':
    case 'bypassPermissions':
      return { approvalPolicy: 'never', sandbox: 'danger-full-access' }
    case 'workspace':
    case 'default':
    default:
      return { approvalPolicy: 'on-request', sandbox: 'workspace-write' }
  }
}

/** kebab-case sandbox（thread/start 用）→ camelCase sandboxPolicy 对象（turn/start、settings/update 用） */
export function sandboxPolicyOf(kebab: string): Record<string, unknown> | undefined {
  const map: Record<string, string> = {
    'read-only': 'readOnly',
    'workspace-write': 'workspaceWrite',
    'danger-full-access': 'dangerFullAccess',
  }
  const type = map[kebab]
  return type ? { type } : undefined
}

/** rollout 尾部回扫出的 token 用量（与 thread/tokenUsage/updated wire 同形的 camelCase 记录，
 *  水合后直接进 CodexSession 的 lastUsage/totalUsage/modelContextWindow，getter 无需分支） */
export interface RolloutTokenCount {
  last: Record<string, number>
  total: Record<string, number>
  modelContextWindow?: number
}

/** 从 rollout 文本尾部倒序找最后一条 event_msg/token_count 记录。
 *  codex rollout 会把每次补全的 TokenUsageInfo 持久化为 token_count 事件（snake_case），
 *  而 thread/resume 不补发 tokenUsage 通知（实测）——resume 水合的唯一数据源。 */
export function extractTokenCountFromRolloutTail(text: string): RolloutTokenCount | undefined {
  const mapUsage = (u: unknown): Record<string, number> | undefined => {
    if (!u || typeof u !== 'object') return undefined
    const r = u as Record<string, unknown>
    return {
      totalTokens: Number(r.total_tokens ?? 0) || 0,
      inputTokens: Number(r.input_tokens ?? 0) || 0,
      cachedInputTokens: Number(r.cached_input_tokens ?? 0) || 0,
      cacheWriteInputTokens: Number(r.cache_write_input_tokens ?? 0) || 0,
      outputTokens: Number(r.output_tokens ?? 0) || 0,
      reasoningOutputTokens: Number(r.reasoning_output_tokens ?? 0) || 0,
    }
  }
  const lines = text.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim()
    if (!line || !line.includes('token_count')) continue
    let rec: { payload?: { type?: string; info?: Record<string, unknown> } }
    try {
      rec = JSON.parse(line) as typeof rec
    } catch {
      continue // 尾块首行可能被截断，跳过
    }
    const info = rec.payload?.type === 'token_count' ? rec.payload.info : undefined
    if (!info) continue
    const last = mapUsage(info.last_token_usage)
    if (!last) continue
    const w = Number(info.model_context_window ?? 0) || 0
    return {
      last,
      total: mapUsage(info.total_token_usage) ?? last,
      ...(w > 0 ? { modelContextWindow: w } : {}),
    }
  }
  return undefined
}

interface PendingCodexApproval {
  rpcId: number | string
  kind: string
}

/** 工具流式部分结果的合并窗口：outputDelta 按字节块到达（高频时每 token 一批），
 *  300ms 追尾合并成一次 partial 下发；终态 item/completed 的 aggregatedOutput 是权威替换 */
const OUTPUT_PARTIAL_MS = 300
/** 单个合并窗口的增量上限（超量保留尾部并加截断标记——防极端刷频下单元格无界增长；
 *  注意与下行放大无关：append 模式下每个窗口只发增量） */
const OUTPUT_PARTIAL_CAP = 32 * 1024

interface OutputBuf {
  /** 本窗口内待下发的增量（accumulate）或最新进度串（latest） */
  text: string
  /** 窗口内发生过截断（accumulate 超 CAP） */
  truncated?: boolean
  /** accumulate=命令输出追加（append 下发）；latest=进度消息取最新（替换下发） */
  mode: 'accumulate' | 'latest'
  dirty: boolean
}

/** 侧车回插消息的 uuid：itemId（0.148+ 落盘）优先——与 live 流 committed 思考块同 id，
 *  前端 seen 去重后重连补发/终态拉取不叠加；旧数据回退 rs-<ts>-<i> 合成 id */
export function reasoningSidecarUuid(entry: { ts: number; itemId?: string }, index: number): string {
  return entry.itemId ?? `rs-${entry.ts}-${index}`
}

/** app-server 的 camelCase usage 记录 → 统一形状（缺失/非数归 0；tokenUsage 与 contextUsage 共用） */
function mapTokenUsage(u: Record<string, number> | undefined) {
  const n = (v: unknown) => Number(v ?? 0) || 0
  return {
    inputTokens: n(u?.inputTokens),
    outputTokens: n(u?.outputTokens),
    cacheReadTokens: n(u?.cachedInputTokens),
    cacheWriteTokens: n(u?.cacheWriteInputTokens),
    reasoningTokens: n(u?.reasoningOutputTokens),
  }
}

export class CodexSession {
  readonly key: string
  threadId: string | undefined
  exited = false

  private runState: 'idle' | 'running' | 'requires_action' = 'idle'
  private clientCount = 0
  private currentTurnId: string | undefined
  private approvals = new Map<string, PendingCodexApproval>()
  private translator: ThreadTranslator | undefined
  private lastUsage: Record<string, number> | undefined
  /** tokenUsage.total：线程累计用量（codex 侧是覆盖语义，不是累加） */
  private totalUsage: Record<string, number> | undefined
  /** 模型上下文窗口大小（thread/tokenUsage/updated 的 modelContextWindow；旧版 app-server 可能缺省） */
  private modelContextWindow: number | undefined
  /** turn/start 的覆盖项（model/approvalPolicy/sandbox），未 spawn 时缓存 */
  turnOverrides: Params = {}
  /** 线程目标（thread/goal/* 通知驱动；objective + 官方统计） */
  goal: { condition: string; since: number; tokensUsed?: number; timeUsedSeconds?: number } | null = null
  /** 无客户端空闲回收计时器（镜像 claude 的 detachRecycleMs 语义） */
  private recycleTimer: ReturnType<typeof setTimeout> | undefined
  /** 工具流式部分结果缓冲（itemId → 累积文本/最新进度），300ms 追尾合并下发 */
  private outputBufs = new Map<string, OutputBuf>()
  private outputFlushTimer: ReturnType<typeof setTimeout> | undefined
  /** 子线程已标记"首条 userMessage"的 turn 键（`${childId}:${turnId}`）：
   *  history 把每轮首条 userMessage 以 turnId 为 uuid（rewindable 锚点），
   *  live 转发必须同键，否则终态拉取时提示词在桶里重复一份 */
  private childMarkedTurns = new Set<string>()
  /** 线程历史契约（thread/start / thread/resume 响应的 thread.historyMode）。
   *  paginated：历史走 turns/list+items/list、回滚走 thread/revert、resume 自动补发 tokenUsage；
   *  legacy：历史走 thread/read includeTurns、回滚降级 thread/fork。 */
  historyMode: string | undefined

  constructor(
    key: string,
    private opts: CodexSpawnOpts,
    private runtime: CodexRuntime,
    private cb: SessionCallbacks,
  ) {
    this.key = key
    this.threadId = opts.resumeThreadId
  }

  /** 重连场景：会话句柄复用时把回调重绑到新 Hub 的闭包上（防御消息黑洞） */
  rebind(cb: SessionCallbacks): void {
    this.cb = cb
  }

  get sessionId(): string | undefined {
    return this.threadId
  }
  get busy(): boolean {
    if (this.exited) return false
    return this.runState !== 'idle'
  }
  get waiting(): boolean {
    if (this.exited) return false
    return this.runState === 'requires_action'
  }
  get sessionState(): 'idle' | 'running' | 'requires_action' {
    return this.exited ? 'idle' : this.runState
  }
  get connectedClients(): number {
    return this.clientCount
  }
  get activeTaskCount(): number {
    return 0 // codex 的后台终端管理（backgroundTerminals/*）留待后续版本
  }
  get backgroundTasks(): BackgroundTask[] {
    return []
  }
  get cwd(): string | undefined {
    return this.opts.cwd
  }

  /** 线程累计 token 用量（统一形状；reasoning 单独成桶） */
  get tokenUsage(): {
    inputTokens: number
    outputTokens: number
    cacheReadTokens: number
    cacheWriteTokens: number
    reasoningTokens: number
  } {
    return mapTokenUsage(this.totalUsage)
  }

  /** 当前上下文窗口占用（codex 口径：last.totalTokens = 最新活跃上下文大小，对应 TUI footer
   *  的 "N% context left" 数据源；TUI 另减 12k baseline，这里保持原始值由前端统一口径）。
   *  首个 turn 之前或旧版 app-server 缺 modelContextWindow 时为 undefined（前端据此隐藏环形 UI）。 */
  get contextUsage():
    | {
        usedTokens: number
        windowSize: number
        outputTokens: number
        inputTokens: number
        cacheReadTokens: number
        cacheWriteTokens: number
        reasoningTokens: number
      }
    | undefined {
    const u = this.lastUsage
    const w = this.modelContextWindow
    if (!u || !w) return undefined
    return {
      usedTokens: Number(u.totalTokens ?? 0) || 0,
      windowSize: w,
      ...mapTokenUsage(u),
    }
  }

  /** attach / 首条消息时启动：resume 已有线程或 start 新线程 */
  async start(): Promise<void> {
    if (this.threadId && this.translator) return // 已加载
    const rpc = await this.runtime.ensureRpc()
    const perm = mapPermissionMode(this.opts.permissionMode)
    try {
      if (this.threadId) {
        const res = (await rpc.request('thread/resume', {
          threadId: this.threadId,
          excludeTurns: true,
          ...perm,
          ...(this.opts.model ? { model: this.opts.model } : {}),
        })) as { thread?: { historyMode?: string } }
        this.historyMode = res.thread?.historyMode
      } else {
        const res = (await rpc.request('thread/start', {
          cwd: this.opts.cwd,
          ...perm,
          ...(this.opts.model ? { model: this.opts.model } : {}),
          serviceName: 'anyplane',
          // 0.153 起默认已是 paginated（实测）；显式传是防御——上游回摆时我们不跟着退化成
          // legacy（legacy 的 thread/read 历史缺 commandExecution/collab/reasoning，0.153.4 实测未修）
          historyMode: 'paginated',
        })) as { thread: { id: string; cwd?: string; historyMode?: string } }
        this.threadId = res.thread.id
        this.historyMode = res.thread.historyMode
        if (res.thread.cwd) this.opts.cwd = res.thread.cwd
      }
    } catch (e) {
      // 线程被另一个 app-server 进程持有（TUI/VSCode 正在用）
      if (e instanceof RpcError && e.code === -32600 && /owned|another process|lock/i.test(e.message)) {
        throw new Error(`该线程正被另一个 codex 进程占用（TUI/VSCode？），请先关闭那边: ${e.message}`)
      }
      throw e
    }
    this.translator = new ThreadTranslator()
    this.runtime.registerThread(this.threadId!, this)
    if (this.opts.effort) this.turnOverrides.effort = this.opts.effort
    this.cb.onMessage({ type: 'system', subtype: 'init', session_id: this.threadId, model: this.opts.model })
    // resume 水合：0.153 起 paginated 线程的 thread/resume 自动补发 tokenUsage（实测；
    // 源码 thread_processor.rs：paginated_resume 即触发，excludeTurns 廉价路径仅对 legacy 跳过）。
    // legacy 线程维持 rollout 尾部回扫（上游持久化切 sqlite 后对新会话静默失效，优雅降级）。
    if (this.opts.resumeThreadId && this.historyMode !== 'paginated') void this.hydrateContextUsage()
    // 回读线程目标：goal 是 durable 的，重连/换端后 chip 需要恢复
    void this.runtime
      .rpcRequest('thread/goal/get', { threadId: this.threadId })
      .then((r) => {
        this.applyGoal(
          (r as { goal?: { objective?: string; createdAt?: number; tokensUsed?: number; timeUsedSeconds?: number } | null })
            .goal,
        )
      })
      .catch(() => {}) // 旧版 app-server 无 goal API 时静默降级
    this.cb.onStatusChange?.()
  }

  /** resume 水合：定位本线程的 rollout 文件（home/sessions/<日期目录>/rollout-*<threadId>.jsonl），
   *  尾部回扫最后一条 token_count 播种 lastUsage/totalUsage/modelContextWindow。
   *  尽力而为：找不到/读不到就保持隐藏等首个新 turn；竞态守卫——只填空位，不覆盖 live 值。 */
  private async hydrateContextUsage(): Promise<void> {
    const threadId = this.opts.resumeThreadId
    if (!threadId) return
    try {
      const home = this.runtime.home
      const glob = new Glob(`sessions/**/rollout-*${threadId}.jsonl`)
      let rel: string | undefined
      for await (const p of glob.scan({ cwd: home, onlyFiles: true })) {
        rel = p
        break // threadId 全局唯一，首个命中即所求
      }
      if (!rel) return
      const f = Bun.file(join(home, rel))
      const TAIL = 512 * 1024
      const text = await f.slice(Math.max(0, f.size - TAIL), f.size).text()
      const found = extractTokenCountFromRolloutTail(text)
      if (!found || this.exited) return
      let changed = false
      if (!this.lastUsage) {
        this.lastUsage = found.last
        changed = true
      }
      if (!this.totalUsage) {
        this.totalUsage = found.total
        changed = true
      }
      if (!this.modelContextWindow && found.modelContextWindow) {
        this.modelContextWindow = found.modelContextWindow
        changed = true
      }
      if (changed) this.cb.onStatusChange?.()
    } catch {
      // rollout 缺失/不可读：保持隐藏，等首个新 turn
    }
  }

  // ---------- 事件入口（runtime 按 threadId 分发） ----------

  /**
   * 子线程（collab 子代理）事件转发：0.148 起 app-server 把子线程实时事件推到父连接
   * （实测含嵌套孙线程、resume 后同样成立）。桶转录按 item/completed 粒度即达秒级实时；
   * delta/tokenUsage/status/turn 级事件不进桶（前端桶没有草稿概念，终态拉取兜底）。
   * depth 为该子线程在事件链里的嵌套深度（直接子代理=1）。
   */
  handleChildNotification(childThreadId: string, depth: number, method: string, params: Params): void {
    if (this.exited || method !== 'item/completed') return
    const item = params.item as
      | {
          type?: string
          id?: string
          summary?: string[]
          content?: unknown
          kind?: string
          agentThreadId?: string
          receiverThreadIds?: string[]
        }
      | undefined
    if (!item?.id || !item.type) return
    // 孙代理注册（先于转录翻译：孙线程首批事件紧随 started 到达，路由表必须先就位）
    this.registerSpawnedChildren(item, depth + 1)
    const t = this.translator
    if (!t) return
    // 孙代理生命周期：task_started 补嵌套血缘字段（父桶键 + 深度），前端 flattenTasks 直接归组
    if (item.type === 'subAgentActivity' || item.type === 'collabAgentToolCall') {
      const lifecycle = item.type === 'collabAgentToolCall' ? collabAgentMsgs(item as never) : subAgentActivityMsgs(item as never)
      for (const m of lifecycle) {
        if (m.subtype === 'task_started') {
          m.parent_tool_use_id = childThreadId
          m.spawn_depth = depth + 1
        }
        this.emit(m)
      }
      if (item.type === 'subAgentActivity') return // 非工具项，无桶转录
    }
    // 每轮首条 userMessage 以 turnId 为 uuid（与 history 的 rewindable 锚点同键，终态拉取去重）
    let firstUserTurnId: string | undefined
    const turnId = typeof params.turnId === 'string' ? params.turnId : undefined
    if (item.type === 'userMessage' && turnId) {
      const k = `${childThreadId}:${turnId}`
      if (!this.childMarkedTurns.has(k)) {
        this.childMarkedTurns.add(k)
        firstUserTurnId = turnId
      }
    }
    for (const m of t.childItemMsgs(childThreadId, item as never, { firstUserTurnId })) this.emit(m)
    // 子线程 rollout 同样不持久化 reasoning：侧车落盘，终态拉取历史时回插
    //（uuid 与 live 转发的思考块同为 item.id，拉取与转发经前端 seen 去重不叠加）
    if (item.type === 'reasoning') {
      const text = reasoningText(item.summary, item.content)
      if (text) {
        appendReasoning(childThreadId, {
          ts: Date.now(),
          turnId: typeof params.turnId === 'string' ? params.turnId : null,
          text,
          itemId: item.id,
        })
      }
    }
  }

  handleNotification(method: string, params: Params): void {
    const t = this.translator
    switch (method) {
      case 'thread/status/changed': {
        const st = mapThreadStatus(params.status as { type?: string } | undefined)
        // 审批等待期间保持 requires_action，由审批通道恢复
        if (this.approvals.size === 0) this.setRunState(st)
        break
      }
      case 'turn/started': {
        this.currentTurnId = (params.turn as { id?: string })?.id
        this.setRunState('running')
        break
      }
      case 'turn/completed': {
        const turn = (params.turn as Params) ?? {}
        this.currentTurnId = undefined
        this.setRunState('idle')
        this.resetOutputBufs()
        this.emit(turnCompletedMsg(this.threadId!, turn, this.lastUsage))
        break
      }
      case 'thread/tokenUsage/updated': {
        const tu = params.tokenUsage as
          | { last?: Record<string, number>; total?: Record<string, number>; modelContextWindow?: number }
          | undefined
        if (!tu) break
        if (tu.last) this.lastUsage = tu.last
        if (tu.total) this.totalUsage = tu.total
        if (typeof tu.modelContextWindow === 'number' && tu.modelContextWindow > 0) {
          this.modelContextWindow = tu.modelContextWindow
        }
        this.cb.onStatusChange?.()
        break
      }
      case 'thread/goal/updated': {
        this.applyGoal(
          params.goal as
            | { objective?: string; status?: string; tokensUsed?: number; timeUsedSeconds?: number; createdAt?: number }
            | undefined,
        )
        break
      }
      case 'thread/goal/cleared': {
        this.goal = null
        this.cb.onStatusChange?.()
        break
      }
      case 'thread/reverted': {
        // thread/revert 原地截断持久历史（仅 paginated 线程；0.153 起新线程默认 paginated）。
        // 可能来自本会话的回滚面板，也可能来自外部客户端（TUI/VSCode）——app-server 内部
        // 完成 shutdown→截断→reload 并保持订阅（源码注释明确客户端无需重新 resume），
        // live 流自然从截断点继续。翻译为 cli 系统消息广播并入环：重连补发也会携带它，
        // 前端据此重载权威历史（本地视图中"被回滚的未来"不会经 replay 复活）。
        this.emit({ type: 'system', subtype: 'thread_reverted' })
        break
      }
      case 'item/started': {
        const item = params.item as Params
        if ((item as { type?: string }).type === 'userMessage') break // 用户消息本地已回显
        for (const m of t?.itemStarted(item as never) ?? []) this.emit(m)
        break
      }
      case 'item/completed': {
        const item = params.item as Params
        const itemType = (item as { type?: string }).type
        if (itemType === 'userMessage') break // 用户消息本地已回显
        const itemId = (item as { id?: string }).id
        if (itemId) this.outputBufs.delete(itemId) // 终态结果即权威，部分结果缓冲随之失效
        // codex rollout 不持久化 reasoning：侧车落盘，历史读取时按 turn 时间窗回插
        //（itemId 一并落盘：回插消息与 live 流同 uuid，重连补发经前端 seen 去重）
        if (itemType === 'reasoning' && this.threadId) {
          const it = item as { summary?: string[]; content?: unknown }
          const text = reasoningText(it.summary, it.content)
          if (text) {
            appendReasoning(this.threadId, {
              ts: Date.now(),
              turnId: typeof params.turnId === 'string' ? params.turnId : null,
              text,
              itemId,
            })
          }
        }
        // collab 子线程注册（父子事件链转发的路由表，0.148 实测子线程事件推到父连接）：
        // 最早的注册点是 subAgentActivity started（子线程首批事件紧随其后到达）
        this.registerSpawnedChildren(item as { type?: string }, 1)
        for (const m of t?.itemCompleted(item as never) ?? []) this.emit(m)
        break
      }
      case 'item/agentMessage/delta':
      case 'item/reasoning/textDelta':
      case 'item/reasoning/summaryTextDelta':
      case 'item/reasoning/summaryPartAdded': {
        for (const m of t?.itemDelta(method, params) ?? []) this.emit(m)
        break
      }
      case 'item/commandExecution/outputDelta': {
        // 终端输出增量：尾部追加合并，300ms 窗口作为 partial tool_result 下发一次
        this.noteOutputDelta(String(params.itemId ?? ''), String(params.delta ?? ''), 'accumulate')
        break
      }
      case 'item/commandExecution/terminalInteraction': {
        // 交互终端的 stdin 回显（agent 向运行中进程写输入）：与输出同流追加
        this.noteOutputDelta(String(params.itemId ?? ''), String(params.stdin ?? ''), 'accumulate')
        break
      }
      case 'item/mcpToolCall/progress': {
        // MCP 进度是状态串而非流：取最新一条
        this.noteOutputDelta(String(params.itemId ?? ''), String(params.message ?? ''), 'latest')
        break
      }
      case 'serverRequest/resolved': {
        // 审批也可能被 app-server 侧终结（中断/超时/其他客户端应答）：清掉残留条目，
        // 否则 approvals.size 守卫永久短路 thread/status/changed，runState 卡在 requires_action
        const rid = (params as { requestId?: string | number }).requestId
        if (rid !== undefined && this.approvals.delete(`cx-${rid}`)) {
          if (this.approvals.size === 0 && this.runState === 'requires_action') {
            this.setRunState(this.currentTurnId ? 'running' : 'idle')
          }
        }
        break
      }
      case 'error': {
        const err = params.error as { message?: string } | undefined
        this.emit({
          type: 'result',
          subtype: 'error',
          is_error: true,
          result: err?.message ?? 'codex 错误',
          session_id: this.threadId,
        })
        this.setRunState('idle')
        break
      }
      case 'warning': {
        this.emit({ type: 'system', subtype: 'status', text: `⚠ ${String(params.message ?? '')}` })
        break
      }
      default:
        break // turn/diff/updated、turn/plan/updated、realtime/* 等暂不渲染
    }
  }

  handleServerRequest(id: number | string, method: string, params: Params): void {
    const requestId = `cx-${id}`
    let toolName = 'Bash'
    let input: unknown = params
    switch (method) {
      case 'item/commandExecution/requestApproval':
        toolName = 'Bash'
        input = { command: params.command ?? '', cwd: params.cwd, reason: params.reason }
        break
      case 'item/fileChange/requestApproval':
        toolName = 'Edit'
        // grantRoot 是审批时唯一稳定路径（文件列表在 item/completed 才有）。
        // 同时写入 file_path，让 approvalRules / summarizeInput 与 Claude Write 同口径。
        input = {
          reason: params.reason,
          grantRoot: params.grantRoot,
          file_path: typeof params.grantRoot === 'string' ? params.grantRoot : undefined,
        }
        break
      case 'item/permissions/requestApproval':
        toolName = 'Permissions'
        input = { reason: params.reason, permissions: params.permissions }
        break
      case 'item/tool/requestUserInput':
        toolName = 'AskUserQuestion'
        break
      default:
        // 未知 server request：拒绝掉避免悬挂（elicitation 等后续支持）
        this.runtime.respondSafe(id, { decision: 'decline' })
        return
    }
    this.approvals.set(requestId, { rpcId: id, kind: method })
    this.setRunState('requires_action')
    this.cb.onApprovalRequest({ requestId, toolName, input, toolUseId: String(params.itemId ?? '') })
  }

  // ---------- 与 ClaudeSession 同形的句柄接口 ----------

  /** sendMode：steer=插队（turn/steer 追加进当前轮）；queue=排队（thread/queue/add，idle 后自动开始）；缺省普通新轮。
   *  images：浏览器上传的 base64 图片——实测 data URL 在部分 provider 下不可见，统一落盘后走 localImage。 */
  sendUserText(
    text: string,
    sendMode?: 'steer' | 'queue',
    images?: Array<{ name: string; mediaType: string; dataBase64: string }>,
  ): void {
    if (!this.threadId) throw new Error('线程未启动')
    const imageInputs = (images ?? []).map((img) => ({ type: 'localImage', path: saveUpload(img) }))
    const input = [...imageInputs, ...(text.trim() ? [{ type: 'text', text }] : [])]
    if (input.length === 0) return
    if (sendMode === 'queue') {
      void this.runtime
        .rpcRequest('thread/queue/add', {
          threadId: this.threadId,
          input,
          clientUserMessageId: crypto.randomUUID(),
        })
        .catch((e) => this.emitError(`排队失败: ${errorMessage(e)}`))
      return
    }
    if (sendMode === 'steer' && this.currentTurnId) {
      const turnId = this.currentTurnId
      void this.runtime
        .rpcRequest('turn/steer', { threadId: this.threadId, input, expectedTurnId: turnId })
        .catch(() => this.startTurn(input)) // 轮刚好结束/不可 steer：回退普通新轮
      return
    }
    this.startTurn(input)
  }

  /** 普通新轮：审批一律路由给远程用户（anyplane 的存在意义），覆盖用户配置里的 auto_review */
  private startTurn(input: unknown[]): void {
    void this.runtime
      .rpcRequest('turn/start', {
        threadId: this.threadId,
        input,
        approvalsReviewer: 'user',
        ...this.turnOverrides,
      })
      .catch((e) => this.emitError(`发送失败: ${errorMessage(e)}`))
  }

  sendControl(subtype: string, extra: Record<string, unknown> = {}): string {
    const reqId = `cx-ctl-${Date.now().toString(36)}`
    switch (subtype) {
      case 'interrupt': {
        if (this.threadId && this.currentTurnId) {
          void this.runtime
            .rpcRequest('turn/interrupt', { threadId: this.threadId, turnId: this.currentTurnId })
            .catch(() => {}) // 无活动 turn 时 app-server 报 -32600，忽略
        }
        break
      }
      case 'set_model': {
        if (extra.model) {
          this.turnOverrides.model = String(extra.model)
          void this.settingsUpdate({ model: String(extra.model) })
        }
        break
      }
      case 'set_permission_mode': {
        const perm = mapPermissionMode(extra.mode as string | undefined)
        // turn/start 只接受 sandboxPolicy 对象（camelCase），不接受 kebab 的 sandbox 简写
        this.turnOverrides.approvalPolicy = perm.approvalPolicy
        this.turnOverrides.sandboxPolicy = perm.sandbox ? sandboxPolicyOf(perm.sandbox) : undefined
        void this.settingsUpdate({
          approvalPolicy: perm.approvalPolicy,
          sandboxPolicy: this.turnOverrides.sandboxPolicy,
        })
        break
      }
      case 'compact': {
        if (this.threadId) {
          void this.runtime.rpcRequest('thread/compact/start', { threadId: this.threadId }).catch((e) => {
            this.emitError(`压缩失败: ${errorMessage(e)}`)
          })
        }
        break
      }
      case 'set_goal': {
        // thread/goal/set：objective 即条件文本；tokenBudget 协议支持但 UI 不透传（用户决策）
        const objective = String(extra.objective ?? '').trim()
        if (!this.threadId || !objective) break
        void this.runtime
          .rpcRequest('thread/goal/set', { threadId: this.threadId, objective })
          .catch((e) => this.emitError(`设置目标失败: ${errorMessage(e)}`))
        break
      }
      case 'clear_goal': {
        if (!this.threadId) break
        void this.runtime
          .rpcRequest('thread/goal/clear', { threadId: this.threadId })
          .catch((e) => this.emitError(`清除目标失败: ${errorMessage(e)}`))
        break
      }
      case 'review': {
        // codex /review：inline 在本线程跑一轮审查（uncommittedChanges 或自定义说明）
        if (!this.threadId) break
        const instructions = String(extra.instructions ?? '').trim()
        void this.runtime
          .rpcRequest('review/start', {
            threadId: this.threadId,
            target: instructions ? { type: 'custom', instructions } : { type: 'uncommittedChanges' },
            delivery: 'inline',
          })
          .catch((e) => this.emitError(`审查启动失败: ${errorMessage(e)}`))
        break
      }
      case 'rename': {
        const name = String(extra.name ?? '').trim()
        if (!this.threadId || !name) break
        void this.runtime
          .rpcRequest('thread/name/set', { threadId: this.threadId, name })
          .catch((e) => this.emitError(`重命名失败: ${errorMessage(e)}`))
        break
      }
      default:
        // 给用户可见反馈而非静默吞掉：统一 TasksPanel 的停止按钮对两后端都发 stop_task，
        // 无声忽略会让 codex 任务卡片永远停在运行中
        this.emitError(`codex 后端暂不支持控制请求 ${subtype}`)
    }
    return reqId
  }

  /** codex 没有可等待的控制请求通道：rewind 走 thread/fork，查询走 mcpServerStatus/list，
   *  两者都在 index.ts 提前分流，不会到这里 */
  sendControlAndWait(subtype: string, _extra: Record<string, unknown> = {}, _timeoutMs = 15_000): Promise<unknown> {
    return Promise.reject(new Error(`codex 后端暂不支持控制请求 ${subtype}`))
  }

  sendApproval(requestId: string, decision: ApprovalDecision): void {
    const pending = this.approvals.get(requestId)
    this.approvals.delete(requestId)
    if (!pending) return
    const mapped = mapApprovalDecision(decision)
    this.runtime.respondSafe(pending.rpcId, { decision: mapped })
    if (this.approvals.size === 0 && this.runState === 'requires_action') {
      this.setRunState(this.currentTurnId ? 'running' : 'idle')
    }
  }

  /** claude 的 update_environment_variables：只取用 CLAUDE_CODE_EFFORT_LEVEL 映射 reasoning effort */
  write(msg: { type: string; variables?: Record<string, string> }): void {
    if (msg.type === 'update_environment_variables' && msg.variables?.CLAUDE_CODE_EFFORT_LEVEL) {
      const effort = msg.variables.CLAUDE_CODE_EFFORT_LEVEL
      this.turnOverrides.effort = effort
      void this.settingsUpdate({ reasoningEffort: effort })
    }
    // 其余 stdin 形状（keep_alive 等）对 codex 无意义，忽略
  }

  attachClient(): void {
    this.clientCount++
    this.cancelRecycle()
  }
  detachClient(): void {
    this.clientCount = Math.max(0, this.clientCount - 1)
    this.scheduleRecycleIfSafe()
  }
  syncClients(count: number): void {
    this.clientCount = Math.max(0, count)
    if (this.clientCount > 0) this.cancelRecycle()
    else this.scheduleRecycleIfSafe()
  }

  /** 无客户端且线程空闲时调度退订：dispose 只发 thread/unsubscribe，
   *  app-server 在**无订阅且无活动满 `thread_unload_delay_secs`（默认 60 秒）**后卸载线程
   *  （此前订阅永不释放，外部 resume 该线程会永远报 -32600「线程被占用」——writer lock 是
   *  跨进程文件锁，随卸载才释放）。**注意该默认值上游已从 30 分钟改为 60 秒**，用户可在
   *  ~/.codex/config.toml 设 `thread_unload_delay_secs = 1800` 恢复旧行为。
   *  卸载后重新 attach 走 thread/resume 并由 hydrateContextUsage 回扫 rollout 补上下文，
   *  故加速卸载不影响体验，只是 resume 更频繁。
   *  running / requires_action 绝不回收——与 claude 同律，触发时 busy 则自续一拍。 */
  private scheduleRecycleIfSafe(): void {
    this.cancelRecycle()
    if (this.exited || this.clientCount > 0 || this.busy) return
    this.recycleTimer = setTimeout(() => {
      this.recycleTimer = undefined
      if (this.exited || this.clientCount > 0) return
      if (this.busy) {
        this.scheduleRecycleIfSafe()
        return
      }
      log.info(`[codex ${this.key}] 空闲退订（clients=0）`)
      this.dispose()
    }, config.detachRecycleMs)
  }

  private cancelRecycle(): void {
    if (this.recycleTimer) {
      clearTimeout(this.recycleTimer)
      this.recycleTimer = undefined
    }
  }
  notifyExternalGate(): void {
    // codex 进程由 runtime 统一托管，不按会话回收
  }

  dispose(): void {
    if (this.exited) return
    this.cancelRecycle()
    this.resetOutputBufs()
    this.childMarkedTurns.clear()
    this.exited = true
    this.runtime.unregisterChildrenOf(this)
    // 断开订阅即可；app-server 会在无订阅且无活动满 thread_unload_delay_secs（默认 60s）后卸载
    if (this.threadId) {
      void this.runtime.rpcRequest('thread/unsubscribe', { threadId: this.threadId }).catch(() => {})
      this.runtime.unregisterThread(this.threadId, this)
    }
    this.cb.onExit(-1)
  }

  handleProcessExit(): void {
    if (this.exited) return
    this.exited = true
    this.resetOutputBufs()
    this.childMarkedTurns.clear()
    this.runtime.unregisterChildrenOf(this)
    this.setRunState('idle')
    this.cb.onExit(1)
  }

  // ---------- 内部 ----------

  /** goal API 应答（goal/get、goal/updated 同形）→ 统一形状并置位；objective 为空不动 */
  private applyGoal(g: {
    objective?: string
    createdAt?: number
    tokensUsed?: number
    timeUsedSeconds?: number
  } | null | undefined): void {
    if (!g?.objective) return
    this.goal = {
      condition: g.objective,
      since: (g.createdAt ?? 0) * 1000 || Date.now(),
      tokensUsed: g.tokensUsed,
      timeUsedSeconds: g.timeUsedSeconds,
    }
    this.cb.onStatusChange?.()
  }

  private emit(msg: CliMessage): void {
    this.cb.onMessage(msg)
  }

  private emitError(text: string): void {
    this.emit({ type: 'result', subtype: 'error', is_error: true, result: text, session_id: this.threadId })
  }

  /** collab 子线程注册（item/completed 的两个调用点共用：主线 depth=1，子线程内 depth+1——
   *  父子事件链转发的路由地基，只许一份实现：上游新增派生途径时改这里，两处同时生效） */
  private registerSpawnedChildren(
    item: { type?: string; kind?: string; agentThreadId?: string; receiverThreadIds?: string[] },
    depth: number,
  ): void {
    if (item.type === 'subAgentActivity') {
      if (item.kind === 'started' && item.agentThreadId) this.runtime.registerChild(item.agentThreadId, this, depth)
    } else if (item.type === 'collabAgentToolCall') {
      for (const tid of item.receiverThreadIds ?? []) {
        if (tid) this.runtime.registerChild(tid, this, depth)
      }
    }
  }

  /** 工具流式部分结果：按 itemId 合并进缓冲，300ms 追尾窗口统一下发（下行量与命令刷频解耦） */
  private noteOutputDelta(itemId: string, text: string, mode: OutputBuf['mode']): void {
    if (!itemId || !text || this.exited) return
    const b = this.outputBufs.get(itemId) ?? { text: '', mode, dirty: false }
    if (mode === 'latest') {
      b.text = text
    } else {
      b.text += text
      if (b.text.length > OUTPUT_PARTIAL_CAP) {
        b.text = b.text.slice(-OUTPUT_PARTIAL_CAP)
        b.truncated = true
      }
    }
    b.dirty = true
    this.outputBufs.set(itemId, b)
    if (!this.outputFlushTimer) {
      this.outputFlushTimer = setTimeout(() => {
        this.outputFlushTimer = undefined
        this.flushOutputPartials()
      }, OUTPUT_PARTIAL_MS)
    }
  }

  private flushOutputPartials(): void {
    if (this.exited) return
    for (const [itemId, b] of this.outputBufs) {
      if (!b.dirty) continue
      b.dirty = false
      const text = b.truncated ? `…（输出过快，中间有截断）\n${b.text}` : b.text
      // accumulate 走 append 增量（发完即清，下行量 ≈ 实际产出）；latest 保持替换语义
      this.emit(partialToolResultMsg(itemId, text, b.mode === 'accumulate'))
      b.text = ''
      b.truncated = false
    }
  }

  private resetOutputBufs(): void {
    if (this.outputFlushTimer) {
      clearTimeout(this.outputFlushTimer)
      this.outputFlushTimer = undefined
    }
    this.outputBufs.clear()
  }

  private setRunState(st: 'idle' | 'running' | 'requires_action'): void {
    if (this.runState === st) return
    this.runState = st
    this.emit({ type: 'system', subtype: 'session_state_changed', state: st })
    this.cb.onStatusChange?.()
  }

  /** 实验性 API，老版本可能拒绝：失败静默（turn/start 时仍会带覆盖项） */
  private async settingsUpdate(patch: Params): Promise<void> {
    if (!this.threadId) return
    const cleaned = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined))
    try {
      await this.runtime.rpcRequest('thread/settings/update', { threadId: this.threadId, ...cleaned })
    } catch {}
  }
}

function mapApprovalDecision(d: ApprovalDecision): string {
  if (d.behavior === 'allow') {
    // updatedPermissions（"总是允许"）→ 会话级记住（类型上宽松透传，运行期探测）
    return (d as { updatedPermissions?: unknown }).updatedPermissions ? 'acceptForSession' : 'accept'
  }
  return 'decline'
}

// ---------- 运行时单例 ----------

interface EphemeralCollector {
  resolve: (r: { text: string; usage?: Record<string, number> }) => void
  reject: (e: Error) => void
  text: string
  usage?: Record<string, number>
  timer: Timer
  /** 超时中断用：turn/started 报回的 turnId */
  turnId?: string
  /** 增量回调（btw 流式展示用） */
  onDelta?: (delta: string, thinking?: boolean) => void
}

export class CodexRuntime {
  private rpc: RpcClient | undefined
  private starting: Promise<RpcClient> | undefined
  private sessions = new Map<string, CodexSession>()
  private byThread = new Map<string, CodexSession>()
  /** ephemeral fork（/btw、接力简报）的临时事件收集器，按 threadId 路由 */
  private collectors = new Map<string, EphemeralCollector>()
  /** initialize 应答的 codexHome（rollout 水合定位 sessions/ 目录用） */
  private reportedHome: string | undefined

  /** codex 数据根目录：initialize 上报值优先，回退 CODEX_HOME env / ~/.codex */
  get home(): string {
    return this.reportedHome ?? process.env.CODEX_HOME ?? join(homedir(), '.codex')
  }

  async ensureRpc(): Promise<RpcClient> {
    if (this.rpc && !this.rpc.exited) return this.rpc
    if (this.starting) return this.starting
    this.starting = (async () => {
      const rpc = RpcClient.spawn(['codex', 'app-server', '--stdio'])
      rpc.onNotification = (n) => this.demux(n.method, n.params as Params)
      rpc.onServerRequest = (r) => this.demuxRequest(r.id, r.method, r.params as Params)
      rpc.onExit = (code) => {
        log.error(`[codex] app-server 退出 code=${code}`)
        this.rpc = undefined
        for (const s of this.sessions.values()) s.handleProcessExit()
      }
      const initRes = (await rpc.request('initialize', {
        clientInfo: { name: 'anyplane', title: 'anyplane', version: '0.2.0' },
        capabilities: { experimentalApi: true },
      })) as { codexHome?: string }
      if (typeof initRes.codexHome === 'string') this.reportedHome = initRes.codexHome
      rpc.notify('initialized', {})
      this.rpc = rpc
      log.info('[codex] app-server 已启动并完成握手')
      return rpc
    })()
    try {
      return await this.starting
    } finally {
      this.starting = undefined
    }
  }

  async rpcRequest(method: string, params?: unknown, timeoutMs?: number): Promise<unknown> {
    const rpc = await this.ensureRpc()
    return rpc.request(method, params, { timeoutMs })
  }

  respondSafe(id: number | string, result: unknown): void {
    try {
      this.rpc?.respond(id, result)
    } catch (e) {
      log.error('[codex] 审批应答失败:', e)
    }
  }

  registerThread(threadId: string, s: CodexSession): void {
    this.byThread.set(threadId, s)
  }
  unregisterThread(threadId: string, s?: CodexSession): void {
    if (!s || this.byThread.get(threadId) === s) this.byThread.delete(threadId)
  }

  /** collab 子线程路由表：子线程 id → 父会话与嵌套深度（直接子代理=1，孙代理=2…）。
   *  0.148 起子线程实时事件推到父连接（父子事件链），demux 经此表转发给父会话进侧栏桶。 */
  private children = new Map<string, { parent: CodexSession; depth: number }>()
  /** 未知线程事件的告警去重（子线程 delta 高频，每线程只留一次痕） */
  private unknownThreadWarned = new Set<string>()

  registerChild(childThreadId: string, parent: CodexSession, depth: number): void {
    if (!this.children.has(childThreadId)) {
      this.children.set(childThreadId, { parent, depth })
      this.unknownThreadWarned.delete(childThreadId)
    }
  }

  unregisterChildrenOf(parent: CodexSession): void {
    for (const [tid, link] of this.children) {
      if (link.parent === parent) this.children.delete(tid)
    }
  }

  private demux(method: string, params: Params): void {
    const threadId = typeof params.threadId === 'string' ? params.threadId : undefined
    if (threadId) {
      const collector = this.collectors.get(threadId)
      if (collector) {
        this.feedCollector(threadId, collector, method, params)
        return
      }
      const session = this.byThread.get(threadId)
      if (session) {
        session.handleNotification(method, params)
        return
      }
      const link = this.children.get(threadId)
      if (link) {
        if (!link.parent.exited) link.parent.handleChildNotification(threadId, link.depth, method, params)
        else this.children.delete(threadId)
        return
      }
      // 注册前抢先到达的子线程事件（attach 中途接入运行中的 collab 也会在此）：
      // 终态拉取兜底，不丢正确性；每线程留一次痕便于排查路由缺口
      if (!this.unknownThreadWarned.has(threadId)) {
        this.unknownThreadWarned.add(threadId)
        log.warn('[codex] 收到未注册线程的事件，已跳过（attach 中途接入或路由缺口）', {
          threadId: threadId.slice(0, 8),
          method,
        })
      }
    }
    // 无 threadId 的全局通知（account/*、remoteControl/* 等）暂不处理
  }

  private feedCollector(threadId: string, c: EphemeralCollector, method: string, params: Params): void {
    if (method === 'turn/started') {
      c.turnId = (params.turn as { id?: string } | undefined)?.id
    } else if (method === 'item/completed') {
      const item = params.item as { type?: string; text?: string } | undefined
      if (item?.type === 'agentMessage' && item.text) c.text += item.text
    } else if (method === 'item/agentMessage/delta') {
      c.onDelta?.(String(params.delta ?? ''), false)
    } else if (method === 'item/reasoning/textDelta' || method === 'item/reasoning/summaryTextDelta') {
      c.onDelta?.(String(params.delta ?? ''), true)
    } else if (method === 'thread/tokenUsage/updated') {
      const usage = (params.tokenUsage as { last?: Record<string, number> } | undefined)?.last
      if (usage) c.usage = usage
    } else if (method === 'turn/completed') {
      const turn = params.turn as { status?: string; error?: { message?: string } | null } | undefined
      clearTimeout(c.timer)
      this.collectors.delete(threadId)
      if (turn?.status === 'completed') c.resolve({ text: c.text.trim(), usage: c.usage })
      else c.reject(new Error(turn?.error?.message ?? `fork 问答未完成 (${turn?.status ?? '?'})`))
    } else if (method === 'error') {
      clearTimeout(c.timer)
      this.collectors.delete(threadId)
      const err = params.error as { message?: string } | undefined
      c.reject(new Error(err?.message ?? 'codex 错误'))
    }
  }

  /**
   * ephemeral fork 一次性问答：fork 源线程（纯内存不落盘）→ 单轮提问 → 收集回答。
   * 用于 Codex 侧交接简报生成与 /btw 侧问。只读沙箱 + 无审批，保证不会改现场。
   */
  async runEphemeralQuestion(
    sourceThreadId: string,
    question: string,
    timeoutMs = 180_000,
    onDelta?: (delta: string, thinking?: boolean) => void,
  ): Promise<{ text: string; usage?: Record<string, number> }> {
    const fork = (await this.rpcRequest('thread/fork', { threadId: sourceThreadId, ephemeral: true }, 60_000)) as {
      thread: { id: string }
    }
    const forkId = fork.thread.id
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const col = this.collectors.get(forkId)
        this.collectors.delete(forkId)
        // 超时只是调用方不等了：app-server 还在为无人消费的 ephemeral fork 烧 token，补一发中断
        if (col?.turnId) {
          void this.rpcRequest('turn/interrupt', { threadId: forkId, turnId: col.turnId }, 10_000).catch(() => {})
        }
        reject(new Error('fork 问答超时'))
      }, timeoutMs)
      this.collectors.set(forkId, { resolve, reject, text: '', timer, onDelta })
      this.rpcRequest('turn/start', {
        threadId: forkId,
        input: [{ type: 'text', text: question }],
        approvalPolicy: 'never',
        sandboxPolicy: { type: 'readOnly' },
      }).catch((e) => {
        clearTimeout(timer)
        this.collectors.delete(forkId)
        reject(e instanceof Error ? e : new Error(String(e)))
      })
    })
  }

  private demuxRequest(id: number | string, method: string, params: Params): void {
    const threadId = typeof params.threadId === 'string' ? params.threadId : undefined
    const session = threadId ? this.byThread.get(threadId) : undefined
    if (session) session.handleServerRequest(id, method, params)
    else this.respondSafe(id, { decision: 'decline' }) // 无主请求拒绝掉避免悬挂
  }

  ensure(key: string, opts: CodexSpawnOpts, cb: SessionCallbacks): CodexSession {
    const existing = this.sessions.get(key)
    if (existing && !existing.exited) {
      existing.rebind(cb)
      return existing
    }
    if (existing) this.sessions.delete(key)
    const s = new CodexSession(key, opts, this, cb)
    this.sessions.set(key, s)
    return s
  }

  get(key: string): CodexSession | undefined {
    return this.sessions.get(key)
  }

  dispose(key: string): void {
    const s = this.sessions.get(key)
    if (!s) return
    this.sessions.delete(key)
    s.dispose()
  }

  disposeAll(): void {
    for (const s of [...this.sessions.values()]) s.dispose()
    this.sessions.clear()
    this.children.clear()
    this.rpc?.kill()
    this.rpc = undefined
  }

  /** 分页拉取：cursor 翻页直到无 nextCursor 或达到 limitPages */
  private async paginate(method: string, baseParams: Params, limitPages = 3): Promise<Params[]> {
    const out: Params[] = []
    let cursor: string | null = null
    for (let page = 0; page < limitPages; page++) {
      const res = (await this.rpcRequest(method, { ...baseParams, cursor, limit: 100 })) as {
        data?: Params[]
        nextCursor?: string | null
      }
      out.push(...(res.data ?? []))
      cursor = res.nextCursor ?? null
      if (!cursor) break
    }
    return out
  }

  /** 模型目录：model/list 分页拉全（含每个模型支持的 effort 列表与默认 effort） */
  async listModels(): Promise<
    Array<{
      id: string
      label: string
      description: string
      efforts: Array<{ value: string; description: string }>
      defaultEffort?: string
      isDefault: boolean
    }>
  > {
    const out = await this.paginate('model/list', {})
    return out
      .filter((m) => m.hidden !== true)
      .map((m) => ({
        id: String(m.model ?? m.id ?? ''),
        label: String(m.displayName ?? m.model ?? m.id ?? ''),
        description: String(m.description ?? ''),
        efforts: (Array.isArray(m.supportedReasoningEfforts) ? m.supportedReasoningEfforts : []).map(
          (e) => ({
            value: String((e as { reasoningEffort?: unknown }).reasoningEffort ?? ''),
            description: String((e as { description?: unknown }).description ?? ''),
          }),
        ),
        defaultEffort: typeof m.defaultReasoningEffort === 'string' ? m.defaultReasoningEffort : undefined,
        isDefault: m.isDefault === true,
      }))
  }

  /** 会话发现：thread/list 分页拉全（含 cli/exec/appServer 来源） */
  async listThreads(limitPages = 3): Promise<Params[]> {
    return this.paginate(
      'thread/list',
      { sortKey: 'updated_at', sourceKinds: ['cli', 'vscode', 'exec', 'appServer'] },
      limitPages,
    )
  }

  /** 历史双轨（0.153.4 实测）：
   *  - paginated 线程：`thread/turns/list`（turn 元数据，供 rewindable 锚点与侧车时间窗）
   *    + `thread/items/list`（全量 item，跨 turn 升序分页）——item 与 live itemCompleted 同形同 id；
   *  - legacy 线程：`thread/read includeTurns`（items/list 对 legacy 报 -32601，无法借用分页补齐——
   *    legacy 历史的 commandExecution/collab/reasoning 缺失是上游未修的持久化缺口，维持现状）。
   *  两侧共用 turnsToHistory（itemsToHistory + 侧车 reasoning 按 turn 时间窗回插）。 */
  async readHistory(threadId: string): Promise<HistoryMessage[]> {
    // historyMode 走 threadMeta 缓存（同线程重复打开/回滚判定不再各付一次 thread/read）
    const mode = (await this.threadMeta(threadId)).historyMode
    const turns = mode === 'paginated' ? await this.readPaginatedTurns(threadId) : await this.readLegacyTurns(threadId)
    return this.turnsToHistory(threadId, turns)
  }

  private async readLegacyTurns(threadId: string): Promise<HistoryTurn[]> {
    const res = (await this.rpcRequest('thread/read', { threadId, includeTurns: true }, 60_000)) as {
      thread?: { turns?: HistoryTurn[] }
    }
    return res.thread?.turns ?? []
  }

  /** paginated 历史：turns/list 默认降序（新→旧，实测）——显式 asc 翻页拿元数据；
   *  items/list 不带 turnId 时跨 turn 升序分页（entry 为 {turnId, item} 包装，非裸 ThreadItem）。 */
  private async readPaginatedTurns(threadId: string): Promise<HistoryTurn[]> {
    const turnsMeta: Array<{ id?: string; startedAt?: number | null; completedAt?: number | null }> = []
    let cursor: string | null | undefined
    do {
      const page = (await this.rpcRequest(
        'thread/turns/list',
        { threadId, limit: 100, sortDirection: 'asc', ...(cursor ? { cursor } : {}) },
        60_000,
      )) as {
        data?: Array<{ id?: string; startedAt?: number | null; completedAt?: number | null }>
        nextCursor?: string | null
      }
      turnsMeta.push(...(page.data ?? []))
      cursor = page.nextCursor ?? null
    } while (cursor)

    const itemsByTurn = new Map<string, ThreadItem[]>()
    cursor = undefined
    do {
      const page = (await this.rpcRequest(
        'thread/items/list',
        { threadId, limit: 500, ...(cursor ? { cursor } : {}) },
        60_000,
      )) as { data?: Array<{ turnId?: string; item?: ThreadItem }>; nextCursor?: string | null }
      for (const e of page.data ?? []) {
        // 缺 turnId/item 的 entry 不能静默丢弃（AGENTS.md 宽松解析红线）——上游包装形状
        // 漂移时抄本会凭空缺块且零日志，与孤儿 turnId 同口径 warn 留痕
        if (!e.turnId || !e.item) {
          log.warn('[codex] items/list 返回缺 turnId/item 的条目，已跳过', { threadId })
          continue
        }
        const arr = itemsByTurn.get(e.turnId) ?? []
        arr.push(e.item)
        itemsByTurn.set(e.turnId, arr)
      }
      cursor = page.nextCursor ?? null
    } while (cursor)

    const seen = new Set<string>()
    const turns = turnsMeta.map((t) => {
      if (t.id) seen.add(t.id)
      return { ...t, items: t.id ? (itemsByTurn.get(t.id) ?? []) : [] }
    })
    // 防御：item 的 turnId 不在 turns/list 里（竞态/分页窗口交错）——按首见序追加为末段，不静默丢弃
    for (const [turnId, items] of itemsByTurn) {
      if (!seen.has(turnId)) {
        log.warn('[codex] items/list 出现 turns/list 之外的 turnId，按末段追加', { threadId, turnId })
        turns.push({ id: turnId, startedAt: null, completedAt: null, items })
      }
    }
    return turns
  }

  /** turn 序列 → 历史消息：itemsToHistory 翻译 + 侧车 reasoning 按 turn 时间窗回插 */
  private turnsToHistory(threadId: string, turns: HistoryTurn[]): HistoryMessage[] {
    const reasoning = readReasoning(threadId)
    // 侧车 append-only 按时间递增；校验失败（手工编辑等）回退全扫，语义不变
    const reasoningSorted = reasoning.every((r, i) => i === 0 || reasoning[i - 1].ts <= r.ts)
    const used = new Set<number>()
    const out: HistoryMessage[] = []
    for (let ti = 0; ti < turns.length; ti++) {
      const turn = turns[ti]
      const msgs = itemsToHistory(turn.items ?? [], typeof turn.id === 'string' ? turn.id : undefined)
      if (reasoning.length > 0) {
        const start = turn.startedAt ?? 0
        // completedAt 缺失（中断/失败的 turn）：窗口收口到下一轮起点，
        // 否则只有 start+30s，中断前已落盘的 thinking 会被永久漏掉
        const nextStart = turns[ti + 1]?.startedAt
        const end = turn.completedAt ?? nextStart ?? Number.MAX_SAFE_INTEGER / 1000
        const loMs = (start - 1) * 1000
        const hiMs = end * 1000 + 30_000
        const hit: number[] = []
        if (reasoningSorted) {
          // 时间窗二分定位起点后线性到终点：O(log n + 命中数)，免每 turn 全扫侧车
          let lo = 0
          let hi = reasoning.length
          while (lo < hi) {
            const mid = (lo + hi) >> 1
            if (reasoning[mid].ts < loMs) lo = mid + 1
            else hi = mid
          }
          for (let i = lo; i < reasoning.length && reasoning[i].ts <= hiMs; i++) {
            if (!used.has(i)) hit.push(i)
          }
        } else {
          reasoning.forEach((r, i) => {
            if (!used.has(i) && r.ts >= loMs && r.ts <= hiMs) hit.push(i)
          })
        }
        if (hit.length > 0) {
          const thinkingMsgs = hit.map((i) => ({
            uuid: reasoningSidecarUuid(reasoning[i], i),
            role: 'assistant' as const,
            blocks: [{ kind: 'thinking' as const, text: reasoning[i].text }],
          }))
          // 插到该 turn 第一个 assistant 之前（userMessage 之后），保持叙事顺序
          const insertAt = msgs.findIndex((m) => m.role === 'assistant')
          msgs.splice(insertAt >= 0 ? insertAt : msgs.length, 0, ...thinkingMsgs)
          hit.forEach((i) => used.add(i))
        }
      }
      out.push(...msgs)
    }
    return out
  }

  /** 原地回滚（paginated 线程）：thread/revert 用 beforeTurnId 之前的持久历史替换现状——
   *  thread id、连接、订阅全部保留（app-server 内部 shutdown→截断→reload），
   *  完成后服务端发 thread/reverted 通知（经 handleNotification 广播）。 */
  async revertAt(threadId: string, beforeTurnId: string): Promise<void> {
    await this.rpcRequest('thread/revert', { threadId, beforeTurnId }, 60_000)
  }

  /** 线程元数据（historyMode/cwd 都是创建即固定的量）单缓存：readHistory/historyModeOf/
   *  threadCwd 三处共用，避免同形 thread/read 复制与重复惰性往返（审查发现）。
   *  优先级：在线会话字段（0.153 起 start/resume 响应已带 historyMode）→ 进程内缓存 →
   *  一次 thread/read includeTurns:false。 */
  private threadMetaCache = new Map<string, { historyMode?: string; cwd?: string }>()

  async threadMeta(threadId: string): Promise<{ historyMode?: string; cwd?: string }> {
    for (const s of this.sessions.values()) {
      if (s.threadId === threadId && (s.historyMode || s.cwd)) return { historyMode: s.historyMode, cwd: s.cwd }
    }
    const cached = this.threadMetaCache.get(threadId)
    if (cached) return cached
    const res = (await this.rpcRequest('thread/read', { threadId, includeTurns: false }, 30_000)) as {
      thread?: { historyMode?: string; cwd?: string }
    }
    const meta = { historyMode: res.thread?.historyMode, cwd: res.thread?.cwd }
    this.threadMetaCache.set(threadId, meta)
    return meta
  }

  /** 线程的 historyMode（回滚双轨分流依据） */
  async historyModeOf(threadId: string): Promise<string | undefined> {
    return (await this.threadMeta(threadId)).historyMode
  }

  /** 分叉回滚：thread/fork beforeTurnId——复制该轮之前的历史为新线程，原线程不动 */
  async forkAt(threadId: string, beforeTurnId: string): Promise<string> {
    const res = (await this.rpcRequest('thread/fork', { threadId, beforeTurnId }, 60_000)) as {
      thread: { id: string }
    }
    return res.thread.id
  }

  /** x| key 的 cwd 惰性解析 */
  async threadCwd(threadId: string): Promise<string | undefined> {
    return (await this.threadMeta(threadId)).cwd
  }
}

export const codexRuntime = new CodexRuntime()
