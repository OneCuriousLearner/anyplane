// 后端无关的共享类型：WS/Hub 层与两个后端（claude stream-json 子进程 / codex app-server
// JSON-RPC）之间的公共词汇。
//
// 关键设计：后端边界上统一使用 Claude stream-json 形状的消息（CliMessage）。
// Codex 后端负责把 ThreadItem/审批/状态事件翻译成该形状，前端与 WS 协议不变。
//
// 依赖方向：本模块不 import 任何具体后端的实现模块。
// 唯一的例外是 './claude/protocol' 的 CliMessage——统一边界格式
// 本身就是 claude stream-json 形状（见上），协议类型以 claude/protocol 为正本。

import type { CliMessage } from './claude/protocol'

export type BackendName = 'claude' | 'codex'

// ---------- 历史消息（供 UI 首次加载；claude 从 transcript 解析，codex 从 turns 翻译） ----------

/** 结构化内容块：前端按块渲染（markdown 文本 / 思考 / 工具调用 / 工具结果 / 图片） */
export interface HistoryBlock {
  kind: 'text' | 'thinking' | 'tool_use' | 'tool_result' | 'image'
  text?: string
  /** tool_use：工具名；tool_result：无 */
  name?: string
  /** tool_use 的 id / tool_result 的 tool_use_id（用于配对） */
  id?: string
  /** tool_use 的参数 */
  input?: unknown
  /** tool_result 是否失败 */
  isError?: boolean
  /** image 块的展示地址（/api/uploads/<hash>.<ext>，hash 命名去重落盘） */
  src?: string
}

export interface HistoryMessage {
  uuid?: string
  role: 'user' | 'assistant' | 'system'
  /** system 消息的子类型（如 compact_boundary） */
  subtype?: string
  blocks: HistoryBlock[]
  /** compact_boundary 的元数据 */
  compactMeta?: { trigger?: string; preTokens?: number; postTokens?: number }
  timestamp?: string
  isMeta?: boolean
  /** 是否可作为 rewind 目标（compact 边界之前的消息在逻辑上已不存在，无法回滚到） */
  rewindable?: boolean
}

/**
 * 一条子代理（Task/Agent 工具）的侧链转录。
 * 新版 CLI 落盘在 <sessionId>/subagents/agent-*.jsonl（元数据在同名 .meta.json），
 * 旧版内联在主 transcript（isSidechain:true + parentToolUseId）——两种来源统一成此形状。
 */
export interface SubagentHistory {
  /** 主抄本中发起该子代理的 Agent/Task tool_use id（与主线工具卡配对、状态判定的键） */
  toolUseId?: string
  agentId?: string
  agentType?: string
  description?: string
  spawnDepth?: number
  messages: HistoryMessage[]
}

/** 会话列表项（聚合 Claude discovery 与 Codex thread/list） */
export interface SessionSummary {
  backend: BackendName
  key: string
  /** sessionId / threadId */
  id: string
  cwd?: string
  slug?: string
  title?: string
  lastPrompt?: string
  mtime: number
  sizeBytes?: number
  status: 'busy' | 'idle' | 'waiting' | 'offline'
  live?: { pid: number; startedAt?: string | number; kind?: string }
}

// ---------- 会话句柄相关 ----------

/** claude headless spawn 参数（codex 用 CodexSpawnOpts，形状近似） */
export interface SpawnOptions {
  cwd: string
  resumeSessionId?: string
  /** 对话回滚：加载到指定消息处截断（配合 resumeSessionId） */
  resumeSessionAt?: string
  /** 分叉：以 --fork-session --resume 启动，携带源会话全部历史、获得新 sessionId。
   *  与 resumeSessionId 互斥（fork 即 resume 的一种形态）。 */
  forkFromSessionId?: string
  /** 会话自定义标题（-n/--name），写入 custom-title，列表页可区分 */
  sessionName?: string
  model?: string
  effort?: string
  permissionMode?: string
}

export type ApprovalDecision =
  | { behavior: 'allow'; updatedInput?: unknown }
  | { behavior: 'deny'; message?: string }

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
  /** 进程退出（仅当前仍登记在管理器中的实例会回调） */
  onExit(code: number): void
  /** busy / sessionState 变化时通知宿主广播 status */
  onStatusChange?(): void
}

// 会话句柄契约（文档性约定，无接口强制）：ClaudeSession 与 CodexSession 结构化同形，
// Hub 层因此不分后端调用。两后端的实际差异（调用方须知）：
// - sendUserText 的 sendMode/images 为可选增强；codex 的 images 元素需要 name 字段。
// - write 接受任意 StdinMessage，但 codex 只响应 update_environment_variables
//   （CLAUDE_CODE_EFFORT_LEVEL → reasoning effort），其余形状按设计忽略。
// - contextUsage（当前上下文窗口占用）两后端同形：
//   { usedTokens, windowSize, outputTokens, inputTokens, cacheReadTokens, cacheWriteTokens,
//     reasoningTokens? }（reasoningTokens 仅 codex 有源）。
//   usedTokens 口径各自对齐官方 statusline：claude = 最近一次调用的 input+cache（不含 output）；
//   codex = tokenUsage.last.totalTokens（最新活跃上下文大小）。windowSize：claude 按模型
//   启发式（[1m]→1M，否则 200k）；codex 用通知里的 modelContextWindow。
//   首个 API 应答/首个 turn 之前为 undefined——前端据此隐藏环形 UI（resume 不补发，实测）。
