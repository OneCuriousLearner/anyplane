// 审批裁决共享路径与回滚互斥守卫。

import { portFor } from '../backends/port'
import type { ApprovalDecision } from '../backends/types'
import { errorMessage } from '../util'
import { broadcast, broadcastError, publishInbox } from './broadcast'
import { pushStatus } from './status'
import type { Hub } from './types'

/** 回滚进行中拒绝新操作：返回 true 表示已拒绝（错误已广播） */
export function rewindBusy(hub: Hub, message = '已有回滚操作正在进行'): boolean {
  if (!hub.rewindPending) return false
  broadcastError(hub, message)
  return true
}

/**
 * 审批投递共享半段：手动裁决（resolveApproval）与规则自动裁决（callbacks.ts）共用——
 * 退出检查 + sendApproval 异常防护 + 外部门禁刷新。
 * 留痕事件不进这里：手动路径广播 approval_resolved（有 pending 卡要清），
 * 规则路径广播 approval_auto（请求从未入 pending，没有卡可清）。
 */
export function deliverApproval(hub: Hub, requestId: string, decision: ApprovalDecision): void {
  const port = portFor(hub.key)
  const s = port.sessionOf(hub.key)
  if (s && !s.exited) {
    try {
      s.sendApproval(requestId, decision)
    } catch (e) {
      broadcastError(hub, `审批回复失败: ${errorMessage(e)}`)
    }
  } else {
    // 会话已退出/未就绪：决定无处投递（上游请求将自行超时），本地照常解析并告知用户
    broadcastError(hub, '会话未在运行，审批未能送达（该请求会在上游自行超时）')
  }
  port.notifyExternalGate(hub.key)
}

/**
 * 审批解析共享路径：WS approval 消息与推送直接审批（/api/approval-action）共用。
 * 返回 false 表示 requestId 已不在 pending（重复点击/已在别处处理）。
 */
export function resolveApproval(hub: Hub, requestId: string, decision: ApprovalDecision): boolean {
  if (!hub.pendingApprovals.delete(requestId)) return false
  deliverApproval(hub, requestId, decision)
  broadcast(hub, { kind: 'approval_resolved', requestId })
  publishInbox({ type: 'approval_resolved', key: hub.key, requestId })
  pushStatus(hub)
  return true
}
