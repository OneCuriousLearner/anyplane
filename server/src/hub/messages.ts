// WS 上行消息分发：11 类 kind 全部经 portFor 分发给后端适配器。
// Hub 级状态（spawnOpts 缓存、rewindPending 守卫、重连补发单播）留在本层——适配器只做后端投递。

import type { ServerWebSocket } from 'bun'
import { portFor } from '../backends/port'
import type { ApprovalDecision } from '../backends/types'
import { replayCliSince } from '../cliReplay'
import { errFields, log } from '../log'
import { errorMessage } from '../util'
import { broadcast, broadcastError, replayApprovals } from './broadcast'
import { resolveApproval, rewindBusy } from './lifecycle'
import { pushStatus } from './status'
import type { Hub, WSData } from './types'

export function handleClientMessage(
  hub: Hub,
  raw: string,
  /** 发起方连接：仅重连补发需要单播（其余一律 hub 级广播） */
  ws?: ServerWebSocket<WSData>,
): void {
  let data: Record<string, unknown>
  try {
    data = JSON.parse(raw)
  } catch (e) {
    // 曾是静默 return：协议漂移/帧截断时表现为"消息就是没了"，零线索。
    // 客户端不可能合法发出非 JSON，这一定是 bug 或攻击面探测，按 error 留痕。
    log.error(`[ws ${hub.key}] 上行非 JSON 帧，已丢弃`, { bytes: raw.length, head: raw.slice(0, 120), ...errFields(e) })
    return
  }
  switch (data.kind) {
    case 'attach': {
      // 浏览历史只握手，不 spawn。发消息 / 切 model·mode·effort / rewind / btw 时再启动 CLI。
      // 各后端的 attach 策略（warm 预热、codex x| 即 resume）见适配器 onAttach。
      portFor(hub.key).onAttach(hub, data)
      // 待审批补发只给本次 attach 的连接：走 broadcast 会让已在线的其他客户端
      // 重复收到同一张审批卡（requestId 相同，纯噪声）
      if (ws) {
        replayApprovals(hub, (p) => {
          try {
            ws.send(JSON.stringify(p))
          } catch (e) {
            log.debug(`[ws ${hub.key}] 审批补发单播失败`, errFields(e))
          }
        })
      } else {
        replayApprovals(hub, (p) => broadcast(hub, p))
      }
      // 重连补发：客户端带上断线前的最高 seq，取回这期间错过的 cli 事件。
      // **必须单播**：走 broadcast 会让补发内容重新入环并分配新序号（自我污染），
      // 且已在线的其他客户端会收到重复投递。
      const fromSeq = typeof data.fromSeq === 'number' ? data.fromSeq : undefined
      if (fromSeq !== undefined && ws) {
        const unicast = (p: unknown) => {
          try {
            ws.send(JSON.stringify(p))
          } catch (e) {
            log.debug(`[ws ${hub.key}] 补发单播失败`, errFields(e))
          }
        }
        // 环里已挤掉起点时告知缺口，由前端重载历史补全（transcript 是权威事实源）
        const gap = replayCliSince(hub, fromSeq, unicast)
        if (gap) {
          log.info(`[ws ${hub.key}] 补发存在缺口，通知客户端重载历史`, { fromSeq, ringFrom: hub.cliRing?.[0]?.seq })
          unicast({ kind: 'replay_gap', fromSeq })
        }
      }
      break
    }
    case 'tail_subscribe': {
      // 客户端加载完历史后订阅 transcript 追加（from = 历史读取时的文件字节数，无缝衔接）；
      // codex 的实时流走 app-server 订阅，无 tailer 概念（适配器内 no-op）
      portFor(hub.key).startTailer(hub, typeof data.from === 'number' ? data.from : undefined)
      break
    }
    case 'user': {
      if (rewindBusy(hub, '正在恢复文件，请等待回滚完成后再发送消息')) return
      const sendMode = data.sendMode === 'steer' || data.sendMode === 'queue' ? data.sendMode : undefined
      // 图片附件：服务端统一校验（类型/大小），claude 并 content blocks，codex 落盘走 localImage
      const attachments = (
        Array.isArray(data.attachments) ? (data.attachments as Array<Record<string, unknown>>) : []
      ).map((a) => ({
        name: String(a.name ?? 'image'),
        mediaType: String(a.mediaType ?? 'image/png'),
        dataBase64: String(a.dataBase64 ?? ''),
      }))
      const text = String(data.text ?? '')
      void (async () => {
        const port = portFor(hub.key)
        try {
          // ensure 也必须罩在 try 内：fire-and-forget IIFE 里 await 抛在 catch 之外
          // 会变 unhandled rejection——消息无声消失，客户端连错误卡都收不到
          const s = await port.ensureForSend(hub)
          if (!s) return // 适配器已广播具体错误
          // sendMode 直通：claude 侧 steer=priority 'now'（中断处理）、queue=服务端排队
          s.sendUserText(text, sendMode, attachments)
          // 后端特定的发送后跟踪（claude：/goal 出站跟踪 + 标题素材记账；codex 无）
          port.afterUserSent?.(hub, text)
          pushStatus(hub)
        } catch (e) {
          broadcastError(hub, `发送失败: ${errorMessage(e)}`)
          pushStatus(hub)
        }
      })()
      break
    }
    case 'control': {
      const subtype = String(data.subtype)
      const extra = (data.extra as Record<string, unknown>) ?? {}
      // 组合回滚等待期间，通用控制路径不得再发 rewind_files 与之竞争
      if (hub.rewindPending && subtype === 'rewind_files') {
        broadcastError(hub, '已有回滚操作正在进行')
        return
      }
      // model/mode 都有等价启动参数：先缓存最终选择（未 spawn 时首条消息应用），
      // 已 spawn 时再发运行时控制。两个后端同此序。
      if (subtype === 'set_model' && extra.model) {
        hub.spawnOpts = { ...hub.spawnOpts, model: String(extra.model) }
      }
      if (subtype === 'set_permission_mode' && extra.mode) {
        hub.spawnOpts = { ...hub.spawnOpts, permissionMode: String(extra.mode) }
      }
      portFor(hub.key).deliverControl(hub, subtype, extra)
      break
    }
    case 'update_env': {
      // effort 有 --effort 启动参数。未 spawn 时只缓存，首条消息时应用；
      // 已 spawn 时通过 update_environment_variables 影响后续 turn。
      const variables = (data.variables as Record<string, string>) ?? {}
      const effort = variables.CLAUDE_CODE_EFFORT_LEVEL
      if (effort) hub.spawnOpts = { ...hub.spawnOpts, effort }
      portFor(hub.key).updateEnv(hub, variables)
      break
    }
    case 'branch': {
      // 分叉当前会话：claude 懒分叉（b| key，首条消息才 --fork-session），
      // codex 走既有 thread/fork（RewindPicker 的"从此处分叉"，适配器内拒绝并引导）
      portFor(hub.key).branch(hub, String(data.name ?? ''))
      break
    }
    case 'rewind_conversation': {
      const at = String(data.userMessageId ?? '')
      if (!at) return
      // claude=原地截断重 spawn；codex=thread/fork 分叉语义（rewindPending 守卫在适配器内）
      portFor(hub.key).rewindConversation(hub, at)
      break
    }
    case 'rewind_both': {
      const at = String(data.userMessageId ?? '')
      if (!at) return
      // 组合回滚：claude 先 rewind_files 再截断；codex 无文件检查点（适配器内拒绝）
      portFor(hub.key).rewindBoth(hub, at)
      break
    }
    case 'btw': {
      // 侧问：借用当前会话上下文的一次性问答，不进主会话历史
      const question = String(data.question ?? '').trim()
      // btw_pending 必须先于校验失败分支发出：前端卡片由它创建，
      // 否则校验失败的 btw_result 找不到卡（按 question 配对）被静默丢弃，用户零反馈
      if (question) broadcast(hub, { kind: 'btw_pending', question })
      portFor(hub.key).btw(hub, question)
      break
    }
    case 'query': {
      // 带应答的控制请求通道：只读查询（mcp_status / get_settings / get_context_usage）
      // 与 MCP 管理动作（mcp_reconnect / mcp_toggle，经 extra 传参）共用；
      // codex 仅 mcp_status 有对应物 mcpServerStatus/list（动作类一律拒绝，见适配器）
      const id = String(data.id ?? '')
      const query = String(data.query ?? '')
      const extra = (data.extra as Record<string, unknown> | undefined) ?? {}
      const reply = (payload: Record<string, unknown>) => broadcast(hub, { kind: 'query_result', id, ...payload })
      if (!id || !query) return
      portFor(hub.key).query(hub, query, extra, reply)
      break
    }
    case 'approval': {
      const requestId = String(data.requestId)
      resolveApproval(hub, requestId, data.decision as ApprovalDecision)
      break
    }
  }
}
