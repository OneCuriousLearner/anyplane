// 全局收件箱 WS 客户端：跨会话审批/完成/错误汇总（/ws/inbox）

import { wsTokenQuery } from './auth'

export type InboxApproval = { key: string; requestId: string; toolName: string; input: unknown }

export type InboxEvent =
  | { type: 'snapshot'; states: Array<Record<string, unknown>>; approvals: InboxApproval[] }
  | ({ type: 'approval' } & InboxApproval)
  | { type: 'approval_resolved'; key: string; requestId: string }
  | { type: 'done'; key: string; ok: boolean }
  | { type: 'error'; key: string; message: string }

export class InboxSocket {
  private ws: WebSocket | undefined
  private retry = 0
  private closed = false

  constructor(private onEvent: (ev: InboxEvent) => void) {
    this.connect()
  }

  private connect(): void {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws'
    const ws = new WebSocket(`${proto}://${location.host}/ws/inbox${wsTokenQuery()}`)
    this.ws = ws
    ws.onopen = () => {
      this.retry = 0
    }
    ws.onmessage = (e) => {
      try {
        this.onEvent(JSON.parse(e.data))
      } catch {}
    }
    ws.onclose = () => {
      if (this.closed) return
      const delay = Math.min(1000 * 2 ** this.retry++, 15000)
      setTimeout(() => !this.closed && this.connect(), delay)
    }
    ws.onerror = () => ws.close()
  }

  close(): void {
    this.closed = true
    this.ws?.close()
  }
}
