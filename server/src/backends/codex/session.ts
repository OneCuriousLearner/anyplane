// CodexSession：单线程会话句柄，与 ClaudeSession 同形（契约见 backends/types.ts 末尾注释）。

import type { ApprovalDecision, SessionCallbacks } from '../types'
import type { CliMessage } from '../claude/protocol'
import { saveUpload } from '../../uploads'
import { errorMessage } from '../../util'
import { config } from '../../config'
import { RpcError } from './rpc'
import { appendReasoning } from './reasoningStore'
import { join } from 'node:path'
import { Glob } from 'bun'
import {
  collabAgentMsgs,
  mapThreadStatus,
  partialToolResultMsg,
  reasoningText,
  subAgentActivityMsgs,
  turnCompletedMsg,
  ThreadTranslator,
} from './translate'
import {
  extractTokenCountFromRolloutTail,
  mapApprovalDecision,
  mapPermissionMode,
  mapTokenUsage,
  sandboxPolicyOf,
} from './mapping'
import { log } from '../../log'
import type { CodexRuntime } from './runtime'

type Params = Record<string, unknown>

export interface CodexSpawnOpts {
  cwd?: string
  resumeThreadId?: string
  model?: string
  /** claude 风格权限模式或 codex 预设 → approvalPolicy/sandbox 近似映射 */
  permissionMode?: string
  /** reasoning effort（turn/start 的 effort 字段），懒启动时缓存 */
  effort?: string
}

interface PendingCodexApproval {
  rpcId: number | string
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

export class CodexSession {
  /** 会话 key；handoff 播种线程拿到真实 threadId 后由 CodexRuntime.rekey 改写（会话不换，键跟随 xn|→x|） */
  key: string
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
          // Hub 侧 pendingApprovals 同步清理（广播撤卡）：只清了 session 表会让死审批
          // 随重连重放、status 恒 waiting
          this.cb.onApprovalResolved?.(`cx-${rid}`)
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
    this.approvals.set(requestId, { rpcId: id })
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
