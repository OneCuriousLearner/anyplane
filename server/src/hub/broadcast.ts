// Hub 级广播与 inbox 事件出口。
// 依赖红线：hub/* 绝不 import push/*（循环）——inbox 事件经 InboxSink、
// /ws/inbox 客户端经 InboxChannel 注入；实现都在 push/inbox.ts，装配层 initInbox() 一次接线。

import type { InboxEvent, ServerEvent } from '@anyplane/protocol'
import type { ServerWebSocket } from 'bun'
import { pushCliRing } from '../cliReplay'
import { errFields, log } from '../log'
import type { Hub, WSData, WSDataInbox } from './types'

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

/** /ws/inbox 客户端登记与快照：实现在 push/inbox.ts，装配层 initInbox 注入。
 *  hub/socket 只走本口，禁止 import push（红线②，不再豁免）。 */
export interface InboxChannel {
  add(ws: ServerWebSocket<WSDataInbox>): void
  remove(ws: ServerWebSocket<WSDataInbox>): void
  snapshot(): Extract<InboxEvent, { type: 'snapshot' }>
}

let inboxChannelImpl: InboxChannel | undefined

export function setInboxChannel(c: InboxChannel): void {
  inboxChannelImpl = c
}

export function resetInboxChannelForTest(): void {
  inboxChannelImpl = undefined
}

/** socket 取 inbox 通道；未装配即调用是编程错误，fail fast */
export function inboxChannel(): InboxChannel {
  if (!inboxChannelImpl) throw new Error('[inbox] initInbox 未在装配层调用（InboxChannel 未注入）')
  return inboxChannelImpl
}

/** 测试专用复位：bun test 单进程跨文件共享模块实例，sink/warn-once 状态无法靠重 import
 *  隔离——断言「sink 未注册」行为的用例必须先复位，否则依赖测试文件执行顺序（各平台
 *  文件枚举顺序不同，ubuntu CI 曾因此误红）。 */
export function resetInboxSinkForTest(): void {
  inboxSink = undefined
  sinkWarned = false
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

/** 定向单播唯一出口（socket.ts 的握手/补发、messages.ts 的重连补发共用）：
 *  与 broadcast 同一竞态语义——向刚关闭的连接发送是预期内噪声，降 debug 留痕 */
export function sendTo(ws: ServerWebSocket<WSData>, payload: ServerEvent): void {
  try {
    ws.send(JSON.stringify(payload))
  } catch (e) {
    log.debug('[ws] 下行单播失败（连接可能已关闭）', errFields(e))
  }
}

/** 待审批重放：socket 接入（socket.ts，单播）与 attach（messages.ts，单播给发起连接）共用——
 *  未裁决的审批补发给目标，不向 Hub 内其他在线客户端广播（重复审批卡） */
export function replayApprovals(hub: Hub, send: (payload: ServerEvent) => void): void {
  for (const a of hub.pendingApprovals.values()) {
    send({ kind: 'approval_request', ...a })
  }
}

/** 下行事件唯一卡口：payload 必须是 ServerEvent 判别联合的成员——
 *  新增事件先改 @anyplane/protocol，否则这里编译不过（前端同步获得类型） */
export function broadcast(hub: Hub, payload: ServerEvent): void {
  if (payload.kind === 'cli') pushCliRing(hub, payload)
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
  if (payload.kind === 'error') {
    publishInbox({ type: 'error', key: hub.key, message: payload.message })
  }
}

export function broadcastError(hub: Hub, message: string): void {
  broadcast(hub, { kind: 'error', message })
}
