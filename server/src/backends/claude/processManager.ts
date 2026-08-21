// Claude CLI 子进程管理：spawn / NDJSON 读写 / 控制请求 / 空闲回收
// 跨平台：Windows 上 claude 可能是 .cmd/.bat（需 cmd.exe 包装）或 .exe
//
// busy 语义：优先信任 Claude Code 的 system/session_state_changed，另以
// task_started/task_notification 维护后台任务表。后者覆盖 background Agent、
// workflow 与后台 shell，防止主会话 idle 时误回收仍在运行的子任务。
// 未发出 state 事件时回退到 sendUserText→result 启发式。

import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { spawn, spawnSync, type Subprocess } from 'bun'
import { config } from '../../config'
import {
  approvalResponse,
  controlRequest,
  isCliControlRequest,
  isControlResponse,
  isInitMessage,
  userMessage,
  type CliMessage,
  type StdinMessage,
} from './protocol'

export interface SpawnOptions {
  cwd: string
  resumeSessionId?: string
  /** 对话回滚：加载到指定消息处截断（配合 resumeSessionId） */
  resumeSessionAt?: string
  model?: string
  effort?: string
  permissionMode?: string
}

/** Claude Code session_state_changed 三态 */
export type SessionRunState = 'idle' | 'running' | 'requires_action'

/** Claude Code SDK system/task_started 暴露的后台任务最小状态。 */
export interface BackgroundTask {
  id: string
  description: string
  taskType?: string
  toolUseId?: string
  startedAt: number
  lastToolName?: string
  summary?: string
}

/** 解析 claude 可执行文件。返回 [cmd, prefixArgs] —— .cmd/.bat 需要 cmd.exe 包装 */
export function resolveClaudeCommand(): { cmd: string; prefix: string[] } {
  const candidates: string[] = []
  if (config.claudePath) candidates.push(config.claudePath)

  if (process.platform === 'win32') {
    const out = spawnSync(['where.exe', 'claude'])
    for (const line of out.stdout.toString().split(/\r?\n/).filter(Boolean)) {
      candidates.push(line.trim())
    }
    // where 偶发指向已删除/更新中的路径，再试常见安装位
    candidates.push(join(homedir(), '.local', 'bin', 'claude.exe'))
  } else {
    const out = spawnSync(['which', 'claude'])
    const p = out.stdout.toString().trim().split('\n')[0]
    if (p) candidates.push(p)
  }

  // 优先原生 .exe，且必须真实存在（避免 ENOENT 拖垮服务）
  const existing = candidates.filter((p) => p && existsSync(p))
  const exe = existing.find((l) => l.toLowerCase().endsWith('.exe'))
  const picked = exe ?? existing[0]
  if (picked) return wrapIfBatch(picked)

  // 兜底：交给 PATH 解析（win32 下 Bun.spawn 无法直接跑 .cmd，会抛错，属可接受报错）
  return { cmd: 'claude', prefix: [] }
}

function wrapIfBatch(p: string): { cmd: string; prefix: string[] } {
  if (/\.(cmd|bat)$/i.test(p)) return { cmd: 'cmd.exe', prefix: ['/d', '/s', '/c', p] }
  return { cmd: p, prefix: [] }
}

export type ApprovalDecision =
  | { behavior: 'allow'; updatedInput?: unknown }
  | { behavior: 'deny'; message?: string }

export interface SessionCallbacks {
  /** CLI 推送的任何消息（含 assistant/user/system/stream_event/result…） */
  onMessage(msg: CliMessage): void
  /** CLI 主动请求权限（can_use_tool）。应 resolve 审批结果 */
  onApprovalRequest(req: {
    requestId: string
    toolName: string
    input: unknown
    toolUseId?: string
  }): void
  /** 进程退出（仅当前仍登记在 ProcessManager 中的实例会回调） */
  onExit(code: number): void
  /** busy / sessionState 变化时通知宿主广播 status */
  onStatusChange?(): void
}

export class ClaudeSession {
  readonly key: string
  readonly opts: SpawnOptions
  sessionId: string | undefined
  exited = false
  /** 是否已收到过 session_state_changed（权威信号） */
  private sawStateEvents = false
  private runState: SessionRunState = 'idle'
  /** 无 state 事件时的回退：sendUserText 成功 → true，result → false */
  private fallbackBusy = false
  /** task_started → task_notification 的任务表，独立于主会话运行状态。 */
  private activeTasks = new Map<string, BackgroundTask>()
  /** queue 模式（busy 时发消息）：headless 下 'next'/'later' 会在本轮结束后滞留，
   *  因此排队由服务端实现——idle/result 时按序 flush。 */
  private queuedTexts: Array<{ text: string; images?: Array<{ mediaType: string; dataBase64: string }> }> = []
  /** initialize 握手返回的 slash 命令（含描述），供前端补全 */
  slashCommands: Array<{ name: string; description?: string }> = []
  private proc: Subprocess | undefined
  private cb: SessionCallbacks
  private clientCount = 0
  private idleTimer: Timer | undefined
  private exitEmitted = false
  /** 本进程内各 turn result.usage 的累计（只计 token，不含任何费用字段） */
  private usageAcc = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }
  /** 等待 CLI 确认的外发 control request，例如组合 rewind 的第一步。 */
  private pendingControlRequests = new Map<string, {
    resolve: (response: unknown) => void
    reject: (error: Error) => void
    timeout: Timer
  }>()

  constructor(key: string, opts: SpawnOptions, cb: SessionCallbacks) {
    this.key = key
    this.opts = opts
    this.cb = cb
  }

  /** 对外：是否在工作（含等待审批、等待控制请求应答、排队消息待发） */
  get busy(): boolean {
    if (this.exited) return false
    if (this.queuedTexts.length > 0) return true
    if (this.activeTasks.size > 0) return true
    // 等待中的控制请求（如 rewind_files）期间 CLI 不会发 session_state_changed，
    // 但进程显然不算空闲——与审批等待同待遇，防止误回收
    if (this.pendingControlRequests.size > 0) return true
    if (this.sawStateEvents) {
      return this.runState === 'running' || this.runState === 'requires_action'
    }
    return this.fallbackBusy
  }

  /** 等待用户审批 */
  get waiting(): boolean {
    if (this.exited) return false
    return this.runState === 'requires_action'
  }

  get sessionState(): SessionRunState {
    return this.exited ? 'idle' : this.runState
  }

  get connectedClients(): number {
    return this.clientCount
  }

  get activeTaskCount(): number {
    return this.activeTasks.size
  }

  /** 累计 token 用量（本进程生命周期内） */
  get tokenUsage(): { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number } {
    return { ...this.usageAcc }
  }

  /** 返回副本，避免调用方改写回收判定所依赖的任务表。 */
  get backgroundTasks(): BackgroundTask[] {
    return [...this.activeTasks.values()].map((task) => ({ ...task }))
  }

  /** 懒 spawn 后把已连接的 WS 客户端数对齐 */
  syncClients(count: number): void {
    const next = Math.max(0, count)
    if (next > 0 && this.idleTimer) {
      clearTimeout(this.idleTimer)
      this.idleTimer = undefined
    }
    this.clientCount = next
    this.scheduleRecycleIfSafe()
  }

  spawn(): void {
    if (this.proc && !this.exited) return
    if (!existsSync(this.opts.cwd)) {
      throw new Error(`项目目录不存在: ${this.opts.cwd}`)
    }
    const { cmd, prefix } = resolveClaudeCommand()
    const args = [
      ...prefix,
      '--print',
      '--verbose',
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      '--include-partial-messages',
      '--allow-dangerously-skip-permissions',
      // 关键：把权限询问外化为 stdout 的 can_use_tool 控制请求（与 --sdk-url 内部行为一致）
      '--permission-prompt-tool', 'stdio',
    ]
    if (this.opts.resumeSessionId) args.push('--resume', this.opts.resumeSessionId)
    if (this.opts.resumeSessionAt) args.push('--resume-session-at', this.opts.resumeSessionAt)
    if (this.opts.model) args.push('--model', this.opts.model)
    if (this.opts.effort) args.push('--effort', this.opts.effort)
    if (this.opts.permissionMode) args.push('--permission-mode', this.opts.permissionMode)

    console.log(`[session ${this.key}] spawn: ${cmd} ${args.join(' ')}`)
    const proc = (() => {
      try {
        return spawn([cmd, ...args], {
          cwd: this.opts.cwd,
          stdin: 'pipe',
          stdout: 'pipe',
          stderr: 'pipe', // 吞掉 stderr，避免干扰；需要诊断时可改为 inherit
          env: {
            ...process.env,
            // headless/SDK 模式下文件检查点默认关闭，rewind_files 需要它
            CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING: '1',
            // 启用权威 idle/running/requires_action 事件（Claude Code sessionState.ts）
            CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS: '1',
          },
        })
      } catch (e) {
        this.exited = true
        this.proc = undefined
        const detail = e instanceof Error ? e.message : String(e)
        throw new Error(`无法启动 claude CLI (${cmd}): ${detail}`)
      }
    })()
    this.proc = proc
    console.log(`[session ${this.key}] spawned pid=${proc.pid} parent=${process.pid}`)
    this.exited = false
    this.exitEmitted = false
    this.sawStateEvents = false
    this.runState = 'idle'
    this.fallbackBusy = false
    this.activeTasks.clear()
    // initialize 握手：拿 slash 命令清单（含描述）；开启 prompt_suggestion（若该版本支持）。
    // 必须在首条 user 消息前发出；失败不影响会话（老版本无此请求）。
    void this.sendControlAndWait('initialize', { promptSuggestions: true }, 10_000)
      .then((resp) => {
        const commands = (resp as { commands?: Array<{ name?: string; description?: string }> } | undefined)?.commands
        if (Array.isArray(commands)) {
          this.slashCommands = commands
            .filter((c): c is { name: string; description?: string } => typeof c?.name === 'string')
            .map((c) => ({ name: c.name, description: c.description }))
          this.cb.onStatusChange?.()
        }
      })
      .catch(() => {})
    void this.pumpStdout()
    void this.pumpStderr()
    void proc.exited.then((code) => {
      // 进程已被 dispose/替换时忽略
      if (this.proc !== proc && this.exitEmitted) return
      console.log(`[session ${this.key}] exited code=${code}`)
      this.emitExit(code)
    })
  }

  write(msg: StdinMessage): void {
    if (!this.proc || this.exited) throw new Error('进程未运行')
    const stdin = this.proc.stdin
    if (typeof stdin === 'number' || !stdin) throw new Error('stdin 不可用')
    stdin.write(JSON.stringify(msg) + '\n')
  }

  /**
   * sendMode（busy 时语义）：
   * - steer = priority 'now'：中断当前操作并立即处理本条（2.1.220 实测可用）
   * - queue = 服务端排队：session_state idle / result 后按序 flush
   *   （headless 下 priority 'next'/'later' 会在本轮结束后滞留队列，不可用）
   */
  sendUserText(
    text: string,
    sendMode?: 'steer' | 'queue',
    images?: Array<{ mediaType: string; dataBase64: string }>,
  ): void {
    if (sendMode === 'queue' && this.busy) {
      this.queuedTexts.push({ text, images })
      this.cb.onStatusChange?.()
      return
    }
    const priority = sendMode === 'steer' && this.busy ? ('now' as const) : undefined
    // 先写再标 busy，避免 write 失败导致永久 busy
    this.write(userMessage(text, priority, images))
    if (!this.sawStateEvents) {
      this.fallbackBusy = true
      this.cb.onStatusChange?.()
    }
    // 有 state 事件时以 CLI 的 running 为准，不在此抢先置位
    this.cancelRecycle()
  }

  sendControl(subtype: string, extra: Record<string, unknown> = {}): string {
    const req = controlRequest(subtype as never, extra)
    this.write(req)
    return req.request_id
  }

  /**
   * 发送控制请求并等待同 request_id 的 CLI 应答。
   * 普通控制仍使用 sendControl 保持原有的纯透传语义；只有需要串行步骤时使用。
   * rewind_files 没有 CLI 侧超时，大项目恢复可达分钟级——调用方应按需调大 timeoutMs。
   */
  sendControlAndWait(subtype: string, extra: Record<string, unknown> = {}, timeoutMs = 15_000): Promise<unknown> {
    return new Promise((resolve, reject) => {
      let requestId: string
      try {
        requestId = this.sendControl(subtype, extra)
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)))
        return
      }
      const timeout = setTimeout(() => {
        this.pendingControlRequests.delete(requestId)
        reject(new Error(`控制请求 ${subtype} 超时`))
        this.scheduleRecycleIfSafe()
      }, timeoutMs)
      // write 已同步完成，CLI 的应答最早在后续事件循环 tick 才到达，此时注册不会丢响应
      this.pendingControlRequests.set(requestId, { resolve, reject, timeout })
      // 等待期间按 busy 处理（见 busy getter），这里只需取消已排程的回收
      this.cancelRecycle()
    })
  }

  sendApproval(requestId: string, decision: ApprovalDecision): void {
    this.write(approvalResponse(requestId, decision))
  }

  attachClient(): void {
    this.clientCount++
    this.cancelRecycle()
  }

  detachClient(): void {
    this.clientCount = Math.max(0, this.clientCount - 1)
    this.scheduleRecycleIfSafe()
  }

  /** 宿主在 pendingApprovals 变化后调用，驱动回收判定 */
  notifyExternalGate(): void {
    this.scheduleRecycleIfSafe()
  }

  dispose(): void {
    this.cancelRecycle()
    const pid = this.proc?.pid
    console.log(`[session ${this.key}] dispose pid=${pid ?? 'none'} exited=${this.exited}`)
    try {
      this.proc?.kill()
    } catch (e) {
      console.warn(`[session ${this.key}] proc.kill failed pid=${pid}:`, e)
    }
    // Windows：强制杀掉整棵进程树，避免 Ctrl+C 后 claude 子进程残留拖住端口
    if (process.platform === 'win32' && pid) {
      try {
        const killed = spawnSync(['taskkill', '/PID', String(pid), '/T', '/F'], {
          stdout: 'ignore',
          stderr: 'pipe',
          stdin: 'ignore',
        })
        console.log(
          `[session ${this.key}] taskkill pid=${pid} exitCode=${killed.exitCode} stderr=${killed.stderr.toString().trim() || '-'}`,
        )
      } catch (e) {
        console.warn(`[session ${this.key}] taskkill failed pid=${pid}:`, e)
      }
    }
    this.proc = undefined
    this.emitExit(-1)
  }

  private emitExit(code: number): void {
    if (this.exitEmitted) return
    this.exitEmitted = true
    this.exited = true
    this.fallbackBusy = false
    this.runState = 'idle'
    this.activeTasks.clear()
    this.queuedTexts.length = 0
    for (const pending of this.pendingControlRequests.values()) {
      clearTimeout(pending.timeout)
      pending.reject(new Error('Claude 进程已退出'))
    }
    this.pendingControlRequests.clear()
    this.cancelRecycle()
    this.cb.onExit(code)
  }

  private cancelRecycle(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer)
      this.idleTimer = undefined
    }
  }

  /** queue 模式排队消息：idle 时按序发出下一条（其 result/idle 再触发下一条） */
  private flushQueue(): void {
    if (this.exited || this.queuedTexts.length === 0) return
    if (this.sawStateEvents ? this.runState !== 'idle' : this.fallbackBusy) return
    const next = this.queuedTexts.shift()!
    try {
      this.sendUserText(next.text, undefined, next.images)
    } catch (e) {
      console.warn(`[session ${this.key}] 排队消息发送失败:`, e)
      this.queuedTexts.unshift(next)
    }
  }

  /** 无客户端、主会话空闲且无后台任务时才调度回收。 */
  private scheduleRecycleIfSafe(): void {
    this.cancelRecycle()
    if (this.exited || this.clientCount > 0 || this.busy) return
    const delay = this.sawStateEvents ? config.detachRecycleMs : config.idleTimeoutMs
    this.idleTimer = setTimeout(() => {
      this.idleTimer = undefined
      if (this.exited || this.clientCount > 0 || this.busy) return
      console.log(
        `[session ${this.key}] 空闲回收（clients=0, state=${this.sessionState}, sawState=${this.sawStateEvents}）`,
      )
      this.dispose()
    }, delay)
  }

  private async pumpStdout(): Promise<void> {
    if (!this.proc) return
    const reader = (this.proc.stdout as ReadableStream<Uint8Array>).getReader()
    const decoder = new TextDecoder()
    let buf = ''
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        buf += decoder.decode(value, { stream: true })
        let idx: number
        while ((idx = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, idx).trim()
          buf = buf.slice(idx + 1)
          if (line) this.handleLine(line)
        }
      }
      if (buf.trim()) this.handleLine(buf.trim())
    } catch (e) {
      console.error(`[session ${this.key}] stdout 读取异常:`, e)
    }
  }

  private async pumpStderr(): Promise<void> {
    if (!this.proc) return
    const text = await new Response(this.proc.stderr as ReadableStream<Uint8Array>).text()
    if (text.trim()) console.error(`[session ${this.key}] stderr:`, text.slice(0, 4000))
  }

  private handleLine(line: string): void {
    let msg: CliMessage
    try {
      msg = JSON.parse(line)
    } catch {
      console.error(`[session ${this.key}] 非 JSON 行:`, line.slice(0, 200))
      return
    }
    if (isInitMessage(msg)) {
      this.sessionId = msg.session_id
      console.log(`[session ${this.key}] init session_id=${this.sessionId}`)
    }

    // 权威状态：system/session_state_changed
    if (msg.type === 'system' && msg.subtype === 'session_state_changed') {
      const st = msg.state
      if (st === 'idle' || st === 'running' || st === 'requires_action') {
        this.sawStateEvents = true
        this.runState = st
        if (st === 'idle') {
          this.fallbackBusy = false
          this.flushQueue()
        }
        console.log(`[session ${this.key}] session_state=${st}`)
        this.cb.onStatusChange?.()
        this.scheduleRecycleIfSafe()
      }
    }

    // Claude Code 的后台任务生命周期。不能只依赖 session_state_changed：
    // background Agent 可能让主会话先结束当前模型回合，而任务仍在异步执行。
    // task_notification 是 task_started 的唯一终态 bookend。
    if (msg.type === 'system' && msg.subtype === 'task_started' && typeof msg.task_id === 'string') {
      this.activeTasks.set(msg.task_id, {
        id: msg.task_id,
        description: typeof msg.description === 'string' ? msg.description : '',
        taskType: typeof msg.task_type === 'string' ? msg.task_type : undefined,
        toolUseId: typeof msg.tool_use_id === 'string' ? msg.tool_use_id : undefined,
        startedAt: Date.now(),
      })
      console.log(`[session ${this.key}] task_started id=${msg.task_id} type=${msg.task_type ?? '-'} active=${this.activeTasks.size}`)
      this.cb.onStatusChange?.()
      this.scheduleRecycleIfSafe()
    }

    if (msg.type === 'system' && msg.subtype === 'task_progress' && typeof msg.task_id === 'string') {
      const task = this.activeTasks.get(msg.task_id)
      if (task) {
        if (typeof msg.last_tool_name === 'string') task.lastToolName = msg.last_tool_name
        if (typeof msg.summary === 'string') task.summary = msg.summary
      }
      this.cb.onStatusChange?.()
    }

    if (msg.type === 'system' && msg.subtype === 'task_notification' && typeof msg.task_id === 'string') {
      const removed = this.activeTasks.delete(msg.task_id)
      if (removed) {
        console.log(`[session ${this.key}] task_finished id=${msg.task_id} status=${msg.status ?? '-'} active=${this.activeTasks.size}`)
        this.cb.onStatusChange?.()
        this.scheduleRecycleIfSafe()
      }
    }

    // 兼容回退：无 state 事件时用 result 清 busy
    if (msg.type === 'result' && !this.sawStateEvents) {
      this.fallbackBusy = false
      this.flushQueue()
      this.cb.onStatusChange?.()
      this.scheduleRecycleIfSafe()
    }

    // token 用量累计：result.usage（费用字段不进累加器、不进 UI）
    if (msg.type === 'result' && msg.usage && typeof msg.usage === 'object') {
      const u = msg.usage as Record<string, unknown>
      this.usageAcc.inputTokens += Number(u.input_tokens ?? 0) || 0
      this.usageAcc.outputTokens += Number(u.output_tokens ?? 0) || 0
      this.usageAcc.cacheReadTokens += Number(u.cache_read_input_tokens ?? 0) || 0
      this.usageAcc.cacheWriteTokens += Number(u.cache_creation_input_tokens ?? 0) || 0
      this.cb.onStatusChange?.()
    }

    if (isControlResponse(msg)) {
      const response = msg.response as {
        subtype?: unknown
        request_id?: unknown
        response?: unknown
        error?: unknown
      }
      const requestId = typeof response.request_id === 'string' ? response.request_id : undefined
      const pending = requestId ? this.pendingControlRequests.get(requestId) : undefined
      if (pending && requestId) {
        this.pendingControlRequests.delete(requestId)
        clearTimeout(pending.timeout)
        if (response.subtype === 'success') pending.resolve(response.response)
        else pending.reject(new Error(typeof response.error === 'string' ? response.error : '控制请求失败'))
        this.scheduleRecycleIfSafe()
        // 已被 sendControlAndWait 消费的应答不再透传（与 can_use_tool 同模式）：
        // 消费方（如 rewind_both）会自行广播结果，透传会造成同一结果/错误双重展示
        return
      }
      // 无 pending 匹配的 control_response（其他客户端发起、或迟到应答）保持透传
    }

    if (isCliControlRequest(msg)) {
      const req = msg.request!
      if (req.subtype === 'can_use_tool') {
        // 无 state 事件时，审批等待也必须保持 busy
        if (!this.sawStateEvents) this.fallbackBusy = true
        this.cb.onApprovalRequest({
          requestId: msg.request_id!,
          toolName: String(req.tool_name ?? ''),
          input: req.input,
          toolUseId: req.tool_use_id as string | undefined,
        })
        this.cb.onStatusChange?.()
        return // 不转发给普通消息流，由审批通道处理
      }
    }
    this.cb.onMessage(msg)
  }
}

// ---------- 管理器 ----------

export class ProcessManager {
  private sessions = new Map<string, ClaudeSession>()

  get(key: string): ClaudeSession | undefined {
    return this.sessions.get(key)
  }

  ensure(key: string, opts: SpawnOptions, cb: SessionCallbacks): ClaudeSession {
    const existing = this.sessions.get(key)
    if (existing && !existing.exited) return existing
    // 旧实例已 exited 但仍占位时清掉
    if (existing) this.sessions.delete(key)

    const s = new ClaudeSession(key, opts, {
      onMessage: cb.onMessage,
      onApprovalRequest: cb.onApprovalRequest,
      onStatusChange: cb.onStatusChange,
      onExit: (code) => {
        // 防止旧进程的退出事件删掉/污染已重生的新会话
        if (this.sessions.get(key) !== s) return
        this.sessions.delete(key)
        cb.onExit(code)
      },
    })
    this.sessions.set(key, s)
    try {
      s.spawn()
    } catch (e) {
      this.sessions.delete(key)
      throw e
    }
    return s
  }

  /** 主动销毁（rewind / 强制回收）；先从 map 摘掉再 kill，避免 stale onExit */
  dispose(key: string): void {
    const s = this.sessions.get(key)
    if (!s) return
    this.sessions.delete(key)
    s.dispose()
  }

  disposeAll(): void {
    const all = [...this.sessions.values()]
    this.sessions.clear()
    console.log(`[processManager] disposeAll sessions=${all.length}`)
    for (const s of all) s.dispose()
  }
}

export const processManager = new ProcessManager()
