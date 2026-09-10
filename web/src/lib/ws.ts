// WebSocket 客户端：按 sessionKey 连接，自动重连（重连骨架见 reconnectingSocket.ts）

import { ReconnectingSocket, wsUrl } from './reconnectingSocket'
import type { HistoryMessage } from './api'

export type ServerEvent =
  /** seq：服务端为可落盘 cli 分配的单调序号（stream_event 不占号，见 SessionSocket） */
  | { kind: 'cli'; msg: CliMsg; seq?: number; replay?: boolean }
  | { kind: 'status'; state: SessionState }
  | { kind: 'approval_request'; requestId: string; toolName: string; input: unknown }
  | { kind: 'approval_resolved'; requestId: string }
  /** 审批规则引擎自动裁决的留痕事件（服务端已直接回复 CLI，此处只做 UI 审计卡）；
   *  detail 是服务端 summarizeInput 唯一口径算好的摘要，前端直接渲染不再自行提取字段 */
  | { kind: 'approval_auto'; requestId: string; toolName: string; input: unknown; detail: string; action: 'allow' | 'deny'; rule: string }
  | { kind: 'btw_pending'; question: string }
  | { kind: 'btw_delta'; question: string; delta: string; thinking?: boolean }
  | { kind: 'btw_result'; ok: boolean; question: string; text: string }
  | { kind: 'rewound'; userMessageId: string; scope?: 'conversation' | 'both' }
  /** codex paginated 线程原地回滚完成（thread/revert）：所选消息及其后内容已从持久历史移除，
   *  会话 key 不变；前端就地截断视图。另有 cli 系统消息 thread_reverted（含外部客户端发起的
   *  revert、重连补发）驱动权威历史重载 */
  | { kind: 'reverted'; userMessageId: string }
  /** codex 分叉回滚完成：原线程不动，新线程已生成；claude 懒分叉：branchOf 为源 sessionId，name 为可选分支名 */
  | { kind: 'forked'; targetKey: string; targetSessionId?: string; fromTurnId?: string; branchOf?: string; name?: string }
  /** 接力进度：源会话 fork 摘要中 */
  | { kind: 'handoff_pending'; toBackend: 'claude' | 'codex' }
  | { kind: 'handoff_brief'; brief: string }
  | { kind: 'handoff_done'; targetKey: string; targetSessionId?: string; targetSlug?: string; targetCwd?: string; toBackend: 'claude' | 'codex'; brief: string }
  | { kind: 'handoff_error'; message: string }
  /** 只读控制查询应答（mcp_status / get_settings / get_context_usage） */
  | { kind: 'query_result'; id: string; ok: boolean; data?: unknown; error?: string }
  /** 外部会话 transcript 追加的完整消息（块级实时，非 token 流） */
  | { kind: 'tail'; msg: HistoryMessage }
  /** 外部会话 transcript 被截断/重建（rewind、clear），客户端应重载历史并重新订阅 */
  | { kind: 'tail_reset' }
  /** 重连补发有缺口：断线太久，服务端环形缓冲已挤掉起点，客户端需重载历史补全 */
  | { kind: 'replay_gap'; fromSeq: number }
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
  /** 当前上下文窗口占用（两后端同形；首个 API 应答/首个 turn 之前缺省——环形 UI 据此隐藏）。
   *  usedTokens 口径对齐各家官方 statusline：claude=input+cache（不含 output）；
   *  codex=tokenUsage.last.totalTokens（最新活跃上下文大小）。 */
  context?: {
    usedTokens: number
    windowSize: number
    outputTokens: number
    inputTokens?: number
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
    /** task_started 的 spawn_depth（1 = 主线扇出）；嵌套 agent >1 */
    depth?: number
    /** 父任务的 toolUseId（嵌套 agent 时） */
    parentToolUseId?: string
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
  /** codex 线程的历史契约（legacy | paginated）：回滚面板据此切换分叉/原地回滚文案 */
  historyMode?: string
  exited?: boolean
  exitCode?: number
}

export type ClientCommand =
  /** fromSeq：断线前收到的最高 cli 序号，服务端据此补发这期间错过的事件 */
  | { kind: 'attach'; warm?: boolean; opts?: Record<string, unknown>; fromSeq?: number }
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
  | { kind: 'branch'; name?: string }
  | { kind: 'query'; id: string; query: string; extra?: Record<string, unknown> }

export class SessionSocket extends ReconnectingSocket {
  private queue: ClientCommand[] = []
  /** 已收到的最高 cli 序号（高水位）。重连时随 attach 上报，服务端据此补发断线期间的事件。
   *  跨重连保留——这正是它的意义所在（对齐官方 bridge 的 lastTransportSequenceNum）。 */
  private lastSeq = 0

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

  /** 重连 attach 时上报的补发起点；0 表示尚未收过可落盘 cli，服务端按环从头补 */
  get replayFrom(): number {
    return this.lastSeq
  }

  /** 是否为本条 socket 的第二次及以后成功 open */
  get reconnecting(): boolean {
    return this.isReconnect
  }

  protected onMessage(data: unknown): void {
    const ev = data as ServerEvent
    // 序号单调推进：补发内容与实时流可能交错，取 max 而非直接赋值
    if (ev?.kind === 'cli' && typeof ev.seq === 'number' && ev.seq > this.lastSeq) this.lastSeq = ev.seq
    this.onEvent(ev)
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
