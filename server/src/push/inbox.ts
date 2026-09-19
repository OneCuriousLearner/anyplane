// 全局收件箱频道（/ws/inbox）与 inbox 事件的真实出口。
// hub 各模块经 InboxSink 流出事件、经 InboxChannel 登记 /ws/inbox 客户端；
// 本模块是实现侧，装配层 initInbox() 一次性接线（不依赖 ESM 加载顺序副作用）。

import type { InboxEvent } from '@anyplane/protocol'
import type { ServerWebSocket } from 'bun'
import { setInboxChannel, setInboxSink } from '../hub/broadcast'
import { hubs } from '../hub/registry'
import { statusOf } from '../hub/status'
import type { WSDataInbox } from '../hub/types'
import { summarizeInput } from '../util'
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

/** 装配层（index.ts）调用一次：inbox 事件 sink + /ws/inbox 客户端通道一并注入 */
export function initInbox(): void {
  setInboxSink({ publish })
  setInboxChannel({ add: addInboxClient, remove: removeInboxClient, snapshot: inboxSnapshot })
}

/** inbox 快照：所有 Hub 的待审批与忙闲状态（新连接建立时下发） */
export function inboxSnapshot(): Extract<InboxEvent, { type: 'snapshot' }> {
  const approvals: Array<Extract<InboxEvent, { type: 'approval' }>> = []
  const states: Array<Extract<InboxEvent, { type: 'snapshot' }>['states'][number]> = []
  for (const hub of hubs.values()) {
    const st = statusOf(hub.key)
    if (st.spawned || st.busy || st.waiting) states.push({ key: hub.key, ...st })
    for (const a of hub.pendingApprovals.values()) {
      approvals.push({ type: 'approval', key: hub.key, ...a, detail: summarizeInput(a.toolName, a.input) })
    }
  }
  return { type: 'snapshot', states, approvals }
}
