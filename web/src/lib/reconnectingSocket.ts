// 自动重连 WebSocket 基类：指数退避（1s 起、15s 封顶）、close 后不再重连、JSON 逐条分发。
// SessionSocket（会话频道）与 InboxSocket（全局收件箱）共用。

import { wsTokenQuery } from './auth'

/** ws(s)://<host><path>?token=...（token 仅在配置 authToken 时附加） */
export function wsUrl(path: string): string {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws'
  return `${proto}://${location.host}${path}${wsTokenQuery()}`
}

export abstract class ReconnectingSocket {
  private ws: WebSocket | undefined
  private retry = 0
  private closed = false
  /** 成功 open 的次数。>1 即重连（相对本条 socket 的首连） */
  private opened = 0

  /** 子类提供连接路径（/ws/...） */
  protected abstract url(): string
  protected abstract onMessage(data: unknown): void
  /** 连接开/关通知（会话页连接指示用；收件箱不实现） */
  protected onOpenChange?(open: boolean): void
  /** open 后钩子（SessionSocket 借此冲刷待发队列） */
  protected onOpen?(): void

  /** 子类构造函数末尾调用：字段就绪后才能读 url()（基类构造期子类字段尚未赋值） */
  protected start(): void {
    this.connect()
  }

  private connect(): void {
    const ws = new WebSocket(this.url())
    this.ws = ws
    ws.onopen = () => {
      this.retry = 0
      this.opened++
      this.onOpenChange?.(true)
      this.onOpen?.()
    }
    ws.onmessage = (e) => {
      let parsed: unknown
      try {
        parsed = JSON.parse(e.data)
      } catch (err) {
        // 曾是静默吞掉：协议漂移或帧截断时页面表现为"消息就是没来"，零日志零提示。
        // 服务端不会发非 JSON，命中即真问题——留一条控制台错误让用户能截图反馈。
        console.error('[ws] 下行非 JSON 帧，已丢弃', { head: String(e.data).slice(0, 120), err })
        return
      }
      this.onMessage(parsed)
    }
    ws.onclose = () => {
      this.onOpenChange?.(false)
      if (this.closed) return
      const delay = Math.min(1000 * 2 ** this.retry++, 15000)
      setTimeout(() => !this.closed && this.connect(), delay)
    }
    ws.onerror = () => ws.close()
  }

  /** 是否已经至少成功连接过一次之后再次 open（用于重连 attach，避免与首连 attach 叠发） */
  protected get isReconnect(): boolean {
    return this.opened > 1
  }

  /** 仅在 open 时发送；未 open 返回 false（调用方决定排队还是丢弃） */
  protected sendRaw(text: string): boolean {
    if (this.ws?.readyState !== WebSocket.OPEN) return false
    this.ws.send(text)
    return true
  }

  close(): void {
    this.closed = true
    this.ws?.close()
  }
}
