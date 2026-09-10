// Hub 级广播与 inbox 事件出口。
// 依赖红线：hub/* 绝不 import push/*（循环）——inbox 事件经 InboxSink 注册器流出，
// 真实实现（/ws/inbox 扇出 + Web Push 分发）在 push/inbox.ts，由装配层 initInbox() 一次性接线。

import { pushCliRing } from '../cliReplay'
import { errFields, log } from '../log'
import type { Hub, InboxEvent } from './types'

/** inbox 事件的真实出口（push/inbox.ts 注册）：/ws/inbox 扇出 + Web Push 分发 */
export interface InboxSink {
  publish(ev: InboxEvent): void
}

let inboxSink: InboxSink | undefined
let sinkWarned = false

/** 装配层（index.ts 经 push/inbox.initInbox）一次性注册；不依赖 ESM import 顺序副作用 */
export function setInboxSink(s: InboxSink): void {
  inboxSink = s
}

/** hub 各模块的 inbox 事件统一出口。sink 缺失是装配错误：warn 留痕但不 throw
 * （broadcast 的 error 路径会走到这里，throw 会把普通错误广播变成异常）。 */
export function publishInbox(ev: InboxEvent): void {
  if (!inboxSink) {
    if (!sinkWarned) {
      sinkWarned = true
      log.warn('[inbox] sink 未注册（initInbox 未在装配层调用），inbox 事件被丢弃')
    }
    return
  }
  inboxSink.publish(ev)
}

/** 待审批重放：socket 接入（socket.ts，单播）与 attach（messages.ts，单播给发起连接）共用——
 *  未裁决的审批补发给目标，不向 Hub 内其他在线客户端广播（重复审批卡） */
export function replayApprovals(hub: Hub, send: (payload: unknown) => void): void {
  for (const a of hub.pendingApprovals.values()) {
    send({ kind: 'approval_request', ...a })
  }
}

export function broadcast(hub: Hub, payload: unknown): void {
  const kind = (payload as { kind?: string } | null | undefined)?.kind
  if (kind === 'cli') pushCliRing(hub, payload as Record<string, unknown>)
  const text = JSON.stringify(payload)
  for (const ws of hub.clients) {
    try {
      ws.send(text)
    } catch (e) {
      // 向刚关闭的连接发送是竞态常态（close 处理器尚未跑到），属预期内噪声——
      // 降到 debug 而非吞掉：排查"消息没收到"时开 ANYPLANE_LOG_LEVEL=debug 就能看见
      log.debug(`[ws ${hub.key}] 下行发送失败（连接可能已关闭）`, errFields(e))
    }
  }
  // 错误事件同步进全局收件箱（审批/完成由各自路径单独发布）
  if (kind === 'error') {
    publishInbox({ type: 'error', key: hub.key, message: String((payload as { message?: unknown }).message ?? '') })
  }
}

export function broadcastError(hub: Hub, message: string): void {
  broadcast(hub, { kind: 'error', message })
}
