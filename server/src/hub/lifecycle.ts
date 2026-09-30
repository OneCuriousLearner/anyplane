// 审批裁决共享路径与回滚互斥守卫。

import { portFor } from '../backends/port'
import type { ApprovalDecision } from '@anyplane/protocol'
import { errorMessage } from '../util'
import { log } from '../log'
import { broadcast, broadcastError, publishInbox } from './broadcast'
import { hubs, noteRekeyTombstone } from './registry'
import { pushStatus } from './status'
import type { Hub } from './types'

/** 回滚进行中拒绝新操作：返回 true 表示已拒绝（错误已广播） */
export function rewindBusy(hub: Hub, message = '已有回滚操作正在进行'): boolean {
  if (hub.transition?.kind !== 'rewind') return false
  broadcastError(hub, message)
  return true
}

/**
 * 三层重键（Hub / 进程 map / 存活 WS 的 data.key）：/clear 对话重置（callbacks.ts）与
 * 接力播种落 resolved key（handoff.ts）共用——少一层即双进程或消息黑洞：
 * 进程 map 不重键则按新 key 查不到进程会再 spawn 一个（双进程同 transcript）；
 * 存活连接的 data.key 不改写则 message 路由（getHub(ws.data.key)）落空，旧 key 上新建空 Hub。
 * rekey 前后 backend 不变（n|→s|、/clear 同进程），portFor(newKey) 与旧 key 同适配器。
 */
export function rekeyHub(hub: Hub, oldKey: string, newKey: string, newSessionId: string): void {
  hubs.delete(oldKey)
  hub.key = newKey
  hubs.set(newKey, hub)
  // 旧 key 留墓碑：wsOpen 把迟到的连接重定向过来（stale 深链/断线重连场景），
  // 否则旧 key 上会建出空 Hub，首条消息再 spawn 一条进程同写 cwd
  noteRekeyTombstone(oldKey, newKey)
  portFor(newKey).rekeySession(hub, oldKey, newKey, newSessionId)
  for (const ws of hub.clients) {
    if (!ws.data.inbox) ws.data.key = newKey
  }
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
      // rememberTool 是 Hub 内存放行集的内部语义，投递上游前剥掉——
      // claude 的 control_response 把整个 decision 透传给 CLI（未知字段容忍度未验证，
      // 被拒绝会让工具调用挂到上游超时）；codex 侧 mapApprovalDecision 本就会归约
      const wire: ApprovalDecision =
        decision.behavior === 'allow'
          ? { behavior: 'allow', updatedInput: decision.updatedInput }
          : decision
      s.sendApproval(requestId, wire)
    } catch (e) {
      broadcastError(hub, `审批回复失败: ${errorMessage(e)}`)
    }
  } else {
    // 会话已退出/未就绪：决定无处投递（上游请求将自行超时），本地照常解析并告知用户
    broadcastError(hub, '会话未在运行，审批未能送达（该请求会在上游自行超时）')
  }
  port.notifyExternalGate?.(hub.key) // claude-only 能力（外部门禁），?. 守护
}

/**
 * 审批解析共享路径：WS approval 消息与推送直接审批（/api/approval-action）共用。
 * 返回 false 表示 requestId 已不在 pending（重复点击/已在别处处理）。
 * 注意：approval_resolved 广播是幂等清理信号——即使 pending 已不存在也照发：
 * 在线客户端的 stale 卡借此自愈（多设备场景）；它不是补发机制——fire-and-forget
 * 的广播救不了「裁决时恰好离线」的客户端，那一类由 SessionState.pendingApprovalIds
 * 快照 + 客户端 reconcile 收敛（useSessionSocket status case；13.4 批次 A 已做）。
 */
export function resolveApproval(hub: Hub, requestId: string, decision: ApprovalDecision): boolean {
  // 「本会话允许这个工具」：allow + rememberTool 时把 toolName 记入进程层放行集（唯一权威——
  // 审批到达时进程必活，写入本实例的集；dispose 同步焚毁，无喂回无复活）。
  // 只在 WS 裁决路径生效（REST 核 resolveApprovalRest 只接受 allow/deny 字面量——
  // 审批规则语义绝不进推送能力 URL 的红线不变）
  const pending = hub.pendingApprovals.get(requestId)
  if (pending && decision.behavior === 'allow' && decision.rememberTool === true) {
    try {
      portFor(hub.key).sessionOf(hub.key)?.rememberAllowTool?.(pending.toolName)
    } catch {
      // 进程层此刻不可达（理论上审批到达时必活，兜底静默）——进程层缺失时
      // 命中判定 allowsTool 返回 false，退化为「下次重问」，安全方向
    }
  }
  const had = hub.pendingApprovals.delete(requestId)
  if (had) deliverApproval(hub, requestId, decision)
  broadcast(hub, { kind: 'approval_resolved', requestId })
  publishInbox({ type: 'approval_resolved', key: hub.key, requestId })
  pushStatus(hub)
  return had
}

/**
 * 清空 Hub 待审批集并逐条广播 approval_resolved（含 inbox 回声）：
 * 中断/进程退出等「审批已死但服务端没走正常裁决」的路径共用——不清的话死审批会
 * 随重连重放成可点击僵尸卡（点击后投递给不认识该 request_id 的对端），
 * 且此后任何 status 推送都因 pending>0 恒显 waiting。
 * 调用方负责随后 pushStatus（让客户端按 pendingApprovalIds 快照 reconcile 撤卡）。
 */
export function clearPendingApprovals(hub: Hub): void {
  if (hub.pendingApprovals.size === 0) return
  for (const requestId of hub.pendingApprovals.keys()) {
    broadcast(hub, { kind: 'approval_resolved', requestId })
    publishInbox({ type: 'approval_resolved', key: hub.key, requestId })
  }
  hub.pendingApprovals.clear()
}

/**
 * 「本会话允许」放行集失效的唯一卡口（C1 治本）：通知进程层永久丢弃放行集
 * （上游待重放队列一并焚毁；进程层实现幂等 clear，重复通知无害）。
 * 所有失效路径（dispose 同步路径 / app-server 死亡 / /clear 重键）都必须走这里——
 * 命中判定只查进程层（allowsTool），无 Hub 侧第二份可写副本可复活（stale swallow 返工的终局）。
 * 默认不推 status（调用方多数自带终态推送）；确需即时推送传 { push: true }。
 */
export function dropSessionAllowTools(hub: Hub, reason: string, opts?: { push?: boolean }): void {
  try {
    portFor(hub.key).sessionOf(hub.key)?.discardAllowTools?.()
  } catch {
    // 进程层此刻不可达（正在退出）无碍——进程层集已随 dispose 同步焚毁
  }
  log.info(`[ws ${hub.key}] 本会话放行集失效（${reason}）`)
  if (opts?.push) pushStatus(hub)
}

/** REST 审批公共核的返回：路由层把 ok:false 映射为对应 HTTP 状态码。 */
export type RestApprovalResult =
  | { ok: true; toolName: string }
  | { ok: false; status: 400 | 409; error: string }

/**
 * REST 审批公共核：能力 URL（/api/approval-action，secret 鉴权）与
 * 原生壳令牌端点（/api/approvals/resolve，Bearer 鉴权）共用。
 * decision 只接受 allow/deny；allow 沿用 pending 里的原始 input；
 * denyMessage 由调用方给出（留痕文案区分触发通道）。
 */
export function resolveApprovalRest(
  key: string,
  requestId: string,
  decision: string,
  denyMessage: string,
): RestApprovalResult {
  if (decision !== 'allow' && decision !== 'deny') {
    return { ok: false, status: 400, error: '只接受 allow/deny' }
  }
  const hub = hubs.get(key)
  const pending = hub?.pendingApprovals.get(requestId)
  if (!hub || !pending) return { ok: false, status: 409, error: '该审批已处理或不存在' }
  // get 与 delete 在同一事件循环刻度内，resolveApproval 在此处必然成功（无 await 窗口）
  resolveApproval(
    hub,
    requestId,
    decision === 'allow'
      ? { behavior: 'allow', updatedInput: pending.input }
      : { behavior: 'deny', message: denyMessage },
  )
  return { ok: true, toolName: pending.toolName }
}
