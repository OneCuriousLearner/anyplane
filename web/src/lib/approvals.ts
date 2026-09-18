// 审批卡 reconcile：以服务端 SessionState.pendingApprovalIds 快照为唯一权威对齐本地集。
// 只删不增——新卡由 approval_request 事件 append（useSessionSocket），这里负责删：
// 「裁决时恰好离线」/服务端重启后，重连首张 status 的快照不含已失效审批，过滤即收敛。
//
// 为什么不是 attach 时清空（曾是 13.4 批次 A 的首版实现，PR #50 review 发现一）：
// 盲清空会把仍在 pending 的卡也 unmount——ApprovalCard 的进行中输入（AskUserQuestion
// 选择态）是组件内 useState，key 不变但数组清空重建会 remount 全丢。瞬断重连
//（手机 ROM 后台正是高发场景）不该为稀有场景付这个代价。按 requestId reconcile
// 保留仍在 pending 的卡（元素引用不变、组件不 remount），只删已失效的。

/** local 过滤到 pendingIds 内；无变化时返回原数组引用（不触发多余渲染） */
export function reconcileApprovals<T extends { requestId: string }>(
  local: readonly T[],
  pendingIds: readonly string[],
): T[] {
  const keep = new Set(pendingIds)
  const next = local.filter((a) => keep.has(a.requestId))
  return next.length === local.length ? (local as T[]) : next
}
