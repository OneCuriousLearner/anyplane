// WebSocket 客户端：按 sessionKey 连接，自动重连

import { wsTokenQuery } from './auth'
import type { HistoryMessage } from './api'

export type ServerEvent =
  | { kind: 'cli'; msg: CliMsg }
  | { kind: 'status'; state: SessionState }
  | { kind: 'approval_request'; requestId: string; toolName: string; input: unknown }
  | { kind: 'approval_resolved'; requestId: string }
  | { kind: 'btw_pending'; question: string }
  | { kind: 'btw_delta'; question: string; delta: string; thinking?: boolean }
  | { kind: 'btw_result'; ok: boolean; question: string; text: string }
  | { kind: 'rewound'; userMessageId: string; scope?: 'conversation' | 'both' }
  /** 接力进度：源会话 fork 摘要中 */
  | { kind: 'handoff_pending'; toBackend: 'claude' | 'codex' }
  | { kind: 'handoff_brief'; brief: string }
  | { kind: 'handoff_done'; targetKey: string; targetSessionId?: string; toBackend: 'claude' | 'codex'; brief: string }
  | { kind: 'handoff_error'; message: string }
  /** 外部会话 transcript 追加的完整消息（块级实时，非 token 流） */
  | { kind: 'tail'; msg: HistoryMessage }
  /** 外部会话 transcript 被截断/重建（rewind、clear），客户端应重载历史并重新订阅 */
  | { kind: 'tail_reset' }
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
  /** 累计 token 用量（只计 token；claude 为本进程累计，codex 为线程累计） */
  usage?: {
    inputTokens: number
    outputTokens: number
    cacheReadTokens?: number
    cacheWriteTokens?: number
    reasoningTokens?: number
  }
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
  /** 服务端正在 tail 外部会话的 transcript（实时跟踪中） */
  tailing?: boolean
  /** 外部会话 pid 文件的状态（busy/idle/waiting） */
  liveStatus?: string
  exited?: boolean
  exitCode?: number
}

export type ClientCommand =
  | { kind: 'attach'; warm?: boolean; opts?: Record<string, unknown> }
  | { kind: 'tail_subscribe'; from?: number }
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
    const ws = new WebSocket(
      `${proto}://${location.host}/ws/sessions/${encodeURIComponent(this.key)}${wsTokenQuery()}`,
    )
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
