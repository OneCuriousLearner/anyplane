// WebSocket 客户端：按 sessionKey 连接，自动重连（重连骨架见 reconnectingSocket.ts）
// ServerEvent / ClientCommand / SessionState / CliMsg 的单一正本在 @anyplane/protocol。

import type { ClientCommand, ServerEvent } from '@anyplane/protocol'
import { ReconnectingSocket, wsUrl } from './reconnectingSocket'

export class SessionSocket extends ReconnectingSocket {
  private queue: ClientCommand[] = []
  /** 已收到的最高 cli 序号（高水位）。重连时随 attach 上报，服务端据此补发断线期间的事件。
   *  跨重连保留——这正是它的意义所在（对齐官方 bridge 的 lastTransportSequenceNum）。 */
  private lastSeq = 0

  constructor(
    public key: string,
    private onEvent: (ev: ServerEvent) => void,
    private openCb?: (open: boolean) => void,
  ) {
    super()
    this.start()
  }

  protected url(): string {
    return wsUrl(`/ws/sessions/${encodeURIComponent(this.key)}`)
  }

  /** 重连 attach 时上报的补发起点；0 表示尚未收过可落盘 cli，服务端按环从头补 */
  get replayFrom(): number {
    return this.lastSeq
  }

  /** 是否为本条 socket 的第二次及以后成功 open */
  get reconnecting(): boolean {
    return this.isReconnect
  }

  protected onMessage(data: unknown): void {
    const ev = data as ServerEvent
    // 序号单调推进：补发内容与实时流可能交错，取 max 而非直接赋值
    if (ev?.kind === 'cli' && typeof ev.seq === 'number' && ev.seq > this.lastSeq) this.lastSeq = ev.seq
    this.onEvent(ev)
  }

  protected onOpenChange(open: boolean): void {
    this.openCb?.(open)
  }

  protected onOpen(): void {
    for (const c of this.queue) this.sendRaw(JSON.stringify(c))
    this.queue = []
  }

  send(cmd: ClientCommand): void {
    if (!this.sendRaw(JSON.stringify(cmd))) this.queue.push(cmd)
  }
}
