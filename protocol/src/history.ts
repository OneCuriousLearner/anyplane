// 历史消息契约：供 UI 首次加载与翻页（claude 从 transcript 解析，codex 从 turns 翻译）。

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
 * （claude 侧概念；codex 无此对应物）
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

/** GET /api/history/:slug/:sessionId 与 /api/codex/history/:threadId 的响应 */
export interface HistoryResponse {
  messages: HistoryMessage[]
  /** 服务端本次实际读取的 transcript 字节数，作为 tail_subscribe 的起始偏移（codex 恒 0，无 tailer） */
  fileBytes: number
  /** 子代理侧链转录（历史回放用；实时更新走 WS 的 parent_tool_use_id 消息）。
   *  仅首页下发——翻页请求不含此字段 */
  subagents?: SubagentHistory[]
  /** claude 历史分页：窗口之前还有更早消息（codex 历史恒全量，无此字段语义） */
  hasMore?: boolean
  /** 下一页的 before 游标（transcript 行号），hasMore 时必带 */
  nextBefore?: number
}
