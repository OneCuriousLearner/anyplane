// 主抄本 ingest hook：消息列表 + 流式草稿 + 7 个配对/去重 ref + handleCli/applyHistory。
// F4 从 pages/Chat.tsx 切出；F5 把 cli 流驱动的会话元数据（phase/initInfo/permMode/effort）
// 一并内化——主要写入方本来就是本 hook 的 init/status/result 分支，setter 经 api 暴露给
// WS status 事件（useSessionSocket）与 E3 清空段（组合层）共用。
// 纪律：事件处理器在 React 渲染外触发（WS 回调），内部一律走 ref + setState——
// api 对象每渲染重建但永不过期。
// E3（session.key 历史加载 effect）留 Chat 组合层：reset 先于建连的顺序纪律在那。

import { useRef, useState } from 'react'
import type { HistoryResponse } from '../lib/api'
import { nextId, toolResultText, type Block, type ChatMsg } from '../lib/blocks'
import {
  appendHistoryMsg,
  createIngestState,
  flushStrayResults,
  hitsSeen,
  indexToolBlocks,
  liveMessageKeys,
  pairToolResultIn,
  pairToolResultPartialIn,
  rememberKeys,
  transcriptKeys,
  type IngestState,
} from '../lib/ingest'
import type { CliMsg, SessionSocket } from '../lib/ws'
import type { TaskBucketsApi } from './useTaskBuckets'

/** 流式草稿：一轮 assistant 输出的增量块（按 message.id + block index 归并） */
interface DraftBlock {
  idx: number
  kind: 'text' | 'thinking' | 'tool'
  text: string
  name?: string
  toolId?: string
  jsonBuf?: string
  finalized?: boolean
}
export interface Draft {
  msgId?: string
  blocks: DraftBlock[]
}

export interface TranscriptIngestApi {
  // cli 流驱动的会话元数据 setter（WS status 事件与组合层清空段共用）
  setPhase: React.Dispatch<React.SetStateAction<string | undefined>>
  setPermMode: React.Dispatch<React.SetStateAction<string | undefined>>
  setInitInfo: React.Dispatch<React.SetStateAction<{ model?: string; slashCommands?: string[] }>>
  setEffort: React.Dispatch<React.SetStateAction<string | undefined>>
  setMsgs(up: (prev: ChatMsg[]) => ChatMsg[]): void
  setDraftBoth(d: Draft | null): void
  pushMsg(m: ChatMsg): void
  pushSystem(text: string, kind?: 'info' | 'error'): void
  /** message_stop / result 时把草稿固化为一条 assistant 消息 */
  commitDraft(): void
  handleCli(msg: CliMsg, replay?: boolean): void
  /** 历史响应落到消息列表 + 从读取位置续订 tail（初次加载与 tail_reset 重载共用） */
  applyHistory(resp: HistoryResponse): void
  /** 会话切换重置（E3 组合层调用；顺序即原 E3 清空段前 7 步） */
  reset(): void
  // ref 出口：WS 事件分发（F5 前留 Chat）需要直接读写
  messagesRef: React.RefObject<ChatMsg[]>
  draftRef: React.RefObject<Draft | null>
  pendingResultsRef: React.RefObject<Map<string, { text: string; isError: boolean }>>
  toolPosRef: React.RefObject<Map<string, { mi: number; bi: number }>>
  historyOffsetRef: React.RefObject<number | undefined>
  gapReloadingRef: React.RefObject<boolean>
  seenIdsRef: React.RefObject<Set<string>>
}

export function useTranscriptIngest(opts: {
  isCodex: boolean
  sockRef: React.RefObject<SessionSocket | undefined>
  taskApi: TaskBucketsApi
}): {
  messages: ChatMsg[]
  draft: Draft | null
  phase: string | undefined
  initInfo: { model?: string; slashCommands?: string[] }
  permMode: string | undefined
  effort: string | undefined
  api: TranscriptIngestApi
} {
  const { isCodex, sockRef, taskApi } = opts
  const [messages, setMessages] = useState<ChatMsg[]>([])
  const [draft, setDraft] = useState<Draft | null>(null)
  // cli 流驱动的会话元数据（init/status 分支写入；WS status 事件与 E3 清空经 api setter 共用）
  const [phase, setPhase] = useState<string>()
  const [initInfo, setInitInfo] = useState<{ model?: string; slashCommands?: string[] }>({})
  const [permMode, setPermMode] = useState<string>()
  const [effort, setEffort] = useState<string>()

  // ref 镜像：事件处理器在 React 渲染外触发，直接基于 ref 计算，避免过期闭包/updater 双重调用
  const messagesRef = useRef<ChatMsg[]>([])
  const draftRef = useRef<Draft | null>(null)
  const pendingResultsRef = useRef(new Map<string, { text: string; isError: boolean }>())
  /** toolUseId → 落地位置索引：tool_result 配对的 O(1) 快路径（失效时回退线性扫描） */
  const toolPosRef = useRef(new Map<string, { mi: number; bi: number }>())
  /** 历史加载时服务端读到的 transcript 字节数，tail_subscribe 的起始偏移 */
  const historyOffsetRef = useRef<number | undefined>(undefined)
  /** replay_gap 正在重载历史：丢弃这段窗口内的 cli，避免和 applyHistory 对抄本抢写 */
  const gapReloadingRef = useRef(false)
  /** 已见消息身份（uuid / message.id / tool:id）。HTTP 历史与 live/补发重叠时靠它去重 */
  const seenIdsRef = useRef(new Set<string>())

  const setMsgs = (up: (prev: ChatMsg[]) => ChatMsg[]) => {
    messagesRef.current = up(messagesRef.current)
    setMessages(messagesRef.current)
  }
  const setDraftBoth = (d: Draft | null) => {
    draftRef.current = d
    setDraft(d)
  }
  const pushMsg = (m: ChatMsg) => {
    setMsgs((prev) => {
      // 建索引的同时消费乱序缓冲：结果早于工具块落地时（live 流常见）在此补齐
      const st: IngestState = { msgs: [...prev, m], toolIdx: toolPosRef.current, pending: pendingResultsRef.current }
      indexToolBlocks(st, st.msgs.length - 1)
      rememberKeys(seenIdsRef.current, [...transcriptKeys([m])])
      return st.msgs
    })
  }
  const pushSystem = (text: string, kind: 'info' | 'error' = 'info') =>
    pushMsg({ id: nextId(), role: 'system', systemKind: kind, blocks: [{ kind: 'text', text }] })

  /** 历史响应落到消息列表 + 从读取位置续订 tail（初次加载与 tail_reset 重载共用） */
  const applyHistory = (resp: HistoryResponse) => {
    historyOffsetRef.current = resp.fileBytes
    const st = createIngestState()
    for (const h of resp.messages) appendHistoryMsg(st, h)
    // 批次收尾：整批读完仍未配对的才是真孤儿（批内乱序此时已修复）
    flushStrayResults(st)
    const out = st.msgs
    setMsgs(() => out)
    // 实时配对索引与乱序缓冲直接沿用历史加载建好的（out 已成为新 state）
    toolPosRef.current = st.toolIdx
    pendingResultsRef.current = st.pending
    seenIdsRef.current = transcriptKeys(out)

    // 子代理侧链进桶；终态/报告以主线 Agent 工具卡的配对结果为准（tool_result 已落盘 = 已完成）
    //（清桶 + 未完成 subagent 回填的实现已随桶下沉 hooks/useTaskBuckets.ts）
    taskApi.resetFromHistory(out, resp)

    // 从历史读取位置续订 transcript 追加（外部会话的实时更新）；socket 未 open 时会排队
    // codex 的实时流走 app-server 订阅（attach 即 resume），无 tailer
    if (!isCodex) sockRef.current?.send({ kind: 'tail_subscribe', from: resp.fileBytes })
  }

  /** 会话切换重置（E3 组合层调用；顺序即原 E3 清空段前 7 步） */
  const reset = () => {
    setMsgs(() => [])
    setDraftBoth(null)
    pendingResultsRef.current.clear()
    toolPosRef.current.clear()
    seenIdsRef.current.clear()
    historyOffsetRef.current = undefined
    gapReloadingRef.current = false
  }

  // ---------- 流式草稿 ----------

  /** message_stop / result 时把草稿固化为一条 assistant 消息 */
  const commitDraft = () => {
    const d = draftRef.current
    if (!d) return
    setDraftBoth(null)
    if (d.blocks.length === 0) return
    const blocks: Block[] = []
    for (const b of d.blocks) {
      if (b.kind === 'tool') {
        let input: unknown
        try {
          input = b.jsonBuf ? JSON.parse(b.jsonBuf) : undefined
        } catch {}
        const toolId = b.toolId ?? nextId()
        const held = pendingResultsRef.current.get(toolId)
        if (held) pendingResultsRef.current.delete(toolId)
        blocks.push({
          kind: 'tool',
          id: toolId,
          name: b.name ?? '?',
          input,
          pending: !held,
          resultText: held?.text,
          resultError: held?.isError,
        })
      } else if (b.text.trim()) {
        blocks.push({ kind: b.kind, text: b.text })
      }
    }
    if (blocks.length > 0) pushMsg({ id: d.msgId ?? nextId(), role: 'assistant', blocks })
  }

  /** tool_result 配对到已渲染的工具卡片；工具块还在草稿里则暂存（归并实现见 lib/ingest） */
  const pairToolResult = (toolUseId: string | undefined, text: string, isError: boolean) => {
    if (!toolUseId) return
    setMsgs((prev) => {
      const r = pairToolResultIn(prev, toolPosRef.current, toolUseId, text, isError)
      if (!r.paired) pendingResultsRef.current.set(toolUseId, { text, isError })
      return r.msgs
    })
  }

  // ---------- CLI 消息处理 ----------
  const handleCli = (msg: CliMsg, replay = false) => {
    const rec = msg as Record<string, unknown>

    // 流式增量事件（Anthropic API SSE 透传）
    if (msg.type === 'stream_event') {
      const ev = rec.event as
        | {
            type?: string
            index?: number
            message?: { id?: string }
            content_block?: { type?: string; id?: string; name?: string }
            delta?: { type?: string; text?: string; thinking?: string; partial_json?: string }
          }
        | undefined
      if (!ev?.type) return
      switch (ev.type) {
        case 'message_start':
          setDraftBoth({ msgId: ev.message?.id, blocks: [] })
          break
        case 'content_block_start': {
          const t = ev.content_block?.type
          const d: Draft = draftRef.current ?? { blocks: [] }
          const idx = ev.index ?? d.blocks.length
          if (!d.blocks.some((b) => b.idx === idx)) {
            d.blocks.push({
              idx,
              kind: t === 'thinking' ? 'thinking' : t === 'tool_use' ? 'tool' : 'text',
              text: '',
              toolId: ev.content_block?.id,
              name: ev.content_block?.name,
              jsonBuf: t === 'tool_use' ? '' : undefined,
            })
            d.blocks.sort((a, b) => a.idx - b.idx)
            setDraftBoth({ ...d })
          }
          break
        }
        case 'content_block_delta': {
          const delta = ev.delta
          if (!delta) break
          const d: Draft = draftRef.current ?? { blocks: [] }
          const idx = ev.index ?? d.blocks.length - 1
          let b = d.blocks.find((x) => x.idx === idx)
          if (!b) {
            b = { idx, kind: 'text', text: '' }
            d.blocks.push(b)
            d.blocks.sort((a, z) => a.idx - z.idx)
          }
          if (delta.type === 'text_delta' && delta.text) b.text += delta.text
          else if (delta.type === 'thinking_delta' && delta.thinking) {
            b.kind = 'thinking'
            b.text += delta.thinking
          } else if (delta.type === 'input_json_delta' && delta.partial_json) b.jsonBuf = (b.jsonBuf ?? '') + delta.partial_json
          // signature_delta 永不展示
          setDraftBoth({ ...d, blocks: [...d.blocks] })
          break
        }
        case 'message_stop':
          commitDraft()
          break
        // content_block_stop / message_delta 无需处理（assistant 快照与 result 会收尾）
      }
      return
    }

    if (msg.type === 'control_response') {
      const resp = rec.response as { subtype?: string; error?: string } | undefined
      if (resp?.subtype === 'error') pushSystem(`⚠ ${resp.error ?? '控制请求失败'}`, 'error')
      return
    }

    if (msg.type === 'assistant') {
      if (taskApi.appendSidechain(rec)) return
      const content = msg.message?.content
      const blocks = Array.isArray(content) ? content : []
      const msgId = (rec.message as { id?: string } | undefined)?.id
      const d = draftRef.current
      if (!d || msgId !== d.msgId) {
        const toolIds = blocks.filter((c) => c?.type === 'tool_use' && c.id).map((c) => String(c.id))
        const keys = liveMessageKeys({ uuid: msg.uuid, messageId: msgId, toolIds })
        // uuid / message.id / 工具块 id 任一已在抄本（HTTP 历史或先前 live）即跳过——
        // 旧实现只比 message.id，而落盘 id 是 uuid，Codex 甚至没有 uuid，重连补发会重复气泡
        if (hitsSeen(seenIdsRef.current, keys)) return
        // 没有对应草稿（如中途接入）：直接落为完整消息
        const direct: Block[] = []
        for (const c of blocks) {
          if (c?.type === 'text' && c.text?.trim()) direct.push({ kind: 'text', text: c.text })
          else if (c?.type === 'thinking' && c.thinking?.trim()) direct.push({ kind: 'thinking', text: c.thinking })
          else if (c?.type === 'tool_use')
            direct.push({ kind: 'tool', id: c.id ?? nextId(), name: c.name ?? '?', input: c.input, pending: true })
        }
        if (direct.length > 0) pushMsg({ id: msg.uuid ?? msgId ?? nextId(), role: 'assistant', blocks: direct })
        return
      }
      // 块快照：把草稿中对应的增量块定稿（去重关键：同 message.id 同 kind 按序匹配）
      const dblocks = d.blocks.map((b) => ({ ...b }))
      for (const c of blocks) {
        const kind = c?.type === 'thinking' ? 'thinking' : c?.type === 'tool_use' ? 'tool' : 'text'
        const b = dblocks.find((x) => !x.finalized && x.kind === kind && (kind !== 'tool' || !c.id || x.toolId === c.id))
        if (!b) continue
        b.finalized = true
        if (c?.type === 'text' && c.text) b.text = c.text
        else if (c?.type === 'thinking' && c.thinking) b.text = c.thinking
        else if (c?.type === 'tool_use') {
          b.name = c.name ?? b.name
          b.toolId = c.id ?? b.toolId
          b.jsonBuf = c.input != null ? JSON.stringify(c.input) : b.jsonBuf
        }
      }
      setDraftBoth({ ...d, blocks: dblocks })
      return
    }

    if (msg.type === 'user') {
      if (msg.isMeta) return
      // codex 工具输出的流式部分结果：更新运行中工具卡的文本，但不做任何终态动作
      //（不 settle 桶、不进乱序缓冲、不标 seen——终态 tool_result 随后走正常路径收尾）
      if (rec.partial === true) {
        const content = msg.message?.content
        const blocks = Array.isArray(content) ? content : []
        for (const c of blocks) {
          if (c?.type === 'tool_result') {
            const id = c.tool_use_id as string | undefined
            const text = toolResultText(c.content)
            if (!id) continue
            setMsgs((prev) => pairToolResultPartialIn(prev, toolPosRef.current, id, text).msgs)
          }
        }
        return
      }
      if (taskApi.appendSidechain(rec)) return
      const content = msg.message?.content
      const blocks = Array.isArray(content) ? content : typeof content === 'string' ? [{ type: 'text', text: content }] : []
      const textBlocks: Block[] = []
      for (const c of blocks) {
        if (c?.type === 'tool_result') {
          const resultText = toolResultText(c.content)
          pairToolResult(c.tool_use_id, resultText, c.is_error === true)
          // 主线 Agent tool_result 是子代理的终态兜底（正常路径是 task_notification 先到）
          taskApi.settleBucketFromResult(c.tool_use_id, resultText, c.is_error === true)
        } else if (c?.type === 'text' && c.text?.trim()) {
          // /goal 的评估器反馈（Stop hook）：goal 循环内的中途评估，渲染为系统提示而非用户气泡
          if (c.text.startsWith('Stop hook feedback:')) {
            const body = c.text.replace(/^Stop hook feedback:\s*/, '')
            pushSystem(`◎ 目标评估：${body.slice(0, 300)}`)
            continue
          }
          textBlocks.push({ kind: 'text', text: c.text })
        }
      }
      if (textBlocks.length > 0) {
        const keys = liveMessageKeys({ uuid: msg.uuid })
        if (hitsSeen(seenIdsRef.current, keys)) return
        pushMsg({ id: msg.uuid ?? nextId(), role: 'user', blocks: textBlocks })
      }
      return
    }

    if (msg.type === 'system') {
      switch (msg.subtype) {
        case 'init': {
          const slash = Array.isArray(rec.slash_commands) ? (rec.slash_commands as string[]) : undefined
          setInitInfo({ model: rec.model as string | undefined, slashCommands: slash })
          setPermMode(rec.permissionMode as string | undefined)
          break
        }
        case 'status': {
          // status 是 string|null（如 "requesting"/"compacting"），不是对象——勿迭代
          const st = rec.status
          setPhase(typeof st === 'string' ? st : undefined)
          if (typeof rec.permissionMode === 'string') setPermMode(rec.permissionMode)
          break
        }
        case 'thinking_tokens':
          break // 增量 token 估算，不展示
        case 'task_started': {
          // 生命周期事件是桶的主注册点（实现在 hooks/useTaskBuckets.ts）
          taskApi.taskStarted(rec)
          if (!replay) pushSystem(`⚙ 后台任务启动：${String(rec.description ?? '')}`)
          break
        }
        case 'task_progress': {
          taskApi.taskProgress(rec)
          break
        }
        case 'task_updated': {
          taskApi.taskUpdated(rec)
          break
        }
        case 'task_notification': {
          const summary = typeof rec.summary === 'string' ? rec.summary : ''
          taskApi.taskNotification(rec)
          if (!replay) pushSystem(`⚙ 后台任务完成${summary ? `：${summary.slice(0, 200)}` : ''}`)
          break
        }
        case 'compact_boundary': {
          if (replay) break
          const meta = (rec.compactMetadata ?? {}) as { preTokens?: number; postTokens?: number }
          pushMsg({ id: nextId(), role: 'system', systemKind: 'divider', compactMeta: meta, blocks: [] })
          break
        }
      }
      return
    }

    if (msg.type === 'result') {
      commitDraft()
      setPhase(undefined)
      // 补发的旧 result 已在 HTTP 历史里，再落「本轮」会在底部堆出一串重复页脚
      if (replay) return
      if (msg.uuid && hitsSeen(seenIdsRef.current, [msg.uuid])) return
      if (msg.uuid) rememberKeys(seenIdsRef.current, [msg.uuid])
      const isErr = rec.is_error === true
      const dur = typeof rec.duration_ms === 'number' ? `${Math.round(rec.duration_ms / 1000)}s` : undefined
      const usage = rec.usage as { output_tokens?: number } | undefined
      const parts = [dur, usage?.output_tokens != null ? `${usage.output_tokens} tok` : undefined].filter(Boolean)
      if (isErr) {
        pushSystem(`⚠ ${String(rec.result ?? rec.subtype ?? '执行出错')}`, 'error')
      } else if (parts.length > 0) {
        pushSystem(`─ 本轮 ${parts.join(' · ')}`)
      }
      return
    }
  }

  return {
    messages,
    draft,
    phase,
    initInfo,
    permMode,
    effort,
    api: {
      setPhase,
      setPermMode,
      setInitInfo,
      setEffort,
      setMsgs,
      setDraftBoth,
      pushMsg,
      pushSystem,
      commitDraft,
      handleCli,
      applyHistory,
      reset,
      messagesRef,
      draftRef,
      pendingResultsRef,
      toolPosRef,
      historyOffsetRef,
      gapReloadingRef,
      seenIdsRef,
    },
  }
}
