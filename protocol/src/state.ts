// 会话状态契约：WS status 事件负载、/api/sessions 的 managed 字段、inbox snapshot 的 states 共用。
// 服务端唯一出口是 statusOf()（hub/status.ts 经 portFor 分发，公共字段 baseStatusOf）。

/** 后端能力声明（BackendPort.capabilities 的下发镜像）。
 *  能力差异的唯一权威在服务端适配器；前端按本字段渲染（禁用按钮/隐藏面板），
 *  不再以 isCodex 硬编码推断——第三个后端接入时前端零改动。 */
export interface BackendCapabilities {
  /** 文件检查点：rewind_files / rewind_both（组合回滚） */
  fileCheckpoint: boolean
  /** 懒分叉当前会话（/branch，b| key） */
  branch: boolean
  /** transcript tailer：外部会话实时跟踪（tail_subscribe） */
  tailer: boolean
  /** 官方 AI 标题（generate_session_title 控制通道） */
  aiTitle: boolean
  /** 外部门禁通知（control.sock 生态） */
  externalGate: boolean
  /** query 通道支持的查询/动作名白名单（hub 层据此把关，适配器不再各自拒绝） */
  queries: readonly string[]
  /** 模型目录端点（codex model/list RPC；claude 无对应物） */
  modelCatalog: boolean
}

/** 累计 token 用量（只计 token；claude 为本进程累计，codex 为线程累计） */
export interface TokenUsage {
  inputTokens: number
  outputTokens: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  reasoningTokens?: number
}

/** 当前上下文窗口占用（两后端同形；首个 API 应答/首个 turn 之前缺省——前端据此隐藏环形 UI）。
 *  usedTokens 口径对齐各家官方 statusline：claude=input+cache（不含 output）；
 *  codex=tokenUsage.last.totalTokens（最新活跃上下文大小）。 */
export interface ContextUsageInfo {
  usedTokens: number
  windowSize: number
  outputTokens: number
  inputTokens?: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  /** 仅 codex 有源 */
  reasoningTokens?: number
}

/** Claude Code SDK system/task_started 暴露的后台任务最小状态。 */
export interface BackgroundTask {
  id: string
  description: string
  taskType?: string
  toolUseId?: string
  startedAt: number
  lastToolName?: string
  summary?: string
  /** task_started 的 spawn_depth（1 = 主线扇出）；嵌套 agent >1 */
  depth?: number
  /** 父任务的 toolUseId（嵌套 agent 时）；血缘推导见 processManager 的 toolUseParents */
  parentToolUseId?: string
}

export interface SessionState {
  spawned: boolean
  busy: boolean
  /** 本后端的能力声明（statusOf 统一注入；首包前的客户端缺省时按后端身份兜底） */
  capabilities?: BackendCapabilities
  /** 等待用户审批（can_use_tool / requires_action） */
  waiting?: boolean
  /** Claude Code 权威状态：idle | running | requires_action */
  sessionState?: 'idle' | 'running' | 'requires_action'
  sessionId?: string
  clients?: number
  usage?: TokenUsage
  context?: ContextUsageInfo
  /** Claude Code system/task_started 与 task_notification 之间的后台任务数。
   *  codex 不下发本字段（恒空数组会被 hydrateTasks 误读为权威空） */
  activeTaskCount?: number
  /** 运行中任务的最小信息；不含 prompt、输出等敏感/冗长内容。codex 同样不下发 */
  activeTasks?: BackgroundTask[]
  /** 未启动时为待应用启动参数；已启动时为当前选择（initModel / 离线反查兜底，见 claude 适配器注释） */
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
  /** 组合回滚/原地回滚进行中（服务端 hub.rewindPending 镜像；当前前端未消费，
   *  预留给"回滚进行中禁用操作"的 UI） */
  rewindPending?: boolean
  exited?: boolean
  exitCode?: number
}
