// 全局收件箱 WS 客户端：跨会话审批/完成/错误汇总（/ws/inbox）
// InboxEvent / InboxApproval 的单一正本在 @anyplane/protocol。

import type { InboxEvent } from '@anyplane/protocol'
import { ReconnectingSocket, wsUrl } from './reconnectingSocket'

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
