// 下行 cli 事件补发的环形缓冲语义——直接测生产实现（cliReplay.ts），避免同构复制漂移。
// 关键不变量：补发不重不漏；环被挤爆时必须**明确报缺口**而不是悄悄少发几条；
// stream_event 不入环、不占序号，避免 token 流数秒内挤爆并误报缺口。

import { describe, expect, test } from 'bun:test'
import { CLI_RING_CAP, pushCliRing, replayCliSince, shouldRingCli, type CliRingState } from './cliReplay'

const mk = (): CliRingState => ({})

function pushDurable(h: CliRingState, n: number): number {
  const seq = pushCliRing(h, { kind: 'cli', msg: { type: 'assistant', n } })
  if (seq == null) throw new Error('durable cli 应入环')
  return seq
}

function replaySince(h: CliRingState, fromSeq: number): { sent: Record<string, unknown>[]; gap: boolean } {
  const sent: Record<string, unknown>[] = []
  const gap = replayCliSince(h, fromSeq, (p) => sent.push(p as Record<string, unknown>))
  return { sent, gap }
}

describe('shouldRingCli', () => {
  test('只入环 cli，且排除 stream_event', () => {
    expect(shouldRingCli({ kind: 'cli', msg: { type: 'assistant' } })).toBe(true)
    expect(shouldRingCli({ kind: 'cli', msg: { type: 'user' } })).toBe(true)
    expect(shouldRingCli({ kind: 'cli', msg: { type: 'result' } })).toBe(true)
    expect(shouldRingCli({ kind: 'cli', msg: { type: 'system' } })).toBe(true)
    expect(shouldRingCli({ kind: 'cli', msg: { type: 'stream_event' } })).toBe(false)
    expect(shouldRingCli({ kind: 'status' })).toBe(false)
    expect(shouldRingCli({ kind: 'replay_gap' })).toBe(false)
  })
})

describe('cli 事件环形缓冲与补发', () => {
  test('序号从 1 起单调递增，并写回 payload', () => {
    const h = mk()
    expect(pushDurable(h, 1)).toBe(1)
    expect(pushDurable(h, 2)).toBe(2)
    expect(h.cliRing?.map((e) => e.payload.seq)).toEqual([1, 2])
  })

  test('stream_event 不入环、不占序号、不写 seq', () => {
    const h = mk()
    const stream = { kind: 'cli', msg: { type: 'stream_event' } }
    expect(pushCliRing(h, stream)).toBeUndefined()
    expect(stream).not.toHaveProperty('seq')
    expect(h.cliRing).toBeUndefined()
    expect(pushDurable(h, 1)).toBe(1)
    expect(h.cliSeq).toBe(1)
  })

  test('补发只给 seq 大于高水位的部分（不重发已收到的）', () => {
    const h = mk()
    for (let i = 1; i <= 4; i++) pushDurable(h, i)
    const r = replaySince(h, 2)
    expect(r.sent.map((p) => (p.msg as { n: number }).n)).toEqual([3, 4])
    expect(r.gap).toBe(false)
    expect(r.sent.every((p) => p.replay === true)).toBe(true)
    // 不污染环内原件：live 广播过的 payload 不应被打上 replay
    expect(h.cliRing?.every((e) => e.payload.replay !== true)).toBe(true)
  })

  test('高水位已是最新时补发为空（重连但没错过任何事件）', () => {
    const h = mk()
    for (let i = 1; i <= 3; i++) pushDurable(h, i)
    expect(replaySince(h, 3)).toEqual({ sent: [], gap: false })
  })

  test('环未满时从 0 补发即全量（重连时 lastSeq 仍为 0 也要能取回）', () => {
    const h = mk()
    for (let i = 1; i <= 3; i++) pushDurable(h, i)
    const r = replaySince(h, 0)
    expect(r.sent).toHaveLength(3)
    expect(r.gap).toBe(false)
  })

  test('环容量封顶：只保留最近 CAP 条', () => {
    const h = mk()
    for (let i = 1; i <= CLI_RING_CAP + 3; i++) pushDurable(h, i)
    expect(h.cliRing).toHaveLength(CLI_RING_CAP)
    expect(h.cliRing?.[0].seq).toBe(4) // 1..3 已被挤掉
  })

  test('起点被挤掉时报缺口——这是本机制最重要的一条', () => {
    const h = mk()
    for (let i = 1; i <= CLI_RING_CAP + 3; i++) pushDurable(h, i)
    // 客户端停在 seq=2，而环底已是 4：中间第 3 条永久丢失
    const r = replaySince(h, 2)
    expect(r.gap).toBe(true)
    // 仍把能给的都给出去，但调用方必须据 gap 触发历史重载
    expect(r.sent.map((p) => p.seq)).toEqual(Array.from({ length: CLI_RING_CAP }, (_, i) => i + 4))
  })

  test('恰好衔接上环底时不算缺口（边界：fromSeq + 1 === 环底）', () => {
    const h = mk()
    for (let i = 1; i <= CLI_RING_CAP + 3; i++) pushDurable(h, i)
    expect(h.cliRing?.[0].seq).toBe(4)
    expect(replaySince(h, 3).gap).toBe(false) // 下一条正好是 4，无空洞
    expect(replaySince(h, 2).gap).toBe(true)
  })

  test('空环补发不报缺口（会话刚起、还没产生任何可落盘 cli 事件）', () => {
    expect(replaySince(mk(), 7)).toEqual({ sent: [], gap: false })
  })
})
