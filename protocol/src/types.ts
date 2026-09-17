// 前后端共享的基元类型：后端标识与审批裁决。

/** 会话后端：claude（stream-json 子进程）| codex（app-server） */
export type BackendName = 'claude' | 'codex'

/** 审批裁决：allow 可改写参数（updatedInput），deny 可附原因 */
export type ApprovalDecision =
  | { behavior: 'allow'; updatedInput?: unknown }
  | { behavior: 'deny'; message?: string }
