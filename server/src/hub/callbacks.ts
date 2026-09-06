// 两个后端共用的会话回调装配：CLI/翻译层消息广播、审批入 Hub 表、状态推动。
// /clear 重键的三层同步（Hub / 进程 map / 存活 WS 的 data.key）全在这里——少一层即双进程或消息黑洞。

import { decisionOfRule, matchApprovalRule } from '../approvalRules'
import { keyFor, parseKey } from '../backends/claude/backend'
import { sanitizePath } from '../backends/claude/discovery'
import { processManager } from '../backends/claude/processManager'
import { isInternalUserMessage, type CliMessage } from '../backends/claude/protocol'
import { portFor } from '../backends/port'
import { config } from '../config'
import { log } from '../log'
import { broadcast, publishInbox } from './broadcast'
import { hubs } from './registry'
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
      if (msg.type === 'conversation_reset') {
        hub.pendingRekey = true
        return // 原始事件不进主抄本，迁移以 moved 事件表达
      }
      if (hub.pendingRekey && msg.type === 'system' && msg.subtype === 'init') {
        hub.pendingRekey = false
        const newSid = String(msg.session_id ?? '')
        const cwd = hub.spawnOpts?.cwd ?? parseKey(hub.key)?.cwd
        if (newSid && cwd) {
          const newKey = keyFor(sanitizePath(cwd), newSid)
          const oldKey = hub.key
          hubs.delete(oldKey)
          hub.goal = undefined // 上下文已清，goal 与待审批随之失效
          hub.pendingApprovals.clear()
          hub.pendingTitleText = undefined // 旧会话的标题素材不带给新会话
          hub.key = newKey
          hubs.set(newKey, hub)
          // 进程 map 同步重键：否则按新 key 查不到进程会再 spawn 一个（双进程同 transcript）
          processManager.rekey(oldKey, newKey)
          // 重键后同步改写存活连接的 data.key：message 路由（getHub(ws.data.key)）依赖它，
          // 否则旧 key 上的后续消息会新建空 Hub（消息黑洞）
          for (const ws of hub.clients) {
            if (!ws.data.inbox) ws.data.key = newKey
          }
          // 已知限制：新 transcript 文件尚未落盘时 parseKey 无法反查 cwd（进程存活期间无影响，
          // spawnOpts 持有 cwd；空闲回收后若文件仍未写则报"无法解析会话"）
          broadcast(hub, { kind: 'moved', targetKey: newKey, targetSessionId: newSid, reason: 'clear' })
          pushStatus(hub)
        }
      }
      // 每个 init 都更新会话身份（首次 spawn 与 /clear 重键共用；rekey 分支不落 return，会走到这里）
      if (msg.type === 'system' && msg.subtype === 'init') {
        hub.sessionId = String(msg.session_id ?? '') || undefined
        portFor(hub.key).maybeGenerateTitle(hub) // 首条消息可能已记账在等 sessionId（codex no-op）
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
          action: auto.rule.action,
          rule: label,
        })
        const s = portFor(hub.key).sessionOf(hub.key)
        if (s) s.sendApproval(req.requestId, decisionOfRule(auto.rule, req.input))
        else log.warn(`[approval] ${hub.key} 会话句柄已不存在，自动裁决无法送达`)
        return
      }
      hub.pendingApprovals.set(req.requestId, req)
      broadcast(hub, {
        kind: 'approval_request',
        requestId: req.requestId,
        toolName: req.toolName,
        input: req.input,
      })
      publishInbox({ type: 'approval', key: hub.key, requestId: req.requestId, toolName: req.toolName, input: req.input })
      pushStatus(hub)
      portFor(hub.key).notifyExternalGate(hub.key)
    },
    onStatusChange: () => throttledPushStatus(hub),
    onExit: (code: number) => {
      pushStatus(hub, { exited: true, exitCode: code, spawned: false, busy: false, waiting: false })
    },
  }
}
