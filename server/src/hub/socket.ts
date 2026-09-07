// Bun.serve 的 websocket handlers：连接生命周期 + 下行保活 + 上行分发。

import type { ServerWebSocket } from 'bun'
import { portFor } from '../backends/port'
import { log } from '../log'
import { addInboxClient, inboxSnapshot, removeInboxClient } from '../push/inbox'
import { errorMessage } from '../util'
import { replayApprovals } from './broadcast'
import { handleClientMessage } from './messages'
import { getHub, hubs } from './registry'
import { statusOf } from './status'
import type { WSData, WSDataInbox } from './types'

// 30s 协议层下行 ping：前端 ReconnectingSocket 没有应用层心跳，空闲会话的 /ws 长连接
// 可能数分钟无任何消息——Bun.serve 默认 idleTimeout=120s 会把它静默掐断（前端重连虽无感，
// 但审批/事件推送会落在重连窗口里）；经 gateway 访问时也能为后端腿持续制造下行流量。
export function wsOpen(ws: ServerWebSocket<WSData>): void {
  ws.data.keepalive = setInterval(() => {
    try {
      ws.ping()
    } catch {}
  }, 30_000)
  if (ws.data.inbox) {
    addInboxClient(ws as ServerWebSocket<WSDataInbox>)
    ws.send(JSON.stringify(inboxSnapshot()))
    return
  }
  const hub = getHub(ws.data.key)
  hub.clients.add(ws)
  portFor(ws.data.key).sessionOf(ws.data.key)?.attachClient()
  ws.send(JSON.stringify({ kind: 'status', state: statusOf(ws.data.key, undefined, true) }))
  replayApprovals(hub, (p) => ws.send(JSON.stringify(p)))
}

export function wsMessage(ws: ServerWebSocket<WSData>, raw: string | Buffer): void {
  if (ws.data.inbox) return // inbox 频道只发不收
  const hub = getHub(ws.data.key)
  try {
    handleClientMessage(hub, typeof raw === 'string' ? raw : raw.toString(), ws)
  } catch (e) {
    log.error(`[ws ${hub.key}] 处理消息异常:`, e) // 原对象打日志保留堆栈
    try {
      ws.send(JSON.stringify({ kind: 'error', message: errorMessage(e) }))
    } catch {}
  }
}

export function wsClose(ws: ServerWebSocket<WSData>): void {
  if (ws.data.keepalive) clearInterval(ws.data.keepalive)
  if (ws.data.inbox) {
    removeInboxClient(ws as ServerWebSocket<WSDataInbox>)
    return
  }
  let hub = hubs.get(ws.data.key)
  if (!hub) {
    // 会话可能因 /clear 重键（hub.key 已换成新 s| key）：按客户端成员资格找回
    for (const h of hubs.values()) {
      if (h.clients.has(ws)) {
        hub = h
        break
      }
    }
  }
  if (!hub) return
  hub.clients.delete(ws)
  // 不变量：任何后端的会话句柄存活期间，其 Hub 必须存活——
  // 否则重连时复用旧会话，其回调会把事件广播进已删除的 Hub（消息黑洞）。
  // 用 hub.key 而非 ws.data.key：重键后进程注册在新 key 下
  const port = portFor(hub.key)
  port.sessionOf(hub.key)?.detachClient()
  const alive = port.hasLiveSession(hub.key)
  if (hub.clients.size === 0) {
    port.stopTailer(hub)
    if (!alive) hubs.delete(hub.key)
  }
}
