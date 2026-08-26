// 全局收件箱 WS 客户端：跨会话审批/完成/错误汇总（/ws/inbox）

import { ReconnectingSocket, wsUrl } from './reconnectingSocket'

export type InboxApproval = { key: string; requestId: string; toolName: string; input: unknown }

export type InboxEvent =
  | { type: 'snapshot'; states: Array<Record<string, unknown>>; approvals: InboxApproval[] }
  | ({ type: 'approval' } & InboxApproval)
  | { type: 'approval_resolved'; key: string; requestId: string }
  | { type: 'done'; key: string; ok: boolean }
  | { type: 'error'; key: string; message: string }

export class InboxSocket extends ReconnectingSocket {
  constructor(private onEvent: (ev: InboxEvent) => void) {
    super()
    this.start()
  }

  protected url(): string {
    return wsUrl('/ws/inbox')
  }

  protected onMessage(data: unknown): void {
    this.onEvent(data as InboxEvent)
  }
}
