// 消息 ingest 归并：**live 流 / tail 追加 / 历史批量加载三条入口共用的唯一实现**。
//
// 为什么必须共用：三处曾各有一套 tool_use ↔ tool_result 配对，行为并不一致——
// live 路径有乱序缓冲（结果先于工具块到达时暂存），history/tail 路径没有，直接把
// 先到的结果降级成孤立系统提示且**永不修复**。同一份转录经不同入口进来会长得不一样。
//
// 统一口径：配对失败一律进 pending 缓冲；工具块落地时反查缓冲补齐；只有在批次收尾
// （flushStrayResults）时仍未配对的，才作为孤立结果降级展示——那才是真正的孤儿。

import type { HistoryMessage } from './api'
import { type Block, type ChatMsg, nextId } from './blocks'

/** toolUseId → 消息/块下标。rewind 截断等会使其失效，配对时须校验 */
export interface ToolPos {
  mi: number
  bi: number
}

export interface PendingResult {
  text: string
  isError: boolean
}

/** 归并状态。msgs 恒做不可变更新（与 React state 共享对象，禁止原地改） */
export interface IngestState {
  msgs: ChatMsg[]
  toolIdx: Map<string, ToolPos>
  /** 先于 tool_use 到达的结果，等工具块落地再补 */
  pending: Map<string, PendingResult>
}

export function createIngestState(msgs: ChatMsg[] = []): IngestState {
  return { msgs, toolIdx: new Map(), pending: new Map() }
}

function patched(m: ChatMsg, bi: number, text: string, isError: boolean, keepPending = false): ChatMsg {
  const blocks = [...m.blocks]
  const b = blocks[bi]
  if (b?.kind === 'tool') {
    blocks[bi] = keepPending
      ? { ...b, resultText: text, resultError: isError }
      : { ...b, resultText: text, resultError: isError, pending: false }
  }
  return { ...m, blocks }
}

/**
 * 把 tool_result 配对到已落地的工具卡。O(1) 走 toolIdx，索引失效时回退倒序线性扫描
 * （倒序：结果通常紧跟最近的调用）。返回是否配对成功；msgs 不可变更新。
 */
export function pairToolResultIn(
  msgs: ChatMsg[],
  toolIdx: Map<string, ToolPos> | undefined,
  toolUseId: string | undefined,
  text: string,
  isError: boolean,
): { msgs: ChatMsg[]; paired: boolean } {
  if (!toolUseId) return { msgs, paired: false }
  const at = toolIdx?.get(toolUseId)
  const hit = at ? msgs[at.mi]?.blocks[at.bi] : undefined
  if (at && hit?.kind === 'tool' && hit.id === toolUseId) {
    const out = [...msgs]
    out[at.mi] = patched(out[at.mi], at.bi, text, isError)
    return { msgs: out, paired: true }
  }
  for (let mi = msgs.length - 1; mi >= 0; mi--) {
    const bi = msgs[mi].blocks.findIndex((b) => b.kind === 'tool' && b.id === toolUseId)
    if (bi < 0) continue
    const out = [...msgs]
    out[mi] = patched(out[mi], bi, text, isError)
    return { msgs: out, paired: true }
  }
  return { msgs, paired: false }
}

/** 部分结果在卡片上的累积上限（append 模式尾留）：只影响运行中展示，终态全文照常替换 */
const PARTIAL_TEXT_CAP = 64 * 1024

/**
 * codex 工具输出的流式部分结果（partial tool_result）：更新卡片文本但**保持运行态**
 * （pending 不动、不改 resultError、不进乱序缓冲——部分结果不配对的直接丢弃，
 *  下一拍 partial 或终态结果会自愈，缓冲反而可能把过期部分结果补到终态之后）。
 * append=true（命令输出流）：文本追加到现有部分结果上（尾留 PARTIAL_TEXT_CAP）；
 * append 缺省（MCP 进度）：整体替换。
 */
export function pairToolResultPartialIn(
  msgs: ChatMsg[],
  toolIdx: Map<string, ToolPos> | undefined,
  toolUseId: string | undefined,
  text: string,
  append?: boolean,
): { msgs: ChatMsg[]; paired: boolean } {
  if (!toolUseId) return { msgs, paired: false }
  const nextText = (cur: string | undefined): string => {
    if (!append) return text
    const joined = (cur ?? '') + text
    return joined.length > PARTIAL_TEXT_CAP ? joined.slice(-PARTIAL_TEXT_CAP) : joined
  }
  const at = toolIdx?.get(toolUseId)
  const hit = at ? msgs[at.mi]?.blocks[at.bi] : undefined
  if (at && hit?.kind === 'tool' && hit.id === toolUseId && hit.pending === true) {
    const out = [...msgs]
    out[at.mi] = patched(out[at.mi], at.bi, nextText(hit.resultText), false, true)
    return { msgs: out, paired: true }
  }
  for (let mi = msgs.length - 1; mi >= 0; mi--) {
    const bi = msgs[mi].blocks.findIndex((b) => b.kind === 'tool' && b.id === toolUseId)
    if (bi < 0) continue
    const blk = msgs[mi].blocks[bi]
    if (blk.kind !== 'tool' || blk.pending !== true) break // 已有终态，部分结果过期
    const out = [...msgs]
    out[mi] = patched(out[mi], bi, nextText(blk.kind === 'tool' ? blk.resultText : undefined), false, true)
    return { msgs: out, paired: true }
  }
  return { msgs, paired: false }
}

/** 配对；失败则缓冲等待对应 tool_use 落地。返回是否已配对（调用方可据此做终态兜底） */
export function ingestToolResult(
  state: IngestState,
  toolUseId: string | undefined,
  text: string,
  isError: boolean,
): boolean {
  if (!toolUseId) return false
  const r = pairToolResultIn(state.msgs, state.toolIdx, toolUseId, text, isError)
  state.msgs = r.msgs
  if (!r.paired) state.pending.set(toolUseId, { text, isError })
  return r.paired
}

/**
 * 登记刚落地消息里的工具块位置，并消费此前缓冲的结果（乱序修复点）。
 * mi 为该消息在 state.msgs 中的下标。
 */
export function indexToolBlocks(state: IngestState, mi: number): void {
  const m = state.msgs[mi]
  if (!m) return
  m.blocks.forEach((b, bi) => {
    if (b.kind !== 'tool') return
    state.toolIdx.set(b.id, { mi, bi })
    const held = state.pending.get(b.id)
    if (!held) return
    state.pending.delete(b.id)
    state.msgs = state.msgs.map((x, i) => (i === mi ? patched(state.msgs[i], bi, held.text, held.isError) : x))
  })
}

/** 追加一条消息并建索引（同时补齐乱序缓冲） */
export function pushIngestMsg(state: IngestState, m: ChatMsg): void {
  state.msgs = [...state.msgs, m]
  indexToolBlocks(state, state.msgs.length - 1)
}

/**
 * 历史翻页的 prepend 归并：更早一页铺到现有抄本前面。
 * 页内配对在临时 state 完成；随后合并两边乱序缓冲、全量重建工具索引——
 * indexToolBlocks 逐条落地时消费缓冲，跨页边界的配对（结果在本页、调用在旧页，
 * 或反之）在这一步自然完成。仍不配对的留在 pending，等更旧的页或批次收尾按既有规则浮现。
 */
export function prependHistoryMsgs(state: IngestState, hs: HistoryMessage[]): void {
  const earlier = createIngestState()
  for (const h of hs) appendHistoryMsg(earlier, h)
  if (earlier.msgs.length === 0) return
  state.pending = new Map([...earlier.pending, ...state.pending])
  state.msgs = [...earlier.msgs, ...state.msgs]
  state.toolIdx.clear()
  for (let mi = 0; mi < state.msgs.length; mi++) indexToolBlocks(state, mi)
}

/**
 * 历史/tail 的单条归并：把 HistoryMessage 翻成 ChatMsg 落进 state。
 * compact_boundary 渲染为分隔线；isMeta 不进主抄本。
 */
export function appendHistoryMsg(state: IngestState, h: HistoryMessage): void {
  if (h.isMeta) return
  if (h.role === 'system' && h.subtype === 'compact_boundary') {
    pushIngestMsg(state, {
      id: h.uuid ?? nextId(),
      role: 'system',
      systemKind: 'divider',
      compactMeta: h.compactMeta,
      blocks: [],
    })
    return
  }
  const blocks: Block[] = []
  // 同一条消息内的 tool_result 先收集：其 tool_use 可能就在本条消息的后面几个块里，
  // 必须等本条 push 进 state 并建索引之后再配对，否则又退化成孤立结果
  const results: { id?: string; text: string; isError: boolean }[] = []
  for (const hb of h.blocks) {
    if (hb.kind === 'tool_use') {
      blocks.push({ kind: 'tool', id: hb.id ?? nextId(), name: hb.name ?? '?', input: hb.input })
    } else if (hb.kind === 'tool_result') {
      results.push({ id: hb.id, text: hb.text ?? '', isError: hb.isError === true })
    } else if (hb.kind === 'image' && hb.src) {
      blocks.push({ kind: 'image', src: hb.src })
    } else if (hb.kind === 'text' || hb.kind === 'thinking') {
      blocks.push({ kind: hb.kind, text: hb.text ?? '' })
    }
  }
  if (blocks.length > 0) {
    pushIngestMsg(state, {
      id: h.uuid ?? nextId(),
      role: h.role,
      blocks,
      timestamp: h.timestamp,
      rewindable: h.rewindable,
    })
  }
  for (const r of results) ingestToolResult(state, r.id, r.text, r.isError)
}

/**
 * 批次收尾：仍未配对的缓冲结果降级为孤立系统提示。
 * 只在一批加载/一次 tail flush 结束时调用——批内乱序此时已自然修复，剩下的才是真孤儿。
 */
/** live / 补发去重键：uuid、assistant message.id、工具块 id 任一已在抄本即视为已见。
 *  历史走 HTTP、重连 fromSeq=0 回放整环时，这是防止重复气泡的唯一兜底。 */
export function liveMessageKeys(input: {
  uuid?: string
  messageId?: string
  toolIds?: string[]
}): string[] {
  const keys: string[] = []
  if (input.uuid) keys.push(input.uuid)
  if (input.messageId) keys.push(input.messageId)
  for (const t of input.toolIds ?? []) if (t) keys.push(`tool:${t}`)
  return keys
}

export function transcriptKeys(msgs: ChatMsg[]): Set<string> {
  const s = new Set<string>()
  for (const m of msgs) {
    if (m.id) s.add(m.id)
    for (const b of m.blocks) {
      if (b.kind === 'tool' && b.id) s.add(`tool:${b.id}`)
    }
  }
  return s
}

export function hitsSeen(seen: Set<string>, keys: string[]): boolean {
  return keys.length > 0 && keys.some((k) => seen.has(k))
}

export function rememberKeys(seen: Set<string>, keys: string[]): void {
  for (const k of keys) seen.add(k)
}

export function flushStrayResults(state: IngestState): void {
  if (state.pending.size === 0) return
  for (const [, r] of state.pending) {
    state.msgs = [
      ...state.msgs,
      {
        id: nextId(),
        role: 'system',
        systemKind: r.isError ? 'error' : 'info',
        blocks: [{ kind: 'text', text: r.text.slice(0, 500) }],
      },
    ]
  }
  state.pending.clear()
}

/**
 * codex 子代理桶的终态拉取合并（useTaskBuckets 调用）：历史拉取是权威全序，
 * 但上游 legacy thread/read 不返回 commandExecution/collabAgentToolCall 等工具项
 * （0.148 实测），全量重建会把 live 转发来的工具卡抹掉——所以按锚点合并：
 * 「第一条同时存在于两处的消息」为锚，锚前缺失项按历史序前插，锚后缺失项
 * （注册间隙丢的洞）追加；无交集时历史整体前插（桶空等价全量重建）。
 * 返回重建后的 IngestState 与本次拉取的全部 uuid（调用方据此刷新去重集）；
 * 无新增返回 null。
 */
export function mergeTerminalHistoryState(
  base: ChatMsg[],
  fetched: HistoryMessage[],
): { state: IngestState; fetchedUuids: Set<string> } | null {
  if (fetched.length === 0) return null
  const liveIds = new Set(base.map((m) => m.id))
  const anchorPos = fetched.findIndex((h) => h.uuid && liveIds.has(h.uuid))
  const missing = (h: HistoryMessage) => !h.uuid || !liveIds.has(h.uuid)
  const prefixSrc = (anchorPos < 0 ? fetched : fetched.slice(0, anchorPos)).filter(missing)
  const suffixSrc = anchorPos < 0 ? [] : fetched.slice(anchorPos + 1).filter(missing)
  if (prefixSrc.length === 0 && suffixSrc.length === 0) return null
  const toMsgs = (list: HistoryMessage[]): ChatMsg[] => {
    const st = createIngestState()
    for (const h of list) appendHistoryMsg(st, h)
    return st.msgs
  }
  const st = createIngestState()
  for (const m of [...toMsgs(prefixSrc), ...base, ...toMsgs(suffixSrc)]) pushIngestMsg(st, m)
  return {
    state: st,
    fetchedUuids: new Set(fetched.map((h) => h.uuid).filter((u): u is string => Boolean(u))),
  }
}
