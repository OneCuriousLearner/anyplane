// 前后端共享的基元类型：后端标识与审批裁决。

/** 会话后端：claude（stream-json 子进程）| codex（app-server） */
export type BackendName = 'claude' | 'codex'

/** 审批裁决：allow 可改写参数（updatedInput），deny 可附原因。
 *  rememberTool：「本会话允许这个工具」——只记在当前 Hub 内存（WS 通道专用，
 * 绝不进推送能力 URL/REST 核），命中后走 approval_auto 同形留痕；/clear 重键即失效 */
export type ApprovalDecision =
  | { behavior: 'allow'; updatedInput?: unknown; rememberTool?: boolean }
  | { behavior: 'deny'; message?: string }
