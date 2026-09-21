// 接力编排（runHandoff）的高风险边界：
// - 同步拒绝：同后端 / claude 源缺 cwd / 源会话无消息
// - 异步成功流：pending → brief → done 事件序列、播种文案、三层重键、血缘落盘
// - 目标占用守卫：有客户端或活会话拒绝、死残留清身份后复用
// - sowing 并发互斥：同 cwd+backend 第二单即时拒绝，第一单不受影响
// - 失败清理：fork 抛错后无客户端无存活句柄的残留 Hub 被摘除
// 血缘落盘经 setLineageFileForTest 重定向到临时文件——绝不触碰真实 ~/.anyplane。

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { LineageRecord } from '@anyplane/protocol'
import { claudePort } from '../backends/claude/port'
import { codexPort } from '../backends/codex/port'
import { type BackendPort, registerBackend } from '../backends/port'
import { type HandoffDetail, seedMessage, setLineageFileForTest } from '../lineage'
import { sanitizePath } from '../util'
import { runHandoff } from './handoff'
import { getHub, hubs } from './registry'
import type { Hub } from './types'

const FROM_KEY = 'x|thread-handoff-src'
const CWD = '/tmp/handoff-proj'
const TARGET_KEY = `n|${encodeURIComponent(CWD)}`
const RESOLVED_TARGET = `s|${sanitizePath(CWD)}|target-sid-1`

interface FakeWs {
  sent: string[]
  data: { key: string; inbox?: true }
  send(text: string): void
}

function fakeWs(key: string): FakeWs {
  return { sent: [], data: { key }, send(text: string) { this.sent.push(text) } }
}

function payloads(ws: FakeWs): Array<Record<string, unknown>> {
  return ws.sent.map((text) => JSON.parse(text) as Record<string, unknown>)
}

/** fake port 探针：handoff 编排只经 BackendPort 面接触后端，全部调用留痕供断言 */
interface PortProbe {
  /** handoffSource 的应答表：key → cwd/sourceId（缺席默认 FROM_KEY 的 codex 源形状） */
  sources: Record<string, { cwd?: string; sourceId?: string }>
  handoffCwdOfCalls: Array<[string, string]>
  forkBriefCalls: Array<[string, string, string, HandoffDetail]>
  seedCalls: Array<{ hub: Hub; seed: string }>
  rekeyCalls: Array<[string, string, string]>
  liveKeys: Set<string>
  /** 置位后 forkBriefForHandoff 悬挂到此 promise（sowing 互斥用） */
  forkGate?: Promise<void>
  forkError?: Error
  /** 置位后 handoffCwdOf 返回 undefined（cwd 惰性解析失败用例） */
  cwdOfFails?: boolean
}

function fakePort(name: 'claude' | 'codex', probe: PortProbe): BackendPort {
  return {
    name,
    capabilities: {},
    handoffSource: (key: string) => probe.sources[key] ?? {},
    handoffCwdOf: async (key: string, sourceId: string) => {
      probe.handoffCwdOfCalls.push([key, sourceId])
      return probe.cwdOfFails ? undefined : CWD
    },
    forkBriefForHandoff: async (fromKey: string, cwd: string, sourceId: string, detail: HandoffDetail) => {
      probe.forkBriefCalls.push([fromKey, cwd, sourceId, detail])
      if (probe.forkError) throw probe.forkError
      if (probe.forkGate) await probe.forkGate
      return { text: '简报正文', usage: { input: 10 } }
    },
    seedHandoffTarget: async (hub: Hub, seed: string) => {
      probe.seedCalls.push({ hub, seed })
      return 'target-sid-1'
    },
    keyForNew: (cwd: string) => `n|${encodeURIComponent(cwd)}`,
    keyForExisting: (sessionId: string, cwd?: string) =>
      name === 'claude' ? `s|${sanitizePath(cwd ?? '')}|${sessionId}` : `x|${sessionId}`,
    sessionOf: () => undefined,
    hasLiveSession: (key: string) => probe.liveKeys.has(key),
    rekeySession: (_hub: Hub, oldKey: string, newKey: string, newSessionId: string) => {
      probe.rekeyCalls.push([oldKey, newKey, newSessionId])
    },
  } as unknown as BackendPort
}

function freshProbe(): PortProbe {
  return {
    sources: { [FROM_KEY]: { sourceId: 'thread-src-1' } }, // codex x| key 不含 cwd
    handoffCwdOfCalls: [],
    forkBriefCalls: [],
    seedCalls: [],
    rekeyCalls: [],
    liveKeys: new Set(),
  }
}

let probe: PortProbe
let tmpRoot: string
let lineageFile: string
const hubKeys: string[] = []

function hubAt(key: string, withClient = false): { hub: Hub; ws: FakeWs } {
  hubKeys.push(key)
  hubs.delete(key)
  const hub = getHub(key)
  const ws = fakeWs(key)
  if (withClient) hub.clients.add(ws as never)
  return { hub, ws }
}

/** 异步编排是 fire-and-forget：轮询等终态事件，超时即失败（不许静默假绿） */
async function untilOk(label: string, cond: () => boolean): Promise<void> {
  const deadline = Date.now() + 3000
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`等待超时: ${label}`)
    await Bun.sleep(2)
  }
}

function readLineage(): LineageRecord[] {
  return JSON.parse(readFileSync(lineageFile, 'utf8')) as LineageRecord[]
}

beforeEach(() => {
  probe = freshProbe()
  registerBackend('claude', fakePort('claude', probe))
  registerBackend('codex', fakePort('codex', probe))
  tmpRoot = mkdtempSync(join(tmpdir(), 'anyplane-handoff-test-'))
  lineageFile = join(tmpRoot, 'lineage.json')
  setLineageFileForTest(lineageFile)
})

afterEach(() => {
  // 恢复生产装配（与 callbacks.test.ts 模块顶层同口径）：
  // bun test 单进程跨文件共享注册表，留下 fake 会污染枚举顺序靠后的文件
  registerBackend('claude', claudePort)
  registerBackend('codex', codexPort)
  setLineageFileForTest(undefined)
  rmSync(tmpRoot, { recursive: true, force: true })
  for (const k of hubKeys.splice(0)) hubs.delete(k)
})

describe('runHandoff 同步拒绝', () => {
  test('目标后端与源相同 → 直接返回错误，不接触任何端口方法', () => {
    hubAt(FROM_KEY)
    expect(runHandoff(FROM_KEY, 'codex', 'standard')).toBe('接力目标必须与源会话是不同后端')
    expect(probe.handoffCwdOfCalls).toEqual([])
    expect(probe.seedCalls).toEqual([])
  })

  test('claude 源缺 cwd → 返回错误（claude 无惰性解析路径，cwd 校验先于 sourceId）', () => {
    const key = 'n|%2Ftmp%2Fhandoff-no-cwd'
    probe.sources[key] = { sourceId: 'sid-no-cwd' }
    hubAt(key)
    expect(runHandoff(key, 'codex', 'brief')).toBe('无法确定源会话目录')
    expect(probe.seedCalls).toEqual([])
  })

  test('源会话还没有任何消息（无 sourceId）→ 返回错误', () => {
    probe.sources[FROM_KEY] = { cwd: CWD } // codex 源：cwd 不挡，sourceId 闸生效
    hubAt(FROM_KEY)
    expect(runHandoff(FROM_KEY, 'claude', 'detailed')).toBe('源会话还没有任何消息，无法接力')
    expect(probe.handoffCwdOfCalls).toEqual([])
  })
})

describe('runHandoff 异步成功流（codex → claude）', () => {
  test('事件序列 pending→brief→done、播种文案、三层重键、血缘落盘', async () => {
    const { ws } = hubAt(FROM_KEY, true)
    hubAt(TARGET_KEY) // 目标 Hub 可存在（上次残留），但无客户端无会话身份才不拦

    expect(runHandoff(FROM_KEY, 'claude', 'standard')).toBeUndefined()
    await untilOk('handoff_done', () => payloads(ws).some((p) => p.kind === 'handoff_done'))

    // codex x| key 不含 cwd：必须经 handoffCwdOf 惰性解析后再构造 targetKey
    expect(probe.handoffCwdOfCalls).toEqual([[FROM_KEY, 'thread-src-1']])
    expect(probe.forkBriefCalls).toEqual([[FROM_KEY, CWD, 'thread-src-1', 'standard']])

    // 播种文案与 seedMessage 契约一致（简报 + 现场确认指令）
    expect(probe.seedCalls).toHaveLength(1)
    expect(probe.seedCalls[0].seed).toBe(seedMessage(CWD, 'codex', '简报正文'))

    // 事件序列 pending → brief → done；done 携带 resolved key 与目标 slug/cwd
    // （源是 codex 时 session.slug 恒 'codex'，前端沿用会把历史请求打到 projects/codex/）
    expect(payloads(ws).map((p) => p.kind)).toEqual(['handoff_pending', 'handoff_brief', 'handoff_done'])
    expect(payloads(ws).at(-1)).toMatchObject({
      targetKey: RESOLVED_TARGET,
      targetSessionId: 'target-sid-1',
      targetSlug: sanitizePath(CWD),
      targetCwd: CWD,
      toBackend: 'claude',
      brief: '简报正文',
    })

    // 三层重键的前两层：Hub 注册表换键、进程 map 重键
    // （hub.sessionId 在生产里由播种进程的 init 事件经 sessionCallbacks 写入，
    //  重键本身不写；第三层 ws.data.key 改写由 callbacks.test.ts 的 /clear 用例钉住）
    expect(hubs.get(TARGET_KEY)).toBeUndefined()
    const moved = hubs.get(RESOLVED_TARGET)
    expect(moved).toBeDefined()
    expect(moved?.key).toBe(RESOLVED_TARGET)
    expect(probe.rekeyCalls).toEqual([[TARGET_KEY, RESOLVED_TARGET, 'target-sid-1']])

    // 血缘：一条记录，from/to 双 key 与 resolved key 齐备（x| 已是 existing，fromResolved 即原 key）
    const [rec] = readLineage()
    expect(rec).toMatchObject({
      fromKey: FROM_KEY,
      toKey: TARGET_KEY,
      fromResolvedKey: FROM_KEY,
      toResolvedKey: RESOLVED_TARGET,
      fromBackend: 'codex',
      toBackend: 'claude',
      cwd: CWD,
      detail: 'standard',
      brief: '简报正文',
      briefUsage: { input: 10 },
    })
  })
})

describe('runHandoff 目标占用守卫', () => {
  test('目标 Hub 有存活会话 → handoff_error，不播种不落血缘', async () => {
    const { ws } = hubAt(FROM_KEY, true)
    const busy = hubAt(TARGET_KEY)
    busy.hub.sessionId = 'live-sid'
    probe.liveKeys.add(TARGET_KEY)

    runHandoff(FROM_KEY, 'claude', 'brief')
    await untilOk('handoff_error', () => payloads(ws).some((p) => p.kind === 'handoff_error'))

    const err = payloads(ws).find((p) => p.kind === 'handoff_error')
    expect(String(err?.message)).toContain('目标目录已有进行中的新会话')
    expect(probe.seedCalls).toEqual([])
    expect(() => readLineage()).toThrow() // 文件不存在——血缘未落盘
  })

  test('目标 Hub 有客户端连接（用户可能在编辑草稿）→ 拒绝', async () => {
    const { ws } = hubAt(FROM_KEY, true)
    hubAt(TARGET_KEY, true)

    runHandoff(FROM_KEY, 'claude', 'brief')
    await untilOk('handoff_error', () => payloads(ws).some((p) => p.kind === 'handoff_error'))
    expect(probe.seedCalls).toEqual([])
  })

  test('死残留（sessionId 在但进程已死且无客户端）→ 清身份后复用该 Hub 播种', async () => {
    const { ws } = hubAt(FROM_KEY, true)
    const stale = hubAt(TARGET_KEY)
    stale.hub.sessionId = 'dead-sid'
    stale.hub.spawnOpts = { cwd: CWD, resumeSessionId: 'dead-sid' }
    // liveKeys 不含 TARGET_KEY → hasLiveSession false → 死残留不拦（拦了是永久假阳性）

    runHandoff(FROM_KEY, 'claude', 'brief')
    await untilOk('handoff_done', () => payloads(ws).some((p) => p.kind === 'handoff_done'))

    expect(probe.seedCalls).toHaveLength(1)
    // 播种发生时旧身份已被清掉（否则播种续跑旧会话）
    expect(probe.seedCalls[0].hub.sessionId).toBeUndefined()
    expect(probe.seedCalls[0].hub.spawnOpts).toBeUndefined()
  })
})

describe('runHandoff sowing 并发互斥与失败清理', () => {
  test('同 cwd+backend 第二单在播种在途期间被拒，第一单正常完成', async () => {
    const a = hubAt(FROM_KEY, true)
    const B_KEY = 'x|thread-handoff-src-b'
    probe.sources[B_KEY] = { cwd: CWD, sourceId: 'thread-src-b' }
    const b = hubAt(B_KEY, true)

    // 第一单 fork 悬挂：sowing 占位期间第二单进来
    let resolveGate: () => void = () => {}
    probe.forkGate = new Promise<void>((r) => {
      resolveGate = r
    })

    runHandoff(FROM_KEY, 'claude', 'standard')
    await untilOk('第一单 fork 已进', () => probe.forkBriefCalls.length === 1)
    runHandoff(B_KEY, 'claude', 'standard')

    await untilOk('第二单 handoff_error', () => payloads(b.ws).some((p) => p.kind === 'handoff_error'))
    const err = payloads(b.ws).find((p) => p.kind === 'handoff_error')
    expect(String(err?.message)).toContain('同一目录已有接力在进行中')

    resolveGate()
    await untilOk('第一单 handoff_done', () => payloads(a.ws).some((p) => p.kind === 'handoff_done'))
    expect(probe.seedCalls).toHaveLength(1) // 只有第一单播了种
    expect(payloads(b.ws).some((p) => p.kind === 'handoff_pending')).toBe(false) // 第二单没进播种流
  })

  test('fork 简报抛错 → handoff_error 留痕，无客户端无存活的残留目标 Hub 被摘除', async () => {
    const { ws } = hubAt(FROM_KEY, true)
    probe.forkError = new Error('fork exploded')

    runHandoff(FROM_KEY, 'claude', 'brief')
    await untilOk('handoff_error', () => payloads(ws).some((p) => p.kind === 'handoff_error'))

    const err = payloads(ws).find((p) => p.kind === 'handoff_error')
    expect(err?.message).toBe('fork exploded')
    expect(probe.seedCalls).toEqual([])
    // 编排层 getHub 建过目标 Hub；清理口径（无客户端且无存活句柄）成立即摘除
    expect(hubs.get(TARGET_KEY)).toBeUndefined()
  })

  test('codex 源 cwd 惰性解析也拿不到 → handoff_error，不产生 xn| 废 key 的 Hub', async () => {
    const { ws } = hubAt(FROM_KEY, true)
    probe.cwdOfFails = true

    runHandoff(FROM_KEY, 'claude', 'brief')
    await untilOk('handoff_error', () => payloads(ws).some((p) => p.kind === 'handoff_error'))

    const err = payloads(ws).find((p) => p.kind === 'handoff_error')
    expect(err?.message).toBe('无法确定源会话目录（thread/read 未返回 cwd）')
    expect(probe.seedCalls).toEqual([])
    expect(hubs.get('xn|undefined')).toBeUndefined() // 提前用空 cwd 构造会得到废 key——确认未曾出现
    expect(hubs.get('xn|')).toBeUndefined()
  })
})
