// WebSocket 客户端：按 sessionKey 连接，自动重连

export type ServerEvent =
  | { kind: 'cli'; msg: CliMsg }
  | { kind: 'status'; state: SessionState }
  | { kind: 'approval_request'; requestId: string; toolName: string; input: unknown }
  | { kind: 'approval_resolved'; requestId: string }
  | { kind: 'btw_pending'; question: string }
  | { kind: 'btw_delta'; question: string; delta: string; thinking?: boolean }
  | { kind: 'btw_result'; ok: boolean; question: string; text: string }
  | { kind: 'rewound'; userMessageId: string; scope?: 'conversation' | 'both' }
  | { kind: 'error'; message: string }

export interface CliMsg {
  type: string
  subtype?: string
  session_id?: string
  uuid?: string
  message?: { role?: string; content?: unknown }
  [k: string]: unknown
}

export interface SessionState {
  spawned: boolean
  busy: boolean
  /** 等待用户审批（can_use_tool / requires_action） */
  waiting?: boolean
  /** Claude Code 权威状态：idle | running | requires_action */
  sessionState?: 'idle' | 'running' | 'requires_action'
  sessionId?: string
  clients?: number
  /** Claude Code system/task_started 与 task_notification 之间的后台任务数。 */
  activeTaskCount?: number
  /** 运行中任务的最小信息；不含 prompt、输出等敏感/冗长内容。 */
  activeTasks?: Array<{
    id: string
    description: string
    taskType?: string
    toolUseId?: string
    startedAt: number
    lastToolName?: string
    summary?: string
  }>
  /** 未启动时为待应用启动参数；已启动时为当前选择 */
  model?: string
  permissionMode?: string
  effort?: string
  exited?: boolean
  exitCode?: number
}

export type ClientCommand =
  | { kind: 'attach'; warm?: boolean; opts?: Record<string, unknown> }
  | { kind: 'user'; text: string }
  | { kind: 'control'; subtype: string; extra?: Record<string, unknown> }
  | { kind: 'update_env'; variables: Record<string, string> }
  | { kind: 'approval'; requestId: string; decision: unknown }
  | { kind: 'rewind_conversation'; userMessageId: string }
  | { kind: 'rewind_both'; userMessageId: string }
  | { kind: 'btw'; question: string }

export class SessionSocket {
  private ws: WebSocket | undefined
  private retry = 0
  private closed = false
  private queue: ClientCommand[] = []

  constructor(
    public key: string,
    private onEvent: (ev: ServerEvent) => void,
    private onOpenChange?: (open: boolean) => void,
  ) {
    this.connect()
  }

  private connect(): void {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws'
    const ws = new WebSocket(`${proto}://${location.host}/ws/sessions/${encodeURIComponent(this.key)}`)
    this.ws = ws
    ws.onopen = () => {
      this.retry = 0
      this.onOpenChange?.(true)
      for (const c of this.queue) ws.send(JSON.stringify(c))
      this.queue = []
    }
    ws.onmessage = (e) => {
      try {
        this.onEvent(JSON.parse(e.data))
      } catch {}
    }
    ws.onclose = () => {
      this.onOpenChange?.(false)
      if (this.closed) return
      const delay = Math.min(1000 * 2 ** this.retry++, 15000)
      setTimeout(() => !this.closed && this.connect(), delay)
    }
    ws.onerror = () => ws.close()
  }

  send(cmd: ClientCommand): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(cmd))
    else this.queue.push(cmd)
  }

  close(): void {
    this.closed = true
    this.ws?.close()
  }
}
