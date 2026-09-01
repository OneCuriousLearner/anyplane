// CodexRuntime：单个 codex app-server 进程托管全部 Codex 线程。
// CodexSession 实现与 ClaudeSession 同形的会话句柄（契约见 backends/types.ts 末尾注释），
// 事件经 ThreadTranslator 翻译成 claude stream-json 形状后走统一回调。

import type { ApprovalDecision, BackgroundTask, SessionCallbacks } from '../types'
import type { CliMessage } from '../claude/protocol'
import { saveUpload } from '../../uploads'
import { errorMessage } from '../../util'
import { RpcClient, RpcError } from './rpc'
import { appendReasoning, readReasoning } from './reasoningStore'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { Glob } from 'bun'
import {
  itemsToHistory,
  mapThreadStatus,
  reasoningText,
  turnCompletedMsg,
  ThreadTranslator,
  type HistoryMessage,
} from './translate'

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
    const u = this.totalUsage ?? {}
    return {
      inputTokens: Number(u.inputTokens ?? 0) || 0,
      outputTokens: Number(u.outputTokens ?? 0) || 0,
      cacheReadTokens: Number(u.cachedInputTokens ?? 0) || 0,
      cacheWriteTokens: Number(u.cacheWriteInputTokens ?? 0) || 0,
      reasoningTokens: Number(u.reasoningOutputTokens ?? 0) || 0,
    }
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
      outputTokens: Number(u.outputTokens ?? 0) || 0,
      inputTokens: Number(u.inputTokens ?? 0) || 0,
      cacheReadTokens: Number(u.cachedInputTokens ?? 0) || 0,
      cacheWriteTokens: Number(u.cacheWriteInputTokens ?? 0) || 0,
      reasoningTokens: Number(u.reasoningOutputTokens ?? 0) || 0,
    }
  }

  /** attach / 首条消息时启动：resume 已有线程或 start 新线程 */
  async start(): Promise<void> {
    if (this.threadId && this.translator) return // 已加载
    const rpc = await this.runtime.ensureRpc()
    const perm = mapPermissionMode(this.opts.permissionMode)
    try {
      if (this.threadId) {
        await rpc.request('thread/resume', {
          threadId: this.threadId,
          excludeTurns: true,
          ...perm,
          ...(this.opts.model ? { model: this.opts.model } : {}),
        })
      } else {
        const res = (await rpc.request('thread/start', {
          cwd: this.opts.cwd,
          ...perm,
          ...(this.opts.model ? { model: this.opts.model } : {}),
          serviceName: 'anyplane',
        })) as { thread: { id: string; cwd?: string } }
        this.threadId = res.thread.id
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
    // resume 水合：thread/resume 不补发 tokenUsage（实测），回扫 rollout 尾部的
    // token_count 事件播种窗口占用与累计用量，让环形 UI 在首个新 turn 之前就有数
    if (this.opts.resumeThreadId) void this.hydrateContextUsage()
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
        // codex rollout 不持久化 reasoning：侧车落盘，历史读取时按 turn 时间窗回插
        if (itemType === 'reasoning' && this.threadId) {
          const it = item as { summary?: string[]; content?: unknown }
          const text = reasoningText(it.summary, it.content)
          if (text) {
            appendReasoning(this.threadId, {
              ts: Date.now(),
              turnId: typeof params.turnId === 'string' ? params.turnId : null,
              text,
            })
          }
        }
        for (const m of t?.itemCompleted(item as never) ?? []) this.emit(m)
        break
      }
      case 'item/agentMessage/delta':
      case 'item/reasoning/textDelta':
      case 'item/reasoning/summaryTextDelta': {
        for (const m of t?.itemDelta(method, params) ?? []) this.emit(m)
        break
      }
      case 'serverRequest/resolved':
        break // 审批清理由 sendApproval 处理
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
        input = { reason: params.reason, grantRoot: params.grantRoot }
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
        console.log(`[codex ${this.key}] 不支持的控制请求 ${subtype}（忽略）`)
    }
    return reqId
  }

  sendControlAndWait(subtype: string, _extra: Record<string, unknown> = {}, _timeoutMs = 15_000): Promise<unknown> {
    if (subtype === 'rewind_files') {
      return Promise.reject(new Error('Codex 没有文件检查点，不支持文件回滚（可用 git 管理代码历史）'))
    }
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
  }
  detachClient(): void {
    this.clientCount = Math.max(0, this.clientCount - 1)
  }
  syncClients(count: number): void {
    this.clientCount = Math.max(0, count)
  }
  notifyExternalGate(): void {
    // codex 进程由 runtime 统一托管，不按会话回收
  }

  dispose(): void {
    if (this.exited) return
    this.exited = true
    // 断开订阅即可；app-server 会在 30 分钟无订阅后自行卸载线程
    if (this.threadId) {
      void this.runtime.rpcRequest('thread/unsubscribe', { threadId: this.threadId }).catch(() => {})
      this.runtime.unregisterThread(this.threadId, this)
    }
    this.cb.onExit(-1)
  }

  handleProcessExit(): void {
    if (this.exited) return
    this.exited = true
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
        console.error(`[codex] app-server 退出 code=${code}`)
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
      console.log('[codex] app-server 已启动并完成握手')
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
      console.error('[codex] 审批应答失败:', e)
    }
  }

  registerThread(threadId: string, s: CodexSession): void {
    this.byThread.set(threadId, s)
  }
  unregisterThread(threadId: string, s?: CodexSession): void {
    if (!s || this.byThread.get(threadId) === s) this.byThread.delete(threadId)
  }

  private demux(method: string, params: Params): void {
    const threadId = typeof params.threadId === 'string' ? params.threadId : undefined
    if (threadId) {
      const collector = this.collectors.get(threadId)
      if (collector) {
        this.feedCollector(threadId, collector, method, params)
        return
      }
      this.byThread.get(threadId)?.handleNotification(method, params)
    }
    // 无 threadId 的全局通知（account/*、remoteControl/* 等）暂不处理
  }

  private feedCollector(threadId: string, c: EphemeralCollector, method: string, params: Params): void {
    if (method === 'item/completed') {
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
        this.collectors.delete(forkId)
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

  /** 历史：thread/read includeTurns（只读，不加载不订阅）+ 侧车 reasoning 按 turn 时间窗回插 */
  async readHistory(threadId: string): Promise<HistoryMessage[]> {
    const res = (await this.rpcRequest('thread/read', { threadId, includeTurns: true }, 60_000)) as {
      thread?: {
        turns?: Array<{ id?: string; startedAt?: number | null; completedAt?: number | null; items?: never[] }>
      }
    }
    const turns = res.thread?.turns ?? []
    const reasoning = readReasoning(threadId)
    const used = new Set<number>()
    const out: HistoryMessage[] = []
    for (const turn of turns as Array<{ id?: string; startedAt?: number | null; completedAt?: number | null; items?: never[] }>) {
      const msgs = itemsToHistory(turn.items ?? [], typeof turn.id === 'string' ? turn.id : undefined)
      if (reasoning.length > 0) {
        const start = turn.startedAt ?? 0
        const end = turn.completedAt ?? turn.startedAt ?? Number.MAX_SAFE_INTEGER / 1000
        const hit: number[] = []
        reasoning.forEach((r, i) => {
          if (used.has(i)) return
          const ts = r.ts / 1000
          if (ts >= start - 1 && ts <= end + 30) hit.push(i)
        })
        if (hit.length > 0) {
          const thinkingMsgs = hit.map((i) => ({
            uuid: `rs-${reasoning[i].ts}-${i}`,
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

  /** 分叉回滚：thread/fork beforeTurnId——复制该轮之前的历史为新线程，原线程不动 */
  async forkAt(threadId: string, beforeTurnId: string): Promise<string> {
    const res = (await this.rpcRequest('thread/fork', { threadId, beforeTurnId }, 60_000)) as {
      thread: { id: string }
    }
    return res.thread.id
  }

  /** x| key 的 cwd 惰性解析：优先已加载会话，否则 thread/read */
  async threadCwd(threadId: string): Promise<string | undefined> {
    for (const s of this.sessions.values()) {
      if (s.threadId === threadId && s.cwd) return s.cwd
    }
    const res = (await this.rpcRequest('thread/read', { threadId, includeTurns: false }, 30_000)) as {
      thread?: { cwd?: string }
    }
    return res.thread?.cwd
  }
}

export const codexRuntime = new CodexRuntime()
