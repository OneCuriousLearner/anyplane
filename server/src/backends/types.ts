// 后端无关的共享类型：WS/Hub 层与两个后端（claude stream-json 子进程 / codex app-server
// JSON-RPC）之间的公共词汇。
//
// 关键设计：后端边界上统一使用 Claude stream-json 形状的消息（CliMessage）。
// Codex 后端负责把 ThreadItem/审批/状态事件翻译成该形状，前端与 WS 协议不变。
//
// 依赖方向：本模块不 import 任何具体后端的实现模块。
// 唯一的例外是 './claude/protocol' 的 CliMessage——统一边界格式
// 本身就是 claude stream-json 形状（见上），协议类型以 claude/protocol 为正本。
//
// 前后端共享的契约类型（HistoryBlock/HistoryMessage/SubagentHistory/ApprovalDecision/
// ContextUsageInfo/BackgroundTask/BackendName）已全部收敛进 @anyplane/protocol（方向十三 13.1），
// 本模块只剩服务端内部类型（SpawnOptions / SessionCallbacks / SessionSummary）——
// 新增前后端共享类型一律去 protocol 包，不要写在这里。

import type { BackendName, SessionStatus } from '@anyplane/protocol'
import type { CliMessage } from './claude/protocol'

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
  status: SessionStatus
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
  /** 审批被上游终结（如 codex serverRequest/resolved：app-server 超时/中断/他端应答）——
   *  宿主据此清掉自己维护的 pending 表；claude 无此路径 */
  onApprovalResolved?(requestId: string): void
  /** busy / sessionState 变化时通知宿主广播 status */
  onStatusChange?(): void
}

// 会话句柄契约（文档性约定，无接口强制）：ClaudeSession 与 CodexSession 结构化同形，
// Hub 层因此不分后端调用。两后端的实际差异（调用方须知）：
// - sendUserText 的 sendMode/images 为可选增强；codex 的 images 元素需要 name 字段。
// - write 接受任意 StdinMessage，但 codex 只响应 update_environment_variables
//   （CLAUDE_CODE_EFFORT_LEVEL → reasoning effort），其余形状按设计忽略。
// - contextUsage（当前上下文窗口占用）两后端同形（@anyplane/protocol 的 ContextUsageInfo）：
//   usedTokens 口径各自对齐官方 statusline：claude = 最近一次调用的 input+cache（不含 output）；
//   codex = tokenUsage.last.totalTokens（最新活跃上下文大小）。windowSize：claude 按模型
//   启发式（[1m]→1M，否则 200k）；codex 用通知里的 modelContextWindow。
//   首个 API 应答/首个 turn 之前为 undefined——前端据此隐藏环形 UI（resume 不补发，实测）。
