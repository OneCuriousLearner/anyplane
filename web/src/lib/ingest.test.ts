import { describe, expect, test } from 'bun:test'
import type { HistoryMessage } from './api'
import type { ToolBlock } from './blocks'
import {
  appendHistoryMsg,
  createIngestState,
  flushStrayResults,
  ingestToolResult,
  pairToolResultIn,
  pushIngestMsg,
} from './ingest'

const toolUse = (id: string, name = 'Bash'): HistoryMessage => ({
  uuid: `u-${id}`,
  role: 'assistant',
  blocks: [{ kind: 'tool_use', id, name }],
})
const toolResult = (id: string, text = `out-${id}`, isError = false): HistoryMessage => ({
  uuid: `r-${id}`,
  role: 'user',
  blocks: [{ kind: 'tool_result', id, text, isError }],
})

/** 抽出所有工具块（跨消息），用于比较不同事件序下的最终形态 */
function toolBlocksOf(msgs: { blocks: { kind: string }[] }[]): ToolBlock[] {
  return msgs.flatMap((m) => m.blocks.filter((b): b is ToolBlock => b.kind === 'tool'))
}

describe('ingest：tool_use ↔ tool_result 配对', () => {
  test('顺序到达即配对，pending 清空', () => {
    const s = createIngestState()
    appendHistoryMsg(s, toolUse('t1'))
    appendHistoryMsg(s, toolResult('t1'))
    expect(s.pending.size).toBe(0)
    const [b] = toolBlocksOf(s.msgs)
    expect(b).toMatchObject({ id: 't1', resultText: 'out-t1', resultError: false, pending: false })
  })

  test('结果先于调用到达时进缓冲，调用落地即补齐（旧 history 路径会永久降级成孤立提示）', () => {
    const s = createIngestState()
    appendHistoryMsg(s, toolResult('t1'))
    expect(s.pending.size).toBe(1)
    expect(toolBlocksOf(s.msgs)).toHaveLength(0)

    appendHistoryMsg(s, toolUse('t1'))
    expect(s.pending.size).toBe(0)
    expect(toolBlocksOf(s.msgs)[0]).toMatchObject({ id: 't1', resultText: 'out-t1', pending: false })
    // 补齐之后 flush 不应再产生孤立提示
    const before = s.msgs.length
    flushStrayResults(s)
    expect(s.msgs).toHaveLength(before)
  })

  test('同一条消息内 tool_use 在 tool_result 之后也能配对', () => {
    const s = createIngestState()
    appendHistoryMsg(s, {
      uuid: 'mixed',
      role: 'assistant',
      blocks: [
        { kind: 'tool_result', id: 't1', text: 'out-t1' },
        { kind: 'tool_use', id: 't1', name: 'Bash' },
      ],
    })
    expect(s.pending.size).toBe(0)
    expect(toolBlocksOf(s.msgs)[0]).toMatchObject({ resultText: 'out-t1' })
  })

  test('真孤儿在 flush 时降级为系统提示，isError 决定样式', () => {
    const s = createIngestState()
    appendHistoryMsg(s, toolResult('ghost', 'boom', true))
    flushStrayResults(s)
    const last = s.msgs[s.msgs.length - 1]
    expect(last).toMatchObject({ role: 'system', systemKind: 'error' })
    expect(last.blocks[0]).toMatchObject({ kind: 'text', text: 'boom' })
    expect(s.pending.size).toBe(0)
  })

  test('孤立结果文本截断到 500 字符', () => {
    const s = createIngestState()
    appendHistoryMsg(s, toolResult('ghost', 'x'.repeat(900)))
    flushStrayResults(s)
    const last = s.msgs[s.msgs.length - 1]
    expect(last.blocks[0]).toMatchObject({ text: 'x'.repeat(500) })
  })

  test('toolIdx 失效（如 rewind 截断）时回退线性扫描仍能配对', () => {
    const s = createIngestState()
    appendHistoryMsg(s, toolUse('t1'))
    s.toolIdx.set('t1', { mi: 99, bi: 99 }) // 人为投毒索引
    const ok = ingestToolResult(s, 't1', 'via-scan', false)
    expect(ok).toBe(true)
    expect(toolBlocksOf(s.msgs)[0]).toMatchObject({ resultText: 'via-scan' })
  })

  test('未知 toolUseId / 空 id 不抛错', () => {
    const s = createIngestState()
    expect(ingestToolResult(s, undefined, 'x', false)).toBe(false)
    expect(s.pending.size).toBe(0)
    expect(pairToolResultIn([], undefined, 't', 'x', false).paired).toBe(false)
  })

  test('配对做不可变更新：旧数组与旧消息对象不被改写', () => {
    const s = createIngestState()
    appendHistoryMsg(s, toolUse('t1'))
    const snapshotMsgs = s.msgs
    const snapshotMsg = s.msgs[0]
    ingestToolResult(s, 't1', 'out', false)
    expect(s.msgs).not.toBe(snapshotMsgs)
    expect(s.msgs[0]).not.toBe(snapshotMsg)
    expect((snapshotMsg.blocks[0] as ToolBlock).resultText).toBeUndefined()
  })

  test('compact_boundary 落为分隔线并透传元数据；isMeta 不进抄本', () => {
    const s = createIngestState()
    appendHistoryMsg(s, {
      role: 'system',
      subtype: 'compact_boundary',
      blocks: [],
      compactMeta: { preTokens: 100, postTokens: 20 },
    })
    appendHistoryMsg(s, { role: 'user', blocks: [{ kind: 'text', text: '隐藏' }], isMeta: true })
    expect(s.msgs).toHaveLength(1)
    expect(s.msgs[0]).toMatchObject({ systemKind: 'divider', compactMeta: { preTokens: 100, postTokens: 20 } })
  })
})

describe('ingest 性质测试：任意事件序下最终形态恒等', () => {
  // 确定性 PRNG（mulberry32）：失败可复现，不引入外部依赖
  const rng = (seed: number) => () => {
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  const shuffle = <T,>(arr: T[], rand: () => number): T[] => {
    const a = [...arr]
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1))
      ;[a[i], a[j]] = [a[j], a[i]]
      }
    return a
  }

  test('N 对 tool_use/tool_result 任意打乱后，工具卡集合与结果文本完全一致', () => {
    const N = 12
    const ids = Array.from({ length: N }, (_, i) => `t${i}`)
    const events = [...ids.map((id) => toolUse(id)), ...ids.map((id) => toolResult(id))]

    // 基准：完全顺序（use 后紧跟 result）
    const ordered = createIngestState()
    for (const id of ids) {
      appendHistoryMsg(ordered, toolUse(id))
      appendHistoryMsg(ordered, toolResult(id))
    }
    flushStrayResults(ordered)
    const expected = new Map(toolBlocksOf(ordered.msgs).map((b) => [b.id, b.resultText]))
    expect(expected.size).toBe(N)

    for (let seed = 0; seed < 60; seed++) {
      const s = createIngestState()
      for (const ev of shuffle(events, rng(seed))) appendHistoryMsg(s, ev)
      flushStrayResults(s)

      const got = toolBlocksOf(s.msgs)
      expect(got).toHaveLength(N)
      for (const b of got) {
        expect(b.resultText).toBe(expected.get(b.id)!)
        expect(b.pending).toBe(false)
      }
      // 全部配对成功 → 不产生任何孤立系统提示
      expect(s.msgs.some((m) => m.role === 'system')).toBe(false)
      expect(s.pending.size).toBe(0)
    }
  })

  test('重复投递同一 tool_result 不产生重复卡片，结果幂等', () => {
    const s = createIngestState()
    appendHistoryMsg(s, toolUse('t1'))
    for (let i = 0; i < 5; i++) appendHistoryMsg(s, toolResult('t1', 'same'))
    flushStrayResults(s)
    expect(toolBlocksOf(s.msgs)).toHaveLength(1)
    expect(toolBlocksOf(s.msgs)[0].resultText).toBe('same')
    expect(s.msgs.some((m) => m.role === 'system')).toBe(false)
  })

  test('只有结果没有调用时，孤儿数与结果数一致（不多不少）', () => {
    const orphanIds = ['a', 'b', 'c']
    for (let seed = 0; seed < 20; seed++) {
      const s = createIngestState()
      for (const ev of shuffle(orphanIds.map((id) => toolResult(id)), rng(seed))) appendHistoryMsg(s, ev)
      flushStrayResults(s)
      expect(s.msgs.filter((m) => m.role === 'system')).toHaveLength(orphanIds.length)
    }
  })

  test('pushIngestMsg 追加的工具块同样消费乱序缓冲（live 路径入口）', () => {
    const s = createIngestState()
    ingestToolResult(s, 't9', 'early', false) // 结果先到（live 流常见：结果先于快照定稿）
    expect(s.pending.size).toBe(1)
    pushIngestMsg(s, { id: 'm1', role: 'assistant', blocks: [{ kind: 'tool', id: 't9', name: 'Bash' }] })
    expect(s.pending.size).toBe(0)
    expect(toolBlocksOf(s.msgs)[0]).toMatchObject({ resultText: 'early', pending: false })
  })
})
