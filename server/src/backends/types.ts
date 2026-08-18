// 后端无关的统一抽象：WS/Hub 层只依赖这里的类型。
// 当前实现：claude（stream-json 子进程）；预留：codex（app-server JSON-RPC）。
//
// 关键设计：后端边界上统一使用 Claude stream-json 形状的消息（CliMessage）。
// Codex 后端负责把 ThreadItem/审批/状态事件翻译成该形状，前端与 WS 协议不变。

import type { HistoryMessage } from './claude/discovery'
import type {
  ApprovalDecision,
  BackgroundTask,
  SessionCallbacks,
  SpawnOptions,
} from './claude/processManager'
import type { CliMessage, StdinMessage } from './claude/protocol'

export type BackendName = 'claude' | 'codex'

/**
 * 统一 token 用量（只计 token，不计费用；分后端分桶展示，不跨后端合并）。
 * claude 取自 result.usage；codex 取自 thread/tokenUsage/updated 的累计 total。
 */
export interface TokenUsage {
  inputTokens: number
  outputTokens: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  reasoningTokens?: number
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

/** 统一审批决策：claude allow/deny 与 codex accept/acceptForSession/decline/cancel 的交集 */
export type UnifiedDecision = 'allow' | 'allow_session' | 'deny' | 'cancel'

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

export type {
  ApprovalDecision,
  BackgroundTask,
  CliMessage,
  HistoryMessage,
  SessionCallbacks,
  SpawnOptions,
  StdinMessage,
}
