// Claude CLI 子进程管理：spawn / NDJSON 读写 / 控制请求 / 空闲回收
// 跨平台：Windows 上 claude 可能是 .cmd/.bat（需 cmd.exe 包装）或 .exe

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

/** 解析 claude 可执行文件。返回 [cmd, prefixArgs] —— .cmd/.bat 需要 cmd.exe 包装 */
export function resolveClaudeCommand(): { cmd: string; prefix: string[] } {
  if (config.claudePath) return wrapIfBatch(config.claudePath)

  if (process.platform === 'win32') {
    const out = spawnSync(['where.exe', 'claude'])
    const lines = out.stdout.toString().split(/\r?\n/).filter(Boolean)
    // 优先原生 .exe，避免 cmd 包装带来的 kill 困难
    const exe = lines.find((l) => l.toLowerCase().endsWith('.exe'))
    const picked = exe ?? lines[0]
    if (picked) return wrapIfBatch(picked.trim())
  } else {
    const out = spawnSync(['which', 'claude'])
    const p = out.stdout.toString().trim().split('\n')[0]
    if (p) return { cmd: p, prefix: [] }
  }
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
  /** 进程退出 */
  onExit(code: number): void
}

export class ClaudeSession {
  readonly key: string
  readonly opts: SpawnOptions
  sessionId: string | undefined
  busy = false
  exited = false
  private proc: Subprocess | undefined
  private cb: SessionCallbacks
  private clientCount = 0
  private idleTimer: Timer | undefined

  constructor(key: string, opts: SpawnOptions, cb: SessionCallbacks) {
    this.key = key
    this.opts = opts
    this.cb = cb
  }

  spawn(): void {
    if (this.proc && !this.exited) return
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
    this.proc = spawn([cmd, ...args], {
      cwd: this.opts.cwd,
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe', // 吞掉 stderr，避免干扰；需要诊断时可改为 inherit
      env: {
        ...process.env,
        // headless/SDK 模式下文件检查点默认关闭，rewind_files 需要它
        CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING: '1',
      },
    })
    this.exited = false
    void this.pumpStdout()
    void this.pumpStderr()
    void this.proc.exited.then((code) => {
      this.exited = true
      this.busy = false
      console.log(`[session ${this.key}] exited code=${code}`)
      this.cb.onExit(code)
    })
  }

  write(msg: StdinMessage): void {
    if (!this.proc || this.exited) throw new Error('进程未运行')
    this.proc.stdin.write(JSON.stringify(msg) + '\n')
  }

  sendUserText(text: string): void {
    this.busy = true
    this.write(userMessage(text))
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
    if (this.idleTimer) {
      clearTimeout(this.idleTimer)
      this.idleTimer = undefined
    }
  }

  detachClient(): void {
    this.clientCount = Math.max(0, this.clientCount - 1)
    if (this.clientCount === 0) {
      this.idleTimer = setTimeout(() => {
        console.log(`[session ${this.key}] 空闲超时，回收子进程`)
        this.dispose()
      }, config.idleTimeoutMs)
    }
  }

  get connectedClients(): number {
    return this.clientCount
  }

  dispose(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    try {
      this.proc?.kill()
    } catch {}
    this.exited = true
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
    if (msg.type === 'result') this.busy = false

    if (isCliControlRequest(msg)) {
      const req = msg.request!
      if (req.subtype === 'can_use_tool') {
        this.cb.onApprovalRequest({
          requestId: msg.request_id!,
          toolName: String(req.tool_name ?? ''),
          input: req.input,
          toolUseId: req.tool_use_id as string | undefined,
        })
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
    const s = new ClaudeSession(key, opts, {
      onMessage: cb.onMessage,
      onApprovalRequest: cb.onApprovalRequest,
      onExit: (code) => {
        // 防止旧进程的退出事件删掉已重生的新会话
        if (this.sessions.get(key) === s) this.sessions.delete(key)
        cb.onExit(code)
      },
    })
    this.sessions.set(key, s)
    s.spawn()
    return s
  }

  disposeAll(): void {
    for (const s of this.sessions.values()) s.dispose()
    this.sessions.clear()
  }
}

export const processManager = new ProcessManager()
