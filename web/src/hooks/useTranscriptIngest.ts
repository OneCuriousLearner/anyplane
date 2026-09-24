// 主抄本 ingest hook：消息列表 + 流式草稿 + 配对/去重 ref + handleCli/applyHistory。
// F4 从 pages/Chat.tsx 切出；F5 把 cli 流驱动的会话元数据（phase/initInfo/permMode/effort）
// 一并内化——主要写入方本来就是本 hook 的 init/status/result 分支，setter 经 api 暴露给
// WS status 事件（useSessionSocket）与 E3 清空段（组合层）共用。
// 纪律：事件处理器在 React 渲染外触发（WS 回调）——messages/draft 走 store
//（lib/store.ts，13.4 批次 C1：ref+state 双写的正规化），其余纯内部坐标（配对索引/
// 去重集/分页游标）渲染不读，留 ref。api 对象每渲染重建但永不过期。
// E3（session.key 历史加载 effect）留 Chat 组合层：reset 先于建连的顺序纪律在那。

import { useRef, useState } from 'react'
import type { BackendCapabilities, HistoryResponse, SubagentHistory } from '@anyplane/protocol'
import { nextId, parseDraftJsonBuf, toolResultText, type Block, type ChatMsg } from '../lib/blocks'
import { createStore, useStore, type Store } from '../lib/store'
import {
  appendHistoryMsg,
  createIngestState,
  flushStrayResults,
  hitsSeen,
  indexToolBlocks,
  liveMessageKeys,
  pairToolResultIn,
  pairToolResultPartialIn,
  prependHistoryMsgs,
  rememberKeys,
  transcriptKeys,
  type IngestState,
} from '../lib/ingest'
import type { CliMsg } from '@anyplane/protocol'
import { cliIngestTypeOf } from '../lib/cliIngest'
import type { SessionSocket } from '../lib/ws'
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
  setDraft(d: Draft | null): void
  pushMsg(m: ChatMsg): void
  pushSystem(text: string, kind?: 'info' | 'error'): void
  /** message_stop / result 时把草稿固化为一条 assistant 消息 */
  commitDraft(): void
  handleCli(msg: CliMsg, replay?: boolean): void
  /** 历史响应落到消息列表 + 从读取位置续订 tail（初次加载与 tail_reset 重载共用） */
  applyHistory(resp: HistoryResponse): void
  /** 翻页加载的更早历史 prepend 到抄本前（服务端 before 游标语义，零重叠） */
  prependHistory(resp: HistoryResponse): void
  /** 会话切换重置（E3 组合层调用；顺序即原 E3 清空段前 7 步） */
  reset(): void
  // ref 出口：WS 事件分发需要直接读最新值（store 形态，.get()/.set()）
  messagesStore: Store<ChatMsg[]>
  draftStore: Store<Draft | null>
  pendingResultsRef: React.RefObject<Map<string, { text: string; isError: boolean }>>
  toolPosRef: React.RefObject<Map<string, { mi: number; bi: number }>>
  historyOffsetRef: React.RefObject<number | undefined>
  /** 分页游标（hasMore ≡ 非空）：idle 孤儿浮现的推迟闸门也读它 */
  historyBeforeRef: React.RefObject<number | undefined>
  gapReloadingRef: React.RefObject<boolean>
  seenIdsRef: React.RefObject<Set<string>>
  /** 分页纪元（applyHistory/reset 递增）：翻页响应的过期判定 */
  historyEpochRef: React.RefObject<number>
}

export function useTranscriptIngest(opts: {
  /** 会话能力（status 首帧后可知）：tailer === false 的后端不发 tail_subscribe；
   *  undefined（尚未收到 status）按既有行为发送——服务端无能力时 `?.` no-op 兜底 */
  capsRef: React.RefObject<BackendCapabilities | undefined>
  sockRef: React.RefObject<SessionSocket | undefined>
  taskApi: TaskBucketsApi
}): {
  messages: ChatMsg[]
  draft: Draft | null
  phase: string | undefined
  initInfo: { model?: string; slashCommands?: string[] }
  permMode: string | undefined
  effort: string | undefined
  /** claude 历史分页：已加载窗口之前服务端还有更早消息（codex 恒 false——其历史全量下发） */
  hasMoreHistory: boolean
  /** 下一页的 before 游标（事件处理器在渲染外触发，经 ref 读最新值） */
  historyBeforeRef: React.RefObject<number | undefined>
  api: TranscriptIngestApi
} {
  const { capsRef, sockRef, taskApi } = opts
  // messages/draft：store 容器（渲染外读写同点；实例用惰性 useState 保持跨渲染稳定）
  const [messagesStore] = useState(() => createStore<ChatMsg[]>([]))
  const [draftStore] = useState(() => createStore<Draft | null>(null))
  const messages = useStore(messagesStore)
  const draft = useStore(draftStore)
  // cli 流驱动的会话元数据（init/status 分支写入；WS status 事件与 E3 清空经 api setter 共用）
  const [phase, setPhase] = useState<string>()
  const [initInfo, setInitInfo] = useState<{ model?: string; slashCommands?: string[] }>({})
  const [permMode, setPermMode] = useState<string>()
  const [effort, setEffort] = useState<string>()

  // 纯内部坐标（渲染不读，留 ref）：配对索引 / 乱序缓冲 / 去重集 / 分页游标与纪元
  const pendingResultsRef = useRef(new Map<string, { text: string; isError: boolean }>())
  /** toolUseId → 落地位置索引：tool_result 配对的 O(1) 快路径（失效时回退线性扫描） */
  const toolPosRef = useRef(new Map<string, { mi: number; bi: number }>())
  /** 历史加载时服务端读到的 transcript 字节数，tail_subscribe 的起始偏移 */
  const historyOffsetRef = useRef<number | undefined>(undefined)
  /** replay_gap 正在重载历史：丢弃这段窗口内的 cli，避免和 applyHistory 对抄本抢写 */
  const gapReloadingRef = useRef(false)
  /** 已见消息身份（uuid / message.id / tool:id）。HTTP 历史与 live/补发重叠时靠它去重 */
  const seenIdsRef = useRef(new Set<string>())
  /** claude 历史分页游标与 hasMore 镜像（hasMore 走 state 驱动哨兵渲染，游标走 ref 供事件路径读最新） */
  const historyBeforeRef = useRef<number | undefined>(undefined)
  const [hasMoreHistory, setHasMoreHistory] = useState(false)
  /** 分页纪元：applyHistory/reset 递增。在途翻页响应落地前比对——纪元变了说明
   *  历史已被重载/重置（replay_gap、tail_reset、切会话），旧行号坐标系的响应必须作废 */
  const historyEpochRef = useRef(0)
  /** 首页下发的 subagents 全量清单留存：翻页响应不再带它，prepend 补建桶时复用 */
  const subagentsRef = useRef<SubagentHistory[]>([])

  const setMsgs = (up: (prev: ChatMsg[]) => ChatMsg[]) => {
    messagesStore.set(up)
  }
  const setDraft = (d: Draft | null) => {
    draftStore.set(d)
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

  /** 历史响应落到消息列表 + 从读取位置续订 tail（初次加载与 tail_reset/replay_gap 重载共用） */
  const applyHistory = (resp: HistoryResponse) => {
    // 纵深防御：api 层已拦非 2xx，这里再挡 200 但形状不符的应答——
    // 静默 return 会让人面对空白抄本无提示，抛错走调用方 catch 显示真实文案
    if (!Array.isArray(resp?.messages)) throw new Error('历史响应缺少 messages 字段')
    historyOffsetRef.current = resp.fileBytes
    historyBeforeRef.current = resp.nextBefore
    setHasMoreHistory(resp.hasMore === true)
    // 分页纪元递增：在途翻页响应（旧坐标系）据此判定作废——见 Chat loadEarlier 的 epoch 守卫
    historyEpochRef.current += 1
    subagentsRef.current = resp.subagents ?? []
    const st = createIngestState()
    for (const h of resp.messages) appendHistoryMsg(st, h)
    // 批次收尾：整批读完仍未配对的才是真孤儿（批内乱序此时已修复）。
    // 还有更早页未加载时不 flush——孤儿结果的 tool_use 可能在未加载页里，
    // 提前浮现成卡片会永久钉在抄本尾部（翻页补配对的路径见 prependHistoryMsgs）
    if (!resp.hasMore) flushStrayResults(st)
    const out = st.msgs
    setMsgs(() => out)
    // 实时配对索引与乱序缓冲直接沿用历史加载建好的（out 已成为新 state）
    toolPosRef.current = st.toolIdx
    pendingResultsRef.current = st.pending
    seenIdsRef.current = transcriptKeys(out)

    // 子代理侧链进桶；终态/报告以主线 Agent 工具卡的配对结果为准（tool_result 已落盘 = 已完成）
    //（清桶 + 未完成 subagent 回填的实现已随桶下沉 hooks/useTaskBuckets.ts）
    taskApi.resetFromHistory(out, resp)

    // 从历史读取位置续订 transcript 追加（外部会话的实时更新）；socket 未 open 时会排队。
    // 能力门控：已知无 tailer（codex 实时流走 app-server 订阅）不发；未知时按既有行为发送
    if (capsRef.current?.tailer !== false) sockRef.current?.send({ kind: 'tail_subscribe', from: resp.fileBytes })
  }

  /** 翻页 prepend：更早一页铺到抄本前。去重键并集（防 replay 重复），游标推进；
   *  新进入窗口的未完成 subagent 补建桶（add-only，不清已有的活桶） */
  const prependHistory = (resp: HistoryResponse) => {
    historyBeforeRef.current = resp.nextBefore
    setHasMoreHistory(resp.hasMore === true)
    let merged: ChatMsg[] | undefined
    setMsgs((prev) => {
      const st: IngestState = { msgs: prev, toolIdx: toolPosRef.current, pending: pendingResultsRef.current }
      prependHistoryMsgs(st, resp.messages)
      // prepend 合并乱序缓冲时更换了 Map 实例，ref 必须跟随（索引 Map 是原实例原地重建）
      pendingResultsRef.current = st.pending
      merged = st.msgs
      return st.msgs
    })
    for (const h of resp.messages) rememberKeys(seenIdsRef.current, liveMessageKeys({ uuid: h.uuid }))
    // 首页才下发的 subagents 全量清单在此复用：翻到更早页时，其 tool_use 新进入窗口的
    // 未完成 agent 补建桶（翻页响应本身不带 subagents）
    if (merged && resp.messages.length > 0) taskApi.backfillFromHistory(merged, subagentsRef.current)
  }

  /** 会话切换重置（E3 组合层调用；顺序即原 E3 清空段前 7 步） */
  const reset = () => {
    setMsgs(() => [])
    setDraft(null)
    pendingResultsRef.current.clear()
    toolPosRef.current.clear()
    seenIdsRef.current.clear()
    historyOffsetRef.current = undefined
    historyBeforeRef.current = undefined
    setHasMoreHistory(false)
    historyEpochRef.current += 1
    subagentsRef.current = []
    gapReloadingRef.current = false
  }

  // ---------- 流式草稿 ----------

  /** message_stop / result 时把草稿固化为一条 assistant 消息 */
  const commitDraft = () => {
    const d = draftStore.get()
    if (!d) return
    setDraft(null)
    if (d.blocks.length === 0) return
    const blocks: Block[] = []
    for (const b of d.blocks) {
      if (b.kind === 'tool') {
        const toolId = b.toolId ?? nextId()
        const held = pendingResultsRef.current.get(toolId)
        if (held) pendingResultsRef.current.delete(toolId)
        blocks.push({
          kind: 'tool',
          id: toolId,
          name: b.name ?? '?',
          input: parseDraftJsonBuf(b.jsonBuf),
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

  // ---------- CLI 消息处理（按 type 拆；handleCli 只分发） ----------

  const handleStreamEvent = (msg: CliMsg) => {
    const rec = msg as Record<string, unknown>
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
        setDraft({ msgId: ev.message?.id, blocks: [] })
        break
      case 'content_block_start': {
        const t = ev.content_block?.type
        const d: Draft = draftStore.get() ?? { blocks: [] }
        const idx = ev.index ?? d.blocks.length
        if (!d.blocks.some((b) => b.idx === idx)) {
          // store 纪律：blocks 也必须新引用——旧实现 push+sort 就地改后 {...d} 浅拷，
          // 新旧快照共享同一 blocks 数组（memo 到 draft.blocks 的消费方会拿到推送前的块表）
          const blocks = [
            ...d.blocks,
            {
              idx,
              kind: (t === 'thinking' ? 'thinking' : t === 'tool_use' ? 'tool' : 'text') as Draft['blocks'][number]['kind'],
              text: '',
              toolId: ev.content_block?.id,
              name: ev.content_block?.name,
              jsonBuf: t === 'tool_use' ? '' : undefined,
            },
          ].sort((a, b) => a.idx - b.idx)
          setDraft({ ...d, blocks })
        }
        break
      }
      case 'content_block_delta': {
        const delta = ev.delta
        if (!delta) break
        const cur: Draft = draftStore.get() ?? { blocks: [] }
        const idx = ev.index ?? cur.blocks.length - 1
        const existing = cur.blocks.find((x) => x.idx === idx)
        // store 纪律：blocks 与块对象都必须新引用——就地 push/就地改 text 会让新旧快照共享
        // 同一数组（content_block_start 分支注释有完整判例；React 并发的 getSnapshot
        // 一致性依赖不可变更新）
        if (delta.type === 'signature_delta') break // 永不展示
        let nextBlock: Draft['blocks'][number]
        if (!existing) {
          nextBlock =
            delta.type === 'thinking_delta'
              ? { idx, kind: 'thinking', text: String(delta.thinking ?? '') }
              : delta.type === 'input_json_delta'
                ? { idx, kind: 'text', text: '', jsonBuf: String(delta.partial_json ?? '') }
                : { idx, kind: 'text', text: String(delta.text ?? '') }
        } else {
          nextBlock =
            delta.type === 'thinking_delta'
              ? { ...existing, kind: 'thinking', text: existing.text + String(delta.thinking ?? '') }
              : delta.type === 'input_json_delta'
                ? { ...existing, jsonBuf: (existing.jsonBuf ?? '') + String(delta.partial_json ?? '') }
                : { ...existing, text: existing.text + String(delta.text ?? '') }
        }
        const blocks = existing
          ? cur.blocks.map((x) => (x.idx === idx ? nextBlock : x))
          : [...cur.blocks, nextBlock].sort((a, z) => a.idx - z.idx)
        setDraft({ ...cur, blocks })
        break
      }
      case 'message_stop':
        commitDraft()
        break
      // content_block_stop / message_delta 无需处理（assistant 快照与 result 会收尾）
    }
  }

  const handleAssistant = (msg: CliMsg) => {
    const rec = msg as Record<string, unknown>
    if (taskApi.appendSidechain(rec)) return
    const content = (rec.message as { content?: unknown } | undefined)?.content
    const blocks = Array.isArray(content) ? content : []
    const msgId = (rec.message as { id?: string } | undefined)?.id
    const d = draftStore.get()
    // 兜底草稿（中途接入没见过 message_start，msgId 为 undefined）与本轮快照同源，
    // 必须落入合并分支——否则快照直推一份、message_stop 的 commitDraft 再推一份，
    // 同一轮回复在抄本里渲染两次（且同 id 工具块互相污染配对）
    if (!d || (d.msgId !== undefined && msgId !== d.msgId)) {
      const toolIds = blocks.filter((c) => c?.type === 'tool_use' && c.id).map((c) => String(c.id))
      const keys = liveMessageKeys({ uuid: msg.uuid, messageId: msgId, toolIds })
      // uuid / message.id / 工具块 id 任一已在抄本（HTTP 历史或先前 live）即跳过——
      // 旧实现只比 message.id，而落盘 id 是 uuid，Codex 甚至没有 uuid，重连补发会重复气泡
      if (hitsSeen(seenIdsRef.current, keys)) return
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
    setDraft({ ...d, blocks: dblocks })
  }

  const handleUser = (msg: CliMsg) => {
    if (msg.isMeta) return
    const rec = msg as Record<string, unknown>
    // codex 工具输出的流式部分结果：更新运行中工具卡的文本，但不做任何终态动作
    //（不 settle 桶、不进乱序缓冲、不标 seen——终态 tool_result 随后走正常路径收尾）
    if (rec.partial === true) {
      const content = (rec.message as { content?: unknown } | undefined)?.content
      const blocks = Array.isArray(content) ? content : []
      const append = rec.append === true
      for (const c of blocks) {
        if (c?.type === 'tool_result') {
          const id = c.tool_use_id as string | undefined
          const text = toolResultText(c.content)
          if (!id) continue
          setMsgs((prev) => pairToolResultPartialIn(prev, toolPosRef.current, id, text, append).msgs)
        }
      }
      return
    }
    if (taskApi.appendSidechain(rec)) return
    const content = (rec.message as { content?: unknown } | undefined)?.content
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
  }

  const handleSystem = (msg: CliMsg, replay: boolean) => {
    const rec = msg as Record<string, unknown>
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
        // wire 上是 snake_case compact_metadata（SDK 正本 sdk.d.ts / 官方文档镜像）；
        // 上游根本没有 post_tokens——只取 preTokens，post 留 undefined（下一条
        // assistant usage 到达后上下文环形自愈，不在这里猜）。
        // codex 分两帧：先裸分隔线（时序位置正确），摘要扫盘后补发同 uuid 的补丁帧——按 id 合并
        const raw = (rec.compact_metadata ?? rec.compactMetadata ?? {}) as {
          trigger?: string
          pre_tokens?: number
          preTokens?: number
          summary?: string
        }
        const meta = {
          trigger: raw.trigger,
          preTokens: raw.pre_tokens ?? raw.preTokens,
          summary: raw.summary,
        }
        const id = typeof rec.uuid === 'string' ? `cb:${rec.uuid}` : undefined
        if (id) {
          const existing = messagesStore.get().find((m) => m.id === id)
          if (existing) {
            // 补丁帧：只补新到的字段（summary 后至），不冲掉已有的 preTokens 等
            setMsgs((prev) =>
              prev.map((m) =>
                m.id === id
                  ? {
                      ...m,
                      compactMeta: {
                        trigger: meta.trigger ?? m.compactMeta?.trigger,
                        preTokens: meta.preTokens ?? m.compactMeta?.preTokens,
                        postTokens: m.compactMeta?.postTokens,
                        summary: meta.summary ?? m.compactMeta?.summary,
                      },
                    }
                  : m,
              ),
            )
            break
          }
        }
        pushMsg({ id: id ?? nextId(), role: 'system', systemKind: 'divider', compactMeta: meta, blocks: [] })
        break
      }
    }
  }

  const handleResult = (msg: CliMsg, replay: boolean) => {
    const rec = msg as Record<string, unknown>
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
  }

  const handleCli = (msg: CliMsg, replay = false) => {
    const kind = cliIngestTypeOf(msg.type)
    if (!kind) return
    switch (kind) {
      case 'stream_event':
        handleStreamEvent(msg)
        return
      case 'control_response': {
        const resp = (msg as Record<string, unknown>).response as { subtype?: string; error?: string } | undefined
        if (resp?.subtype === 'error') pushSystem(`⚠ ${resp.error ?? '控制请求失败'}`, 'error')
        return
      }
      case 'assistant':
        handleAssistant(msg)
        return
      case 'user':
        handleUser(msg)
        return
      case 'system':
        handleSystem(msg, replay)
        return
      case 'result':
        handleResult(msg, replay)
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
    hasMoreHistory,
    historyBeforeRef,
    api: {
      setPhase,
      setPermMode,
      setInitInfo,
      setEffort,
      setMsgs,
      setDraft,
      pushMsg,
      pushSystem,
      commitDraft,
      handleCli,
      applyHistory,
      prependHistory,
      reset,
      messagesStore,
      draftStore,
      pendingResultsRef,
      toolPosRef,
      historyOffsetRef,
      historyBeforeRef,
      gapReloadingRef,
      seenIdsRef,
      historyEpochRef,
    },
  }
}
