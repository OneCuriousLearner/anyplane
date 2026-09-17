// 全局收件箱频道（/ws/inbox）契约：跨会话审批/完成/错误汇总。
// 服务端出口：push/inbox.ts 的 publish()（hub 侧经 InboxSink 流入）与 inboxSnapshot()。

import type { SessionState } from './state'

export interface InboxApproval {
  key: string
  requestId: string
  toolName: string
  input: unknown
}

/** 快照里每个活跃会话的状态行：statusOf 全集 + 会话 key */
export type InboxSnapshotState = SessionState & { key: string }

export type InboxEvent =
  /** 新连接建立时下发：所有 Hub 的待审批与忙闲状态 */
  | { type: 'snapshot'; states: InboxSnapshotState[]; approvals: InboxApproval[] }
  | { type: 'approval' } & InboxApproval
  | { type: 'approval_resolved'; key: string; requestId: string }
  | { type: 'done'; key: string; ok: boolean }
  | { type: 'error'; key: string; message: string }
