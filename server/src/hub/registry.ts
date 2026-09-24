// Hub 注册表：sessionKey → Hub。
// Hub 生命周期不变量（重要）：任何后端的会话句柄存活期间，其 Hub 不得删除——
// 否则重连复用旧会话时，其回调会把事件广播进已删除的 Hub（消息黑洞）。
// 回收判定在 hub/socket.ts 的 close 处理器（按后端判定存活）。

import type { Hub } from './types'

export const hubs = new Map<string, Hub>()

/** rekey 墓碑：旧 key → 新 key。升键/重键后旧 key 即从 hubs 摘出，但迟到的连接
 * （stale 深链、断线重连、系统恢复的标签页）仍攥着旧 key——没有墓碑的话 wsOpen
 * 会在旧 key 上建出空 Hub，首条消息懒 spawn 出第二条进程，同 cwd 双会话并行。
 * 墓碑不随目标 Hub 回收而删：目标已回收时重定向到已落盘的 s|/x| 仍是正确动作
 * （attach 走离线/tail 路径）；单条目两字符串，本地工具量级无清理压力。 */
const tombstones = new Map<string, string>()

export function noteRekeyTombstone(oldKey: string, newKey: string): void {
  if (oldKey !== newKey) tombstones.set(oldKey, newKey)
}

/** 沿墓碑链解析到当前 key（/clear 链可叠加：n|→s|A→s|B）；无墓碑原样返回。
 *  链长上限纯兜底（正常 ≤2），防数据损坏时死循环。 */
export function resolveKeyTombstone(key: string): string {
  let cur = key
  for (let i = 0; i < 8; i++) {
    const next = tombstones.get(cur)
    if (!next) return cur
    cur = next
  }
  return cur
}

/** 测试复位口：bun test 单进程跨文件共享模块实例，碰墓碑的用例开头显式复位 */
export function resetTombstonesForTest(): void {
  tombstones.clear()
}

export function getHub(key: string): Hub {
  let h = hubs.get(key)
  if (!h) {
    h = { key, clients: new Set(), pendingApprovals: new Map() }
    hubs.set(key, h)
  }
  return h
}
