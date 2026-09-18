// 全局收件箱单例订阅总线：SessionList 与原生桥共用一条 /ws/inbox 连接。
// 此前 iOS 兜底路径在 SessionList 已持有一条的情况下另开第二条 InboxSocket——
// 双连接双扇出，且兜底那条引用被丢弃不可回收（simplify 评审 Reuse/Efficiency 双视角同指）。

import type { InboxEvent } from '@anyplane/protocol'
import { InboxSocket } from './inbox'

type Listener = (ev: InboxEvent) => void

const listeners = new Set<Listener>()
let socket: InboxSocket | undefined

/** 首个订阅者建立连接；事件扇出给全部订阅者。返回退订函数（连接本身常驻，不随退订关闭） */
export function inboxSubscribe(l: Listener): () => void {
  listeners.add(l)
  if (!socket) {
    socket = new InboxSocket((ev) => {
      for (const fn of listeners) fn(ev)
    })
  }
  return () => {
    listeners.delete(l)
  }
}
