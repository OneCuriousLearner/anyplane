// 会话状态派生与推送：statusOf 编排（portFor 分发）+ pushStatus + onStatusChange 节流。

import { portFor } from '../backends/port'
import { broadcast } from './broadcast'
import { hubs } from './registry'
import type { Hub } from './types'

/** liveHint：调用方（/api/sessions）刚做过 pid 扫描时传入复用，避免每行各扫一次；
 *  显式 null 表示"已知不在线"（跳过扫描），undefined 才现扫。
 *  hydrateContext：仅单会话 attach/pushStatus 路径开启（离线时读 transcript 尾部补
 *  上下文占用）；列表端点禁止开启（N 行 × 文件读）。
 *  实现已按后端收敛进适配器（backends/port.ts 的 portFor 分发；公共字段见 baseStatusOf）。 */
export function statusOf(
  key: string,
  liveHint?: { status: string; pid: number } | null,
  hydrateContext = false,
): Record<string, unknown> {
  return portFor(key).statusOf(key, { hub: hubs.get(key), liveHint, hydrateContext })
}

export function pushStatus(hub: Hub, extra?: Record<string, unknown>): void {
  broadcast(hub, { kind: 'status', state: { ...statusOf(hub.key, undefined, true), ...extra } })
}

/** onStatusChange 的 leading+trailing 节流：并行后台任务的 task_progress 心跳每秒可触发多次，
 *  statusOf 构造+广播是纯派生数据，窗口内合并即可。leading 立即发（busy/idle 转移零延迟），
 *  窗口内后续变更合并为 trailing 一发——终态只是延迟 ≤300ms，不会丢失。
 *  仅挂 onStatusChange 一路；审批/退出/attach 等事件路径仍直调 pushStatus 保证即时。 */
const STATUS_THROTTLE_MS = 300
const statusThrottle = new WeakMap<Hub, { timer: ReturnType<typeof setTimeout> | null; dirty: boolean }>()
type StatusScheduler = (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>

export function throttledPushStatus(hub: Hub, scheduleStatus: StatusScheduler = setTimeout): void {
  let st = statusThrottle.get(hub)
  if (!st) {
    st = { timer: null, dirty: false }
    statusThrottle.set(hub, st)
  }
  if (st.timer) {
    st.dirty = true
    return
  }
  pushStatus(hub)
  st.timer = scheduleStatus(() => {
    st.timer = null
    // Hub 可能已回收删除：确认还是同一个 Hub 再补发
    if (st.dirty && hubs.get(hub.key) === hub) {
      st.dirty = false
      pushStatus(hub)
    }
  }, STATUS_THROTTLE_MS)
  st.timer.unref?.()
}
