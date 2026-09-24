// 两个后端共用的会话回调装配：CLI/翻译层消息广播、审批入 Hub 表、状态推动。
// /clear 重键的三层同步（Hub / 进程 map / 存活 WS 的 data.key）在 lifecycle.rekeyHub——少一层即双进程或消息黑洞。

import { decisionOfRule, matchApprovalRule } from '../approvalRules'
import { isInternalUserMessage, type CliMessage } from '../backends/claude/streamJson'
import { describeKey, portFor } from '../backends/port'
import { config } from '../config'
import { log } from '../log'
import { summarizeInput } from '../util'
import { broadcast, publishInbox } from './broadcast'
import { deliverApproval, rekeyHub } from './lifecycle'
import { pushStatus, throttledPushStatus } from './status'
import type { Hub } from './types'

/** 两个后端共用的会话回调：CLI/翻译层消息广播、审批入 Hub 表、状态推动 */
export function sessionCallbacks(hub: Hub) {
  return {
    onMessage: (msg: CliMessage) => {
      // 后台 Agent 完成通知会作为伪装成 user 的内部 XML 记录出现。
      // 生命周期本身已由 ProcessManager 消费为 system/task_notification；
      // 不再把原始内部载荷广播进主聊天或 rewind 历史。
      if (isInternalUserMessage(msg)) return
      // /clear（别名 /reset /new）：CLI 发 conversation_reset 并以新 session_id 续跑。
      // Hub 随之重键到 s|slug|<newSid>——新会话页承载后续对话，旧 transcript 原样留存。
      // claude-only 语义，守卫防漂移：codex 若未来发出同形事件，落入普通透传而不是
      // 误触 claude 专属的重键（keyForExisting/rekeySession 作用在 x| key 上即消息黑洞）。
      if (msg.type === 'conversation_reset' && portFor(hub.key).name === 'claude') {
        // 判别联合覆盖语义纪律：rewind 期间 /clear 的 user 消息被 rewindBusy 拒，
        // 同真理论上不可达；若仍撞上（上游行为漂移），rekey 必须生效（否则后续消息全乱），
        // 但覆盖 rewind 守卫要留痕——静默覆盖会让「回滚中放行新消息」无迹可查
        if (hub.transition) {
          log.warn(`[ws ${hub.key}] conversation_reset 覆盖了进行中的 transition=${hub.transition.kind}（预期外）`)
        }
        hub.transition = { kind: 'rekey' }
        return // 原始事件不进主抄本，迁移以 moved 事件表达
      }
      if (hub.transition?.kind === 'rekey' && msg.type === 'system' && msg.subtype === 'init') {
        hub.transition = undefined
        const port = portFor(hub.key)
        const newSid = String(msg.session_id ?? '')
        const cwd = hub.spawnOpts?.cwd ?? port.handoffSource(hub.key).cwd
        if (newSid && cwd) {
          const newKey = port.keyForExisting(newSid, cwd)
          const oldKey = hub.key
          hub.goal = undefined // 上下文已清，goal 与待审批随之失效
          hub.pendingApprovals.clear()
          hub.pendingTitleText = undefined // 旧会话的标题素材不带给新会话
          // 三层重键（Hub / 进程 map / 存活 WS data.key），实现集中在 lifecycle.rekeyHub
          rekeyHub(hub, oldKey, newKey, newSid)
          // 已知限制：新 transcript 文件尚未落盘时 handoffSource 无法反查 cwd（进程存活期间无影响，
          // spawnOpts 持有 cwd；空闲回收后若文件仍未写则报"无法解析会话"）
          broadcast(hub, { kind: 'moved', targetKey: newKey, targetSessionId: newSid, reason: 'clear' })
          pushStatus(hub)
        }
      }
      // 每个 init 都更新会话身份（首次 spawn 与 /clear 重键共用；rekey 分支不落 return，会走到这里）
      if (msg.type === 'system' && msg.subtype === 'init') {
        const sid = String(msg.session_id ?? '') || undefined
        // 懒启动/懒分叉拿到真实 id 就升键（n|→s|、xn|→x|、b|→s|）：不重键的话 Hub 继续叫 n|，
        // 磁盘转录被 discovery 发现成 s|，刷新/深链/列表点回会 tail 分裂出「外部会话」，
        // 顶栏标题也永远写不回。claude 真 init 与 codex 合成 init（session.ts 线程启动后）
        // 都经此分支；existing key（s|/x| resume）与 /clear 刚重键完的新 key 自然跳过。
        const port = portFor(hub.key)
        const desc = describeKey(hub.key)
        if (sid && desc && desc.kind !== 'existing') {
          // cwd 优先级与 /clear 分支一致：spawnOpts（用户显式选择）> key 内嵌 > 反查
          const cwd = hub.spawnOpts?.cwd ?? desc.cwd ?? port.handoffSource(hub.key).cwd
          const newKey = cwd ? port.keyForExisting(sid, cwd) : undefined
          if (newKey && newKey !== hub.key) {
            const oldKey = hub.key
            // 三层重键（Hub / 进程 map / 存活 WS data.key），实现集中在 lifecycle.rekeyHub
            rekeyHub(hub, oldKey, newKey, sid)
            broadcast(hub, { kind: 'moved', targetKey: newKey, targetSessionId: sid, reason: 'spawned' })
            pushStatus(hub)
          }
        }
        hub.sessionId = sid
        portFor(hub.key).maybeGenerateTitle?.(hub) // 首条消息可能已记账在等 sessionId（claude-only 能力，?. 守护）
      }
      broadcast(hub, { kind: 'cli', msg })
      // turn 收尾是收件箱的核心提醒信号（agent 跑完了）
      if (msg.type === 'result') {
        publishInbox({ type: 'done', key: hub.key, ok: msg.is_error !== true })
        // claude /goal：goal 激活期间 turn 只会因"条件达成"结束（Stop hook 拦截其余收尾），
        // 所以 result 到达即视为目标完成（用户中断也会到此，chip 随之清除，语义可接受）
        if (hub.goal) {
          hub.goal = undefined
          pushStatus(hub)
        }
      }
    },
    onApprovalRequest: (req: { requestId: string; toolName: string; input: unknown }) => {
      // 审批规则引擎：按序首条命中即自动裁决——不进 pending、不推送、不打扰，
      // 但广播 approval_auto 留痕事件（UI 灰底卡 + 服务端日志），审计可回溯。
      // 规则只做服务端裁决，绝不进入推送能力 URL 路径。
      const auto = matchApprovalRule(config.approvalRules ?? [], req.toolName, req.input)
      if (auto) {
        const label = auto.rule.note ?? `approvalRules[${auto.index}]`
        log.info(`[approval] ${hub.key} 规则自动${auto.rule.action === 'allow' ? '放行' : '拒绝'} ${req.toolName}（${label}）`)
        broadcast(hub, {
          kind: 'approval_auto',
          requestId: req.requestId,
          toolName: req.toolName,
          input: req.input,
          // 摘要由服务端唯一口径 summarizeInput 算好下发，前端不再各自提取字段
          detail: summarizeInput(req.toolName, req.input),
          action: auto.rule.action,
          rule: label,
        })
        // 与手动裁决共用投递半段（退出检查/异常防护/门禁刷新）；
        // 不广播 approval_resolved——请求从未入 pending，没有卡片需要清除
        deliverApproval(hub, req.requestId, decisionOfRule(auto.rule, req.input))
        return
      }
      hub.pendingApprovals.set(req.requestId, req)
      broadcast(hub, {
        kind: 'approval_request',
        requestId: req.requestId,
        toolName: req.toolName,
        input: req.input,
      })
      publishInbox({
        type: 'approval',
        key: hub.key,
        requestId: req.requestId,
        toolName: req.toolName,
        input: req.input,
        // 摘要由服务端唯一口径算好下发——原生通知（app 壳）与 JS 兜底共用此字段，不再各自 JSON.stringify
        detail: summarizeInput(req.toolName, req.input),
      })
      pushStatus(hub)
      portFor(hub.key).notifyExternalGate?.(hub.key) // claude-only 能力（外部门禁），?. 守护
    },
    onStatusChange: () => throttledPushStatus(hub),
    /** 审批被上游终结（app-server 超时/中断/其他客户端应答，codex serverRequest/resolved）：
     *  同步清掉 Hub 侧 pending，否则死审批会随重连重放、status 恒 waiting。 */
    onApprovalResolved: (requestId: string) => {
      if (!hub.pendingApprovals.delete(requestId)) return
      broadcast(hub, { kind: 'approval_resolved', requestId })
      publishInbox({ type: 'approval_resolved', key: hub.key, requestId })
      pushStatus(hub)
    },
    onExit: (code: number) => {
      // 进程已死，待审批随之失效：清表并逐条广播 approval_resolved 让客户端撤卡。
      // 否则重连时 replayApprovals 会把死审批重放成可点击卡片（点击后投递给一个不认识
      // 该 request_id 的新进程），此后任何 status 推送也都因 pending>0 显示 waiting。
      if (hub.pendingApprovals.size > 0) {
        for (const requestId of hub.pendingApprovals.keys()) {
          broadcast(hub, { kind: 'approval_resolved', requestId })
          publishInbox({ type: 'approval_resolved', key: hub.key, requestId })
        }
        hub.pendingApprovals.clear()
      }
      pushStatus(hub, { exited: true, exitCode: code, spawned: false, busy: false, waiting: false })
    },
  }
}
