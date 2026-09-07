// 会话 WS 连接 hook：SessionSocket 生命周期 + ServerEvent 全量分发。
// F5 从 pages/Chat.tsx 切出。
// 转发纪律（与现状逐字同构）：effect deps 仅 [session.key]——事件处理器在渲染外触发，
// 一律走 ingestApi/taskApi 的 ref 出口与稳定 setState；props 回调（onNavigate 等）
// 会话内语义不变，捕获首渲染值即现状语义。
// 详情抽屉域（query_result 的 MCP/context/设置结构化分发）留组合层，经 onQueryResult 回调；
// fetchConfig 与 socket 生命周期无关，同在组合层独立 effect（原 effect 内同步先后执行，
// 拆开后同 commit 按声明序执行，行为等价）。

import { useEffect, useState } from 'react'
import { fetchHistory, makeSessionInfo, type HistoryResponse, type SessionInfo } from '../lib/api'
import { nextId, type Block } from '../lib/blocks'
import { appendHistoryMsg, flushStrayResults, type IngestState } from '../lib/ingest'
import { SessionSocket, type ServerEvent, type SessionState } from '../lib/ws'
import type { TaskBucketsApi } from './useTaskBuckets'
import type { TranscriptIngestApi } from './useTranscriptIngest'

export interface Approval {
  requestId: string
  toolName: string
  input: unknown
}

export type QueryResultEvent = Extract<ServerEvent, { kind: 'query_result' }>

export function useSessionSocket(opts: {
  session: SessionInfo
  sockRef: React.RefObject<SessionSocket | undefined>
  ingestApi: TranscriptIngestApi
  taskApi: TaskBucketsApi
  loadSessionHistory: () => Promise<HistoryResponse>
  onNavigate?: (s: SessionInfo) => void
  /** codex 分叉完成时收起回滚面板 */
  onCloseRewind: () => void
  /** query_result 详情域分发（MCP 动作应答辨认 + 结构化面板），实现在组合层 */
  onQueryResult: (ev: QueryResultEvent) => void
}): {
  state: SessionState
  connected: boolean
  approvals: Approval[]
  setApprovals: React.Dispatch<React.SetStateAction<Approval[]>>
} {
  const { session, sockRef, ingestApi, taskApi, loadSessionHistory, onNavigate, onCloseRewind, onQueryResult } = opts
  const [state, setState] = useState<SessionState>({ spawned: false, busy: false })
  const [connected, setConnected] = useState(false)
  const [approvals, setApprovals] = useState<Approval[]>([])

  // ---------- WS 连接 ----------
  useEffect(() => {
    const sock = new SessionSocket(
      session.key,
      (ev: ServerEvent) => {
        switch (ev.kind) {
          case 'status':
            setState(ev.state)
            if (typeof ev.state.model === 'string') {
              ingestApi.setInitInfo((prev) => ({ ...prev, model: ev.state.model }))
            }
            if (typeof ev.state.permissionMode === 'string') ingestApi.setPermMode(ev.state.permissionMode)
            if (typeof ev.state.effort === 'string') ingestApi.setEffort(ev.state.effort)
            // 服务端权威运行任务表水合任务桶（中途接入补建 / 断线丢通知判死）
            taskApi.hydrateTasks(ev.state)
            // 进程已退出时固化/清理未完成的流式草稿，避免半截内容悬挂
            if (ev.state.exited) {
              ingestApi.commitDraft()
              ingestApi.setPhase(undefined)
            } else if (ev.state.sessionState === 'idle' && !ev.state.busy && !ev.state.waiting && ingestApi.draftRef.current) {
              // 自愈：权威 idle 到达时清掉陈旧流式草稿。服务端重启/断线期间 turn 终结时
              // 客户端拿不到终结事件，"生成中"会永远挂着（实测：watch 重载后复现）。
              // 等审批（waiting/requires_action）期间草稿是合法的，不在此清理。
              ingestApi.setDraftBoth(null)
              ingestApi.setPhase(undefined)
              // turn 已终结：此刻仍未配对的 tool_result 不会再等到它的调用了，
              // 浮现为孤立提示而非静默丢弃（旧实现直接 clear，用户零反馈）
              ingestApi.setMsgs((prev) => {
                const st: IngestState = { msgs: prev, toolIdx: ingestApi.toolPosRef.current, pending: ingestApi.pendingResultsRef.current }
                flushStrayResults(st)
                return st.msgs
              })
            }
            break
          case 'approval_request':
            setApprovals((prev) =>
              prev.some((a) => a.requestId === ev.requestId)
                ? prev
                : [...prev, { requestId: ev.requestId, toolName: ev.toolName, input: ev.input }],
            )
            break
          case 'approval_resolved':
            setApprovals((prev) => prev.filter((a) => a.requestId !== ev.requestId))
            break
          case 'approval_auto': {
            // 规则引擎自动裁决的审计留痕：不进审批队列，只落一条系统卡。
            // 摘要直接用服务端下发的 detail（summarizeInput 唯一口径，前端不另起一套）。
            const detail = typeof ev.detail === 'string' ? ev.detail : ''
            ingestApi.pushSystem(
              `规则自动${ev.action === 'allow' ? '放行' : '拒绝'}：${ev.toolName}${detail ? ` ${detail}` : ''}（${ev.rule}）`,
            )
            break
          }
          case 'error':
            ingestApi.pushSystem(`⚠ ${ev.message}`, 'error')
            break
          case 'btw_pending':
            // 创建侧问卡片（发送方与其他客户端都以此为准）
            if (!ingestApi.messagesRef.current.some((m) => m.btw === ev.question && m.btwPending)) {
              ingestApi.pushMsg({ id: nextId(), role: 'assistant', btw: ev.question, btwPending: true, blocks: [] })
            }
            break
          case 'btw_delta': {
            const target = ingestApi.messagesRef.current.find((m) => m.btw === ev.question && m.btwPending)
            if (!target) break
            ingestApi.setMsgs((prev) =>
              prev.map((m) => {
                if (m.id !== target.id) return m
                const blocks = [...m.blocks]
                const kind = ev.thinking ? 'thinking' : 'text'
                const i = blocks.findIndex((b) => b.kind === kind)
                if (i >= 0) {
                  const b = blocks[i]
                  if (b.kind === 'text' || b.kind === 'thinking') {
                    blocks[i] = { ...b, text: b.text + ev.delta }
                  }
                } else {
                  blocks.push({ kind, text: ev.delta })
                }
                // thinking 在 text 之前
                blocks.sort((a, b) => (a.kind === 'thinking' ? -1 : 0) - (b.kind === 'thinking' ? -1 : 0))
                return { ...m, blocks }
              }),
            )
            break
          }
          case 'btw_result': {
            // 找不到 pending 卡（如校验失败路径或漏收 btw_pending）时自行建卡落地结果——
            // 配对不变量由数据保证，不依赖服务端的消息时序
            if (!ingestApi.messagesRef.current.some((m) => m.btw === ev.question && m.btwPending)) {
              const blocks: Block[] = ev.ok
                ? ev.text.trim()
                  ? [{ kind: 'text', text: ev.text }]
                  : []
                : [{ kind: 'text', text: `⚠ ${ev.text}` }]
              ingestApi.pushMsg({ id: nextId(), role: 'assistant', btw: ev.question, btwPending: false, blocks })
              break
            }
            ingestApi.setMsgs((prev) =>
              prev.map((m) => {
                if (m.btw !== ev.question || !m.btwPending) return m
                if (ev.ok) {
                  // 用完整结果替换正文（增量可能因快照归并而不全）
                  const thinking = m.blocks.find((b) => b.kind === 'thinking')
                  const blocks: Block[] = []
                  if (thinking) blocks.push(thinking)
                  if (ev.text.trim()) blocks.push({ kind: 'text', text: ev.text })
                  return { ...m, blocks, btwPending: false }
                }
                return { ...m, blocks: [...m.blocks, { kind: 'text', text: `⚠ ${ev.text}` }], btwPending: false }
              }),
            )
            break
          }
          case 'forked': {
            if (ev.branchOf) {
              // claude 懒分叉：b| key 导航，首条消息才真正 --fork-session；
              // 历史视图直接读源会话 transcript（分支将原样继承它）
              ingestApi.pushSystem(
                `⎇ 已创建分支${ev.name ? `「${ev.name}」` : ''}：新会话携带当前全部历史，原会话保持不动`,
              )
              onNavigate?.(
                makeSessionInfo({
                  key: ev.targetKey,
                  slug: session.slug,
                  sessionId: ev.branchOf,
                  cwd: session.cwd,
                  backend: 'claude',
                }),
              )
              break
            }
            // codex 分叉回滚完成：原线程不动，跳到携带截断历史的新线程
            ingestApi.pushSystem('⎇ 已分叉：新会话携带所选消息之前的历史，原会话保持不动')
            onCloseRewind()
            onNavigate?.(
              makeSessionInfo({
                key: ev.targetKey,
                slug: 'codex',
                // codex 分叉路径服务端始终携带 targetSessionId（branchOf 不存在时）
                sessionId: ev.targetSessionId ?? '',
                cwd: session.cwd,
                backend: 'codex',
                managed: { spawned: true, busy: false, clients: 0 },
              }),
            )
            break
          }
          case 'handoff_pending':
            ingestApi.pushSystem(`⇄ 源会话正在生成交接简报（→ ${ev.toBackend === 'codex' ? 'Codex' : 'Claude'}）…`)
            break
          case 'handoff_brief':
            break // 简报在 handoff_done 时一并展示
          case 'handoff_done': {
            ingestApi.pushMsg({
              id: nextId(),
              role: 'system',
              systemKind: 'info',
              blocks: [{ kind: 'text', text: `⇄ 接力简报（已播种给 ${ev.toBackend === 'codex' ? 'Codex' : 'Claude'} 新会话）：\n\n${ev.brief}` }],
            })
            onNavigate?.(
              makeSessionInfo({
                key: ev.targetKey,
                slug: ev.toBackend === 'codex' ? 'codex' : session.slug,
                // 目标已 spawn 时 targetKey 是 resolved key（s|/x|）：必须带真实 id，
                // 否则 codex 侧 fetchCodexHistory('new') 必失败、历史视图永远空白
                sessionId: ev.targetSessionId ?? 'new',
                cwd: session.cwd,
                backend: ev.toBackend,
                status: 'busy',
                managed: { spawned: true, busy: true, clients: 0 },
              }),
            )
            break
          }
          case 'handoff_error':
            ingestApi.pushSystem(`⚠ 接力失败: ${ev.message}`, 'error')
            break
          case 'query_result':
            // 详情抽屉域（MCP 动作应答辨认 + 结构化面板分发）在组合层
            onQueryResult(ev)
            break
          case 'rewound':
            // 回滚会销毁并重生 CLI 进程（dispose 先摘 map 再 kill，onExit 不会触发），
            // 进行中的流式草稿/待配对工具结果/相位指示全部失效，必须一并清理，
            // 否则陈旧草稿会挂在回滚标签之下。
            ingestApi.setDraftBoth(null)
            ingestApi.pendingResultsRef.current.clear()
            ingestApi.setPhase(undefined)
            ingestApi.setMsgs((prev) => {
              const idx = prev.findIndex((m) => m.id === ev.userMessageId)
              const base = idx >= 0 ? prev.slice(0, idx + 1) : prev
              const label = ev.scope === 'both' ? '↩ 对话和文件已回滚' : '↩ 对话已回滚'
              return [...base, { id: nextId(), role: 'system', blocks: [{ kind: 'text', text: label }] }]
            })
            break
          case 'cli':
            if (ingestApi.gapReloadingRef.current) break
            ingestApi.handleCli(ev.msg, ev.replay === true)
            break
          case 'tail': {
            // 外部会话 transcript 追加：与历史共用同一套归并；uuid 去重兜底（重连续订可能重放）
            const h = ev.msg
            if (h.uuid && ingestApi.messagesRef.current.some((m) => m.id === h.uuid)) break
            ingestApi.setMsgs((prev) => {
              const st: IngestState = { msgs: prev, toolIdx: ingestApi.toolPosRef.current, pending: ingestApi.pendingResultsRef.current }
              appendHistoryMsg(st, h)
              // 不在此 flush：tail 是逐条到达，tool_use 可能在后续行；孤儿在权威 idle 时统一浮现
              return st.msgs
            })
            // 尾到的主线 tool_result 给已存在桶补终态——外部会话（tailer 路径）没有
            // task_notification，这是它唯一的终态信号；与历史回填同规则：终态挂 30s 驱逐
            for (const blk of h.blocks) {
              if (blk.kind !== 'tool_result' || !blk.id) continue
              taskApi.settleBucketFromResult(blk.id, blk.text ?? '', blk.isError === true)
            }
            break
          }
          case 'moved': {
            // /clear 对话重置：进程已换新 sessionId 续跑，Hub 重键完毕——跳到新会话页
            //（旧 transcript 在磁盘原样保留，列表页可见）
            const parts = ev.targetKey.split('|')
            onNavigate?.(
              makeSessionInfo({
                key: ev.targetKey,
                slug: parts[1] ?? session.slug,
                sessionId: ev.targetSessionId ?? 'new',
                cwd: session.cwd,
                backend: 'claude',
                managed: { spawned: true, busy: false, clients: 0 },
              }),
            )
            break
          }
          case 'replay_gap': {
            // 断线太久，服务端环形缓冲已挤掉起点：补发会留空洞，直接重载历史。
            // transcript 是权威事实源，重载一定能补齐（代价只是一次 HTTP）。
            // 必须与初次加载走同一 loader——Codex 没有 Claude transcript 路径。
            // 先挡住 cli 再清草稿：环里残留的 stream/assistant 不能在重载完成前改抄本。
            ingestApi.gapReloadingRef.current = true
            ingestApi.setDraftBoth(null)
            ingestApi.pendingResultsRef.current.clear()
            ingestApi.setPhase(undefined)
            const gapKey = session.key
            loadSessionHistory()
              .then((resp) => {
                if (sockRef.current?.key !== gapKey) return // 异步返回时已切走
                ingestApi.applyHistory(resp)
                ingestApi.pushSystem('↻ 断线较久，已重新载入对话')
              })
              .catch(() => {
                if (sockRef.current?.key !== gapKey) return
                ingestApi.pushSystem('⚠ 重新载入对话失败，请手动刷新', 'error')
              })
              .finally(() => {
                if (sockRef.current?.key === gapKey) ingestApi.gapReloadingRef.current = false
              })
            break
          }
          case 'tail_reset': {
            // 外部会话截断了 transcript（rewind / clear）：重载历史并用新偏移重新订阅
            ingestApi.setDraftBoth(null)
            ingestApi.pendingResultsRef.current.clear()
            const keyAtFetch = session.key
            fetchHistory(session.slug, session.sessionId)
              .then((resp) => {
                // 异步返回时用户可能已切走：socket 已换成新会话的，弃掉过期结果
                if (sockRef.current?.key !== keyAtFetch) return
                ingestApi.applyHistory(resp)
              })
              .catch(() => {})
            break
          }
        }
      },
      (open) => {
        setConnected(open)
        if (!open) return
        // 重连必须 attach：Codex x| 靠它 resume；fromSeq 为 0 也要带上，
        // 才能取回「一条可落盘 cli 都没收到就断线」期间的环。首连走下面的 attach。
        if (sock.reconnecting) sock.send({ kind: 'attach', fromSeq: sock.replayFrom })
        // 重连后服务端的 tailer 已随连接断开被回收，用已知的偏移重新订阅（重放部分由 uuid 去重）
        if (ingestApi.historyOffsetRef.current != null) {
          sock.send({ kind: 'tail_subscribe', from: ingestApi.historyOffsetRef.current })
        }
      },
    )
    sockRef.current = sock
    sock.send({ kind: 'attach' })
    return () => sock.close()
  }, [session.key])

  return { state, connected, approvals, setApprovals }
}
