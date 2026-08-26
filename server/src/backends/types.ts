// 后端无关的统一抽象：WS/Hub 层只依赖这里的类型。
// 当前实现：claude（stream-json 子进程）与 codex（app-server JSON-RPC）。
//
// 关键设计：后端边界上统一使用 Claude stream-json 形状的消息（CliMessage）。
// Codex 后端负责把 ThreadItem/审批/状态事件翻译成该形状，前端与 WS 协议不变。
//
// 依赖方向：本模块不 import 任何具体后端的实现模块。
// 唯一的例外是 './claude/protocol' 的 CliMessage/StdinMessage——统一边界格式
// 本身就是 claude stream-json 形状（见上），协议类型以 claude/protocol 为正本。

import type { CliMessage, StdinMessage } from './claude/protocol'

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

export interface HistoryPage {
  messages: HistoryMessage[]
  /** claude: transcript 字节偏移（tail 起点）；codex: turns 分页 cursor */
  cursor?: number | string
}

// ---------- 会话句柄（AgentSession）相关 ----------

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

/**
 * WS/Hub 层对会话句柄的全部需求。ClaudeSession 结构化满足本接口；
 * Codex 后端以 app-server 连接实现同形接口（部分方法翻译或无操作）。
 */
export interface AgentSession {
  readonly key: string
  sessionId: string | undefined
  readonly exited: boolean
  readonly busy: boolean
  readonly waiting: boolean
  readonly sessionState: 'idle' | 'running' | 'requires_action'
  readonly connectedClients: number
  readonly activeTaskCount: number
  readonly backgroundTasks: BackgroundTask[]
  syncClients(count: number): void
  attachClient(): void
  detachClient(): void
  notifyExternalGate(): void
  sendUserText(text: string): void
  sendControl(subtype: string, extra?: Record<string, unknown>): string
  sendControlAndWait(
    subtype: string,
    extra?: Record<string, unknown>,
    timeoutMs?: number,
  ): Promise<unknown>
  sendApproval(requestId: string, decision: ApprovalDecision): void
  write(msg: StdinMessage): void
  dispose(): void
}

/** 后端门面：WS/Hub 层经由注册表按 key 分发到具体后端 */
export interface AgentBackend {
  name: BackendName
  /** 已存在会话 key（claude: s|slug|sid；codex: x|threadId） */
  keyFor(...args: string[]): string
  /** 新会话 key（claude: n|cwd；codex: xn|cwd） */
  keyForNew(cwd: string): string
  parseKey(key: string): { cwd: string; resumeSessionId?: string; slug?: string } | null
  listSessions(): SessionSummary[] | Promise<SessionSummary[]>
  readHistory(slug: string, sessionId: string): HistoryPage | Promise<HistoryPage>
  ensure(key: string, opts: SpawnOptions, cb: SessionCallbacks): AgentSession
  get(key: string): AgentSession | undefined
  dispose(key: string): void
  disposeAll(): void
}

export type { CliMessage, StdinMessage }
