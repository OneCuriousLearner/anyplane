// 全局收件箱频道（/ws/inbox）与 inbox 事件的真实出口。
// hub 各模块经 hub/broadcast.publishInbox（InboxSink）流出事件；本模块是实现侧，
// 由装配层 initInbox() 一次性接线（显式 init，不依赖 ESM 加载顺序副作用）。

import type { ServerWebSocket } from 'bun'
import { setInboxSink } from '../hub/broadcast'
import { hubs } from '../hub/registry'
import { statusOf } from '../hub/status'
import type { InboxEvent, WSDataInbox } from '../hub/types'
import { fanoutPush } from './fanout'

const inboxClients = new Set<ServerWebSocket<WSDataInbox>>()

export function addInboxClient(ws: ServerWebSocket<WSDataInbox>): void {
  inboxClients.add(ws)
}

export function removeInboxClient(ws: ServerWebSocket<WSDataInbox>): void {
  inboxClients.delete(ws)
}

function publish(ev: InboxEvent): void {
  if (inboxClients.size > 0) {
    const text = JSON.stringify(ev)
    for (const ws of inboxClients) {
      try {
        ws.send(text)
      } catch {}
    }
  }
  fanoutPush(ev)
}

/** 装配层（index.ts）调用一次：把真实实现注册进 hub/broadcast 的 sink */
export function initInbox(): void {
  setInboxSink({ publish })
}

/** inbox 快照：所有 Hub 的待审批与忙闲状态（新连接建立时下发） */
export function inboxSnapshot(): Record<string, unknown> {
  const approvals: unknown[] = []
  const states: Record<string, unknown>[] = []
  for (const hub of hubs.values()) {
    const st = statusOf(hub.key)
    if (st.spawned || st.busy || st.waiting) states.push({ key: hub.key, ...st })
    for (const a of hub.pendingApprovals.values()) {
      approvals.push({ type: 'approval', key: hub.key, ...a })
    }
  }
  return { type: 'snapshot', states, approvals }
}
