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
import { config } from './config'
import {
  approvalResponse,
  controlRequest,
  isCliControlRequest,
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
  private proc: Subprocess | undefined
  private cb: SessionCallbacks
  private clientCount = 0
  private idleTimer: Timer | undefined
  private exitEmitted = false

  constructor(key: string, opts: SpawnOptions, cb: SessionCallbacks) {
    this.key = key
    this.opts = opts
    this.cb = cb
  }

  /** 对外：是否在工作（含等待审批） */
  get busy(): boolean {
    if (this.exited) return false
    if (this.activeTasks.size > 0) return true
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

  sendUserText(text: string): void {
    // 先写再标 busy，避免 write 失败导致永久 busy
    this.write(userMessage(text))
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
    this.cancelRecycle()
    this.cb.onExit(code)
  }

  private cancelRecycle(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer)
      this.idleTimer = undefined
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
        if (st === 'idle') this.fallbackBusy = false
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
      this.cb.onStatusChange?.()
      this.scheduleRecycleIfSafe()
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
