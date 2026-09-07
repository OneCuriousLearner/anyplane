// Hub 注册表：sessionKey → Hub。
// Hub 生命周期不变量（重要）：任何后端的会话句柄存活期间，其 Hub 不得删除——
// 否则重连复用旧会话时，其回调会把事件广播进已删除的 Hub（消息黑洞）。
// 回收判定在 hub/socket.ts 的 close 处理器（按后端判定存活）。

import type { Hub } from './types'

export const hubs = new Map<string, Hub>()

export function getHub(key: string): Hub {
  let h = hubs.get(key)
  if (!h) {
    h = { key, clients: new Set(), pendingApprovals: new Map() }
    hubs.set(key, h)
  }
  return h
}
