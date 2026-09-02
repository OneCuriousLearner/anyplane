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
import { errorMessage, pumpLines, sanitizePath } from '../../util'
import type { ApprovalDecision, BackgroundTask, SessionCallbacks, SpawnOptions } from '../types'
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
import { rememberSessionModel } from './sessionModels'

// 共享类型正本在 ../types（后端无关抽象层）；此处 re-export 兼容既有 import 路径
export type { ApprovalDecision, SpawnOptions } from '../types'

/** Claude Code session_state_changed 三态 */
export type SessionRunState = 'idle' | 'running' | 'requires_action'

/** 上下文窗口大小：官方 getContextWindowForModel 的 headless 近似——[1m] 后缀 → 1M，
 *  CLAUDE_CODE_DISABLE_1M_CONTEXT 为真时恒 200k，否则默认 200k。
 *  capability 表/实验 flag 是 CLI 进程内状态，headless 协议不可见（官方口径见
 *  docs/claude-code/en/statusline.md 的 context_window.context_window_size）。 */
export function contextWindowOf(model: string | undefined): number {
  const disabled = /^(1|true|yes)$/i.test(process.env.CLAUDE_CODE_DISABLE_1M_CONTEXT ?? '')
  if (!disabled && model && /\[1m\]/i.test(model)) return 1_000_000
  return 200_000
}

/** transcript 尾部回扫出的"最后一次主线 API 调用"usage（水合用，与 ClaudeSession.lastCallUsage 同形） */
export interface TranscriptCallUsage {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
}

/** 从 transcript 文本尾部倒序找最后一条主线 assistant 行的 message.usage。
 *  与实时跟踪同口径：sidechain（isSidechain:true）不计；transcript 的 usage 是完成态
 *  （output_tokens 为真实值，不像 stream 快照恒为 0）。找不到返回 undefined。 */
export function extractUsageFromTranscriptTail(text: string): TranscriptCallUsage | undefined {
  const lines = text.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim()
    if (!line || !line.includes('"assistant"')) continue
    let msg: Record<string, unknown>
    try {
      msg = JSON.parse(line) as Record<string, unknown>
    } catch {
      continue // 尾块首行可能被截断，跳过
    }
    if (msg.type !== 'assistant' || msg.isSidechain === true) continue
    const u = (msg.message as { usage?: unknown } | undefined)?.usage
    if (!u || typeof u !== 'object') continue
    const r = u as Record<string, unknown>
    return {
      inputTokens: Number(r.input_tokens ?? 0) || 0,
      outputTokens: Number(r.output_tokens ?? 0) || 0,
      cacheReadTokens: Number(r.cache_read_input_tokens ?? 0) || 0,
      cacheWriteTokens: Number(r.cache_creation_input_tokens ?? 0) || 0,
    }
  }
  return undefined
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

export class ClaudeSession {
  /** 会话 key；/clear 对话重置时由 ProcessManager.rekey 改写（进程不换，键跟随新 sessionId） */
  key: string
  readonly opts: SpawnOptions
  sessionId: string | undefined
  /** init 报告的解析后模型 ID（重连 attach 时经 statusOf 回放，前端不必等下一轮） */
  initModel: string | undefined
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
  /** 最近一次主线 API 调用的 usage（官方 statusline 的 context_window.current_usage 口径；
   *  数据源：assistant 消息的 message.usage + result.usage，sidechain 不计） */
  private lastCallUsage: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number } | undefined
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

  /** 当前上下文窗口占用（官方 statusline context_window 口径：used=input+cache，不含 output）。
   *  首个 API 应答之前为 undefined（前端据此隐藏环形 UI）。 */
  get contextUsage():
    | {
        usedTokens: number
        windowSize: number
        outputTokens: number
        inputTokens: number
        cacheReadTokens: number
        cacheWriteTokens: number
      }
    | undefined {
    const u = this.lastCallUsage
    if (!u) return undefined
    return {
      usedTokens: u.inputTokens + u.cacheReadTokens + u.cacheWriteTokens,
      windowSize: contextWindowOf(this.initModel ?? this.opts.model),
      outputTokens: u.outputTokens,
      inputTokens: u.inputTokens,
      cacheReadTokens: u.cacheReadTokens,
      cacheWriteTokens: u.cacheWriteTokens,
    }
  }

  /** 记录最近一次 API 调用的 usage（assistant 与 result 同口径）；按值去重，变了才广播 status */
  private noteContextUsage(u: unknown): void {
    if (!u || typeof u !== 'object') return
    const r = u as Record<string, unknown>
    const next = {
      inputTokens: Number(r.input_tokens ?? 0) || 0,
      outputTokens: Number(r.output_tokens ?? 0) || 0,
      cacheReadTokens: Number(r.cache_read_input_tokens ?? 0) || 0,
      cacheWriteTokens: Number(r.cache_creation_input_tokens ?? 0) || 0,
    }
    const prev = this.lastCallUsage
    if (
      prev &&
      prev.inputTokens === next.inputTokens &&
      prev.outputTokens === next.outputTokens &&
      prev.cacheReadTokens === next.cacheReadTokens &&
      prev.cacheWriteTokens === next.cacheWriteTokens
    ) {
      return
    }
    this.lastCallUsage = next
    this.cb.onStatusChange?.()
  }

  /** resume/fork 水合：回扫源 transcript 尾部，把最后一条主线 assistant 的 usage 播种为
   *  上下文占用，让环形 UI 在首个新 turn 之前就有数（resume 后 CLI 不重放 usage，实测）。
   *  rewind（resumeSessionAt）会截断历史，尾部是"被回滚掉的未来"，跳过；
   *  竞态守卫：首个新 turn 的 live 值先到则不覆盖（水合是尽力而为，读不到就等首 turn）。 */
  private hydrateContextUsage(): void {
    const sourceId = this.opts.resumeSessionId ?? this.opts.forkFromSessionId
    if (!sourceId || this.opts.resumeSessionAt) return
    const path = join(config.claudeConfigDir, 'projects', sanitizePath(this.opts.cwd), `${sourceId}.jsonl`)
    void (async () => {
      const f = Bun.file(path)
      const TAIL = 768 * 1024
      const text = await f.slice(Math.max(0, f.size - TAIL), f.size).text()
      return extractUsageFromTranscriptTail(text)
    })()
      .then((u) => {
        if (!u || this.lastCallUsage || this.exited) return
        this.lastCallUsage = u
        this.cb.onStatusChange?.()
      })
      .catch(() => {}) // transcript 缺失/不可读：保持隐藏，等首个新 turn
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
    this.hydrateContextUsage()
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
    if (this.opts.forkFromSessionId) {
      args.push('--fork-session', '--resume', this.opts.forkFromSessionId)
    } else if (this.opts.resumeSessionId) {
      args.push('--resume', this.opts.resumeSessionId)
    }
    if (this.opts.resumeSessionAt) args.push('--resume-session-at', this.opts.resumeSessionAt)
    if (this.opts.model) args.push('--model', this.opts.model)
    if (this.opts.effort) args.push('--effort', this.opts.effort)
    if (this.opts.sessionName) args.push('-n', this.opts.sessionName)
    if (this.opts.permissionMode) args.push('--permission-mode', this.opts.permissionMode)

    console.log(`[session ${this.key}] spawn: ${cmd} ${args.join(' ')}`)
    try {
      this.proc = spawn([cmd, ...args], {
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
      const detail = errorMessage(e)
      throw new Error(`无法启动 claude CLI (${cmd}): ${detail}`)
    }
    const proc = this.proc
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
        // 等待中的控制请求计入 busy（见 getter）；超时清空后 busy 可能翻回 false。
        // 纯控制查询的会话没有 session_state_changed，不推状态前端会永远停在"工作中"
        this.cb.onStatusChange?.()
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

  /**
   * 官方进程内侧问（headless 2.1.220 实测）：CLI 内部 fork 一个无工具的轻量 agent，
   * 复用主会话的 prompt cache 与对话上下文，不产生磁盘 FORK 会话、不打断进行中的 turn。
   * 应答是单次的（无流式），一次 API 往返，给足超时。
   */
  async sideQuestion(question: string): Promise<string> {
    const resp = (await this.sendControlAndWait('side_question', { question }, 180_000)) as {
      response?: string | null
    }
    return resp?.response ?? ''
  }

  /**
   * 官方 AI 会话标题（Haiku 单次往返，CLI 侧 fire-and-forget 不阻塞 stdin 循环）。
   * persist:true 让 CLI 把 {type:'ai-title'} 追加进 transcript——discovery 的标题链
   * （custom-title > ai-title > summary > 首条消息）会自动接住，无需 anyplane 侧落任何状态。
   * 失败/超时返回 null（Haiku 不可用、响应不可解析均为 null），调用方静默忽略即可。
   */
  async generateSessionTitle(description: string): Promise<string | null> {
    const resp = (await this.sendControlAndWait(
      'generate_session_title',
      { description: description.slice(0, 500), persist: true },
      15_000,
    )) as { title?: string | null } | undefined
    return resp?.title ?? null
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
    await pumpLines(
      this.proc.stdout as ReadableStream<Uint8Array>,
      (line) => this.handleLine(line),
      (e) => console.error(`[session ${this.key}] stdout 读取异常:`, e),
    )
  }

  private async pumpStderr(): Promise<void> {
    if (!this.proc) return
    const text = await new Response(this.proc.stderr as ReadableStream<Uint8Array>).text()
    if (text.trim()) console.error(`[session ${this.key}] stderr:`, text.slice(0, 4000))
  }

  /** 测试钩子：不 spawn 直接注入 NDJSON 行（scripts/replay-fixture.ts 回放用） */
  injectLine(line: string): void {
    this.handleLine(line)
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
      // 记录 init 报告的模型 ID（当前档位解析后的真实值），供 statusOf 在重连/attach 时回放给前端
      if (typeof msg.model === 'string') {
        this.initModel = msg.model
        // 持久化一份给离线水合：transcript 的 message.model 缺 [1m] 后缀，窗口启发式只能靠这里
        if (this.sessionId) rememberSessionModel(this.sessionId, msg.model)
      }
      console.log(`[session ${this.key}] init session_id=${this.sessionId}`)
      // initModel/sessionId 入库即回放：先于 init 到达的 attach 拿到的状态里 model 还是空的
      this.cb.onStatusChange?.()
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

    // 主线 assistant 消息的 per-call usage：官方 statusline current_usage 的 headless 等价物。
    // sidechain（子代理）上下文独立，不计入主窗口占用
    if (msg.type === 'assistant' && msg.parent_tool_use_id == null && msg.isSidechain !== true) {
      this.noteContextUsage((msg.message as { usage?: unknown } | undefined)?.usage)
    }

    // token 用量累计：result.usage（费用字段不进累加器、不进 UI）
    if (msg.type === 'result' && msg.usage && typeof msg.usage === 'object') {
      const u = msg.usage as Record<string, unknown>
      const acc = (field: keyof typeof this.usageAcc, v: unknown) => {
        this.usageAcc[field] += Number(v ?? 0) || 0
      }
      acc('inputTokens', u.input_tokens)
      acc('outputTokens', u.output_tokens)
      acc('cacheReadTokens', u.cache_read_input_tokens)
      acc('cacheWriteTokens', u.cache_creation_input_tokens)
      // result.usage 是本 turn 各 API 调用的累计（turn 口径，usageAcc 靠它做 session 累计正
      // 确）；上下文占用必须保持"最后一次调用"口径（assistant 消息），绝不能把 turn 总和写
      // 进去——否则多调用 turn 结束时 input/cache 会虚增（实测 2 次调用 ≈ 翻倍）。
      // 唯一取用的是 output_tokens：assistant 流式快照的 output 恒为 0，turn 总输出以它为终值。
      const out = Number(u.output_tokens ?? 0) || 0
      if (this.lastCallUsage && out !== this.lastCallUsage.outputTokens) {
        this.lastCallUsage = { ...this.lastCallUsage, outputTokens: out }
      }
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
        // pending 清空后 busy 可能翻回 false（纯控制查询的会话没有 session_state_changed
        // 兜底推送），必须主动通知，否则前端"工作中"永挂
        this.cb.onStatusChange?.()
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

  /** /clear 对话重置后的重键：会话进程不换，map 键跟随新 sessionId。
   *  不迁的话 hub 按新 key 查不到进程会再起一个（双进程同 transcript）。 */
  rekey(oldKey: string, newKey: string): boolean {
    const s = this.sessions.get(oldKey)
    if (!s) return false
    this.sessions.delete(oldKey)
    s.key = newKey
    this.sessions.set(newKey, s)
    return true
  }

  disposeAll(): void {
    const all = [...this.sessions.values()]
    this.sessions.clear()
    console.log(`[processManager] disposeAll sessions=${all.length}`)
    for (const s of all) s.dispose()
  }
}

export const processManager = new ProcessManager()
