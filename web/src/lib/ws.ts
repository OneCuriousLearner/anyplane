// WebSocket 客户端：按 sessionKey 连接，自动重连（重连骨架见 reconnectingSocket.ts）

import { ReconnectingSocket, wsUrl } from './reconnectingSocket'
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
  /** codex 分叉回滚完成：原线程不动，新线程已生成；claude 懒分叉：branchOf 为源 sessionId，name 为可选分支名 */
  | { kind: 'forked'; targetKey: string; targetSessionId?: string; fromTurnId?: string; branchOf?: string; name?: string }
  /** 接力进度：源会话 fork 摘要中 */
  | { kind: 'handoff_pending'; toBackend: 'claude' | 'codex' }
  | { kind: 'handoff_brief'; brief: string }
  | { kind: 'handoff_done'; targetKey: string; targetSessionId?: string; toBackend: 'claude' | 'codex'; brief: string }
  | { kind: 'handoff_error'; message: string }
  /** 只读控制查询应答（mcp_status / get_settings / get_context_usage） */
  | { kind: 'query_result'; id: string; ok: boolean; data?: unknown; error?: string }
  /** 外部会话 transcript 追加的完整消息（块级实时，非 token 流） */
  | { kind: 'tail'; msg: HistoryMessage }
  /** 外部会话 transcript 被截断/重建（rewind、clear），客户端应重载历史并重新订阅 */
  | { kind: 'tail_reset' }
  /** /clear 等触发的对话重置：进程以新 sessionId 续跑，Hub 已重键——前端应导航到新会话页 */
  | { kind: 'moved'; targetKey: string; targetSessionId?: string; reason?: string }
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
  /** initialize 握手返回的 slash 命令（含描述） */
  slashCommands?: Array<{ name: string; description?: string }>
  /** 服务端正在 tail 外部会话的 transcript（实时跟踪中） */
  tailing?: boolean
  /** 外部会话 pid 文件的状态（busy/idle/waiting） */
  liveStatus?: string
  /** 当前目标（claude /goal 跟踪 / codex thread/goal 通知） */
  goal?: { condition: string; since: number; tokensUsed?: number; timeUsedSeconds?: number } | null
  exited?: boolean
  exitCode?: number
}

export type ClientCommand =
  | { kind: 'attach'; warm?: boolean; opts?: Record<string, unknown> }
  | { kind: 'tail_subscribe'; from?: number }
  | {
      kind: 'user'
      text: string
      sendMode?: 'steer' | 'queue'
      attachments?: Array<{ name: string; mediaType: string; dataBase64: string }>
    }
  | { kind: 'control'; subtype: string; extra?: Record<string, unknown> }
  | { kind: 'update_env'; variables: Record<string, string> }
  | { kind: 'approval'; requestId: string; decision: unknown }
  | { kind: 'rewind_conversation'; userMessageId: string }
  | { kind: 'rewind_both'; userMessageId: string }
  | { kind: 'btw'; question: string }
  | { kind: 'branch' }
  | { kind: 'query'; id: string; query: string }

export class SessionSocket extends ReconnectingSocket {
  private queue: ClientCommand[] = []

  constructor(
    public key: string,
    private onEvent: (ev: ServerEvent) => void,
    private openCb?: (open: boolean) => void,
  ) {
    super()
    this.start()
  }

  protected url(): string {
    return wsUrl(`/ws/sessions/${encodeURIComponent(this.key)}`)
  }

  protected onMessage(data: unknown): void {
    this.onEvent(data as ServerEvent)
  }

  protected onOpenChange(open: boolean): void {
    this.openCb?.(open)
  }

  protected onOpen(): void {
    for (const c of this.queue) this.sendRaw(JSON.stringify(c))
    this.queue = []
  }

  send(cmd: ClientCommand): void {
    if (!this.sendRaw(JSON.stringify(cmd))) this.queue.push(cmd)
  }
}
