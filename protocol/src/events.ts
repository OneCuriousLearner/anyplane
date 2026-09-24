// WS 数据面契约：/ws/sessions/:key 的下行事件（ServerEvent）与上行命令（ClientCommand）。
// 服务端唯一出口是 hub/broadcast.ts 的 broadcast()（判别联合卡口）；
// 前端唯一入口是 lib/ws.ts 的 SessionSocket。

import type { HistoryMessage } from './history'
import type { BackendName } from './types'
import type { SessionState } from './state'

/** cli 事件的负载：Claude stream-json 形状的 wire 消息（Codex 事件已翻译为该形状）。
 *  宽松解析原则：只声明消费方关心的字段，其余经索引签名原样透传。
 *  注意这是「中立边界上的 wire 形状」，vendor 侧更丰富的解析类型在各后端内部
 * （claude/streamJson.ts 的 CliMessage），本类型不反向依赖 vendor 模块。 */
export interface CliMsg {
  type: string
  subtype?: string
  session_id?: string
  uuid?: string
  message?: unknown
  [k: string]: unknown
}

/** 只读控制查询（mcp_status / get_settings / get_context_usage）的应答负载 */
export interface QueryResultPayload {
  ok: boolean
  data?: unknown
  error?: string
}

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
  | { kind: 'handoff_pending'; toBackend: BackendName }
  | { kind: 'handoff_brief'; brief: string }
  | { kind: 'handoff_done'; targetKey: string; targetSessionId?: string; targetSlug?: string; targetCwd?: string; toBackend: BackendName; brief: string }
  | { kind: 'handoff_error'; message: string }
  /** 只读控制查询应答（mcp_status / get_settings / get_context_usage） */
  | { kind: 'query_result'; id: string } & QueryResultPayload
  /** 外部会话 transcript 追加的完整消息（块级实时，非 token 流） */
  | { kind: 'tail'; msg: HistoryMessage }
  /** 外部会话 transcript 被截断/重建（rewind、clear），客户端应重载历史并重新订阅 */
  | { kind: 'tail_reset' }
  /** 重连补发有缺口：断线太久，服务端环形缓冲已挤掉起点，客户端需重载历史补全 */
  | { kind: 'replay_gap'; fromSeq: number }
  /** 会话 key 迁移：/clear 对话重置（reason='clear'）或懒启动/懒分叉拿到真实 id 升键
   * （reason='spawned'，n|→s|、xn|→x|、b|→s|）。Hub 已重键——前端应导航到新会话页 */
  | { kind: 'moved'; targetKey: string; targetSessionId?: string; reason?: string }
  | { kind: 'error'; message: string }

/** 浏览器上传的图片附件（base64）；claude 并 content blocks，codex 落盘走 localImage */
export interface ImageAttachment {
  name: string
  mediaType: string
  dataBase64: string
}

export type ClientCommand =
  /** fromSeq：断线前收到的最高 cli 序号，服务端据此补发这期间错过的事件 */
  | { kind: 'attach'; warm?: boolean; opts?: Record<string, unknown>; fromSeq?: number }
  /** 客户端加载完历史后订阅 transcript 追加（from = 历史读取时的文件字节数，无缝衔接） */
  | { kind: 'tail_subscribe'; from?: number }
  | {
      kind: 'user'
      text: string
      /** sendMode 直通：claude 侧 steer=priority 'now'（中断处理）、queue=服务端排队 */
      sendMode?: 'steer' | 'queue'
      attachments?: ImageAttachment[]
    }
  | { kind: 'control'; subtype: string; extra?: Record<string, unknown> }
  | { kind: 'update_env'; variables: Record<string, string> }
  | { kind: 'approval'; requestId: string; decision: unknown }
  | { kind: 'rewind_conversation'; userMessageId: string }
  | { kind: 'rewind_both'; userMessageId: string }
  /** 侧问：借用当前会话上下文的一次性问答，不进主会话历史 */
  | { kind: 'btw'; question: string }
  | { kind: 'branch'; name?: string }
  /** 带应答的控制请求通道：只读查询与 MCP 管理动作（mcp_reconnect / mcp_toggle，经 extra 传参）共用 */
  | { kind: 'query'; id: string; query: string; extra?: Record<string, unknown> }
