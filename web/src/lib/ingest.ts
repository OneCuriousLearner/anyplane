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

function patched(m: ChatMsg, bi: number, text: string, isError: boolean): ChatMsg {
  const blocks = [...m.blocks]
  const b = blocks[bi]
  if (b?.kind === 'tool') blocks[bi] = { ...b, resultText: text, resultError: isError, pending: false }
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
