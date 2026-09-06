// 下行 cli 事件补发的环形缓冲语义。
// 这套机制对齐官方 bridge：序号高水位为权威、uuid 去重在前端兜底
//（claude-code src/bridge/replBridge.ts 的 lastTransportSequenceNum）。
// 关键不变量：补发不重不漏；环被挤爆时必须**明确报缺口**而不是悄悄少发几条——
// 后者会让前端抄本永久缺一段且毫无提示。

import { describe, expect, test } from 'bun:test'

/** 与 index.ts 的实现同构的最小模型（那边耦合 Hub/WS，此处只验语义） */
const CAP = 5

interface Ring {
  seq: number
  ring: Array<{ seq: number; payload: Record<string, unknown> }>
}

function push(h: Ring, payload: Record<string, unknown>): number {
  h.seq += 1
  payload.seq = h.seq
  h.ring.push({ seq: h.seq, payload })
  if (h.ring.length > CAP) h.ring.splice(0, h.ring.length - CAP)
  return h.seq
}

function replaySince(h: Ring, fromSeq: number): { sent: Record<string, unknown>[]; gap: boolean } {
  const sent: Record<string, unknown>[] = []
  if (h.ring.length === 0) return { sent, gap: false }
  const gap = h.ring[0].seq > fromSeq + 1
  for (const e of h.ring) if (e.seq > fromSeq) sent.push(e.payload)
  return { sent, gap }
}

const mk = (): Ring => ({ seq: 0, ring: [] })

describe('cli 事件环形缓冲与补发', () => {
  test('序号从 1 起单调递增，并写回 payload', () => {
    const h = mk()
    expect(push(h, { kind: 'cli', n: 1 })).toBe(1)
    expect(push(h, { kind: 'cli', n: 2 })).toBe(2)
    expect(h.ring.map((e) => e.payload.seq)).toEqual([1, 2])
  })

  test('补发只给 seq 大于高水位的部分（不重发已收到的）', () => {
    const h = mk()
    for (let i = 1; i <= 4; i++) push(h, { kind: 'cli', n: i })
    const r = replaySince(h, 2)
    expect(r.sent.map((p) => p.n)).toEqual([3, 4])
    expect(r.gap).toBe(false)
  })

  test('高水位已是最新时补发为空（重连但没错过任何事件）', () => {
    const h = mk()
    for (let i = 1; i <= 3; i++) push(h, { kind: 'cli', n: i })
    expect(replaySince(h, 3)).toEqual({ sent: [], gap: false })
  })

  test('环未满时从 0 补发即全量（首连不该走这条，但语义要成立）', () => {
    const h = mk()
    for (let i = 1; i <= 3; i++) push(h, { kind: 'cli', n: i })
    const r = replaySince(h, 0)
    expect(r.sent).toHaveLength(3)
    expect(r.gap).toBe(false)
  })

  test('环容量封顶：只保留最近 CAP 条', () => {
    const h = mk()
    for (let i = 1; i <= CAP + 3; i++) push(h, { kind: 'cli', n: i })
    expect(h.ring).toHaveLength(CAP)
    expect(h.ring[0].seq).toBe(4) // 1..3 已被挤掉
  })

  test('起点被挤掉时报缺口——这是本机制最重要的一条', () => {
    const h = mk()
    for (let i = 1; i <= CAP + 3; i++) push(h, { kind: 'cli', n: i })
    // 客户端停在 seq=2，而环底已是 4：中间第 3 条永久丢失
    const r = replaySince(h, 2)
    expect(r.gap).toBe(true)
    // 仍把能给的都给出去，但调用方必须据 gap 触发历史重载
    expect(r.sent.map((p) => p.seq)).toEqual([4, 5, 6, 7, 8])
  })

  test('恰好衔接上环底时不算缺口（边界：fromSeq + 1 === 环底）', () => {
    const h = mk()
    for (let i = 1; i <= CAP + 3; i++) push(h, { kind: 'cli', n: i })
    expect(h.ring[0].seq).toBe(4)
    expect(replaySince(h, 3).gap).toBe(false) // 下一条正好是 4，无空洞
    expect(replaySince(h, 2).gap).toBe(true)
  })

  test('空环补发不报缺口（会话刚起、还没产生任何 cli 事件）', () => {
    expect(replaySince(mk(), 7)).toEqual({ sent: [], gap: false })
  })
})
