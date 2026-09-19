// 共享会话回调的纯 Hub 编排边界：
// - 内部 user 载荷不进入广播/回放环
// - 普通 cli/result 广播并把 turn 完成发布到 inbox
// - 进程退出撤销全部死审批，再推送明确的退出状态

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { processManager } from '../backends/claude/processManager'
import type { CliMessage } from '../backends/claude/streamJson'
import { claudePort } from '../backends/claude/port'
import { codexPort } from '../backends/codex/port'
import { registerBackend } from '../backends/port'
import { resetInboxSinkForTest, setInboxSink } from './broadcast'
import { sessionCallbacks } from './callbacks'
import { getHub, hubs } from './registry'
import type { InboxEvent } from '@anyplane/protocol'
import type { Hub } from './types'

// portFor 经注册表取用（13.3 起）：注册真实适配器，镜像 index.ts 装配（各测试文件同一单例，幂等）。
registerBackend('claude', claudePort)
registerBackend('codex', codexPort)

const KEY = 'n|%2Ftmp%2Fcallbacks-test'
const inbox: InboxEvent[] = []

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

const extraKeys: string[] = []
const sessionMap = () => (processManager as unknown as { sessions: Map<string, { key: string }> }).sessions

/** 往 processManager 登记未退出的假句柄（等价 ensure 的登记半段，不 spawn） */
function injectFakeSession(key: string): { key: string } {
  extraKeys.push(key)
  const fake = { key }
  sessionMap().set(key, fake)
  return fake
}

function freshHub(): { hub: Hub; ws: FakeWs } {
  hubs.delete(KEY)
  const hub = getHub(KEY)
  const ws = fakeWs(KEY)
  hub.clients.add(ws as never)
  return { hub, ws }
}

function hubAt(key: string): { hub: Hub; ws: FakeWs } {
  extraKeys.push(key)
  hubs.delete(key)
  const hub = getHub(key)
  const ws = fakeWs(key)
  hub.clients.add(ws as never)
  return { hub, ws }
}

beforeEach(() => {
  inbox.length = 0
  setInboxSink({ publish: (event) => inbox.push(event) })
})

afterEach(() => {
  resetInboxSinkForTest()
  hubs.delete(KEY)
  sessionMap().delete(KEY)
  for (const k of extraKeys) {
    hubs.delete(k)
    sessionMap().delete(k)
  }
  extraKeys.length = 0
  inbox.length = 0
})

describe('sessionCallbacks.onMessage', () => {
  test('过滤 internal user：元数据标记与纯内部 XML 均不广播、不入回放环', () => {
    const { hub, ws } = freshHub()
    const callbacks = sessionCallbacks(hub)

    callbacks.onMessage({ type: 'user', isMeta: true } as CliMessage)
    callbacks.onMessage({
      type: 'user',
      message: { content: '<task-notification>background agent done</task-notification>' },
    } as CliMessage)

    expect(ws.sent).toEqual([])
    expect(hub.cliSeq).toBeUndefined()
    expect(hub.cliRing).toBeUndefined()
    expect(inbox).toEqual([])
  })

  test('普通 cli/result 均广播入环，result 同步发布 done inbox', () => {
    const { hub, ws } = freshHub()
    const callbacks = sessionCallbacks(hub)

    callbacks.onMessage({ type: 'assistant', message: { content: 'answer' } })
    callbacks.onMessage({ type: 'result', is_error: false })

    expect(payloads(ws)).toEqual([
      { kind: 'cli', seq: 1, msg: { type: 'assistant', message: { content: 'answer' } } },
      { kind: 'cli', seq: 2, msg: { type: 'result', is_error: false } },
    ])
    expect(hub.cliRing?.map((slot) => slot.seq)).toEqual([1, 2])
    expect(inbox).toEqual([{ type: 'done', key: KEY, ok: true }])
  })
})

describe('sessionCallbacks.conversation_reset', () => {
  test('claude key 进入 rekey，事件不进抄本', () => {
    const { hub, ws } = hubAt('n|%2Ftmp')
    sessionCallbacks(hub).onMessage({ type: 'conversation_reset' } as CliMessage)
    expect(hub.transition).toEqual({ kind: 'rekey' })
    expect(ws.sent).toEqual([])
  })

  test('codex key 不重键，落入普通透传', () => {
    const { hub, ws } = hubAt('x|thread-1')
    sessionCallbacks(hub).onMessage({ type: 'conversation_reset' } as CliMessage)
    expect(hub.transition).toBeUndefined()
    expect(payloads(ws)[0]).toMatchObject({ kind: 'cli', msg: { type: 'conversation_reset' } })
  })

  test('损坏 xn| 编码仍归 codex，不误触 claude 重键', () => {
    const { hub, ws } = hubAt('xn|%E4%B8')
    sessionCallbacks(hub).onMessage({ type: 'conversation_reset' } as CliMessage)
    expect(hub.transition).toBeUndefined()
    expect(payloads(ws)[0]).toMatchObject({ kind: 'cli', msg: { type: 'conversation_reset' } })
  })

  test('init 完成三层重键：Hub 注册表 / 进程 map / ws.data.key，并广播 moved', () => {
    const oldKey = 'n|%2Ftmp%2Fclear-cwd'
    const { hub, ws } = hubAt(oldKey)
    const fake = injectFakeSession(oldKey)
    const cb = sessionCallbacks(hub)
    cb.onMessage({ type: 'conversation_reset' } as CliMessage)
    cb.onMessage({ type: 'system', subtype: 'init', session_id: 'new-sid-1' } as CliMessage)

    const newKey = 's|-tmp-clear-cwd|new-sid-1'
    extraKeys.push(newKey)
    expect(hub.key).toBe(newKey)
    expect(hub.transition).toBeUndefined()
    expect(ws.data.key).toBe(newKey)
    expect(hubs.get(oldKey)).toBeUndefined()
    expect(hubs.get(newKey)).toBe(hub)
    expect(sessionMap().has(oldKey)).toBe(false)
    expect(sessionMap().get(newKey)).toBe(fake)
    expect(fake.key).toBe(newKey)
    expect(payloads(ws).some((p) => p.kind === 'moved' && p.targetKey === newKey && p.reason === 'clear')).toBe(true)
  })

  test('cwd 优先 spawnOpts，覆盖 n| key 内嵌路径', () => {
    const oldKey = 'n|%2Ftmp%2Ffrom-key'
    const { hub, ws } = hubAt(oldKey)
    hub.spawnOpts = { cwd: '/explicit/spawn-cwd' }
    const cb = sessionCallbacks(hub)
    cb.onMessage({ type: 'conversation_reset' } as CliMessage)
    cb.onMessage({ type: 'system', subtype: 'init', session_id: 'sid-opts' } as CliMessage)

    const newKey = 's|-explicit-spawn-cwd|sid-opts'
    extraKeys.push(newKey)
    expect(hub.key).toBe(newKey)
    expect(ws.data.key).toBe(newKey)
  })

  test('已是 s| 的第二次 /clear：spawnOpts.cwd 升到新 sid，进程 map 跟随', () => {
    const oldKey = 's|-tmp-clear-cwd|old-sid'
    const { hub, ws } = hubAt(oldKey)
    hub.spawnOpts = { cwd: '/tmp/clear-cwd' }
    const fake = injectFakeSession(oldKey)
    const cb = sessionCallbacks(hub)
    cb.onMessage({ type: 'conversation_reset' } as CliMessage)
    cb.onMessage({ type: 'system', subtype: 'init', session_id: 'sid-again' } as CliMessage)

    const newKey = 's|-tmp-clear-cwd|sid-again'
    extraKeys.push(newKey)
    expect(hub.key).toBe(newKey)
    expect(ws.data.key).toBe(newKey)
    expect(sessionMap().has(oldKey)).toBe(false)
    expect(sessionMap().get(newKey)).toBe(fake)
    expect(fake.key).toBe(newKey)
  })
})

describe('sessionCallbacks.onExit', () => {
  test('清空死审批，逐条撤卡并发布 inbox，最后推送退出状态', () => {
    const { hub, ws } = freshHub()
    hub.pendingApprovals.set('r1', { requestId: 'r1', toolName: 'Bash', input: {} })
    hub.pendingApprovals.set('r2', { requestId: 'r2', toolName: 'Write', input: { file_path: '/tmp/x' } })

    sessionCallbacks(hub).onExit(17)

    expect(hub.pendingApprovals.size).toBe(0)
    const sent = payloads(ws)
    expect(sent.slice(0, 2)).toEqual([
      { kind: 'approval_resolved', requestId: 'r1' },
      { kind: 'approval_resolved', requestId: 'r2' },
    ])
    expect(sent[2]).toMatchObject({
      kind: 'status',
      state: { exited: true, exitCode: 17, spawned: false, busy: false, waiting: false },
    })
    expect(inbox).toEqual([
      { type: 'approval_resolved', key: KEY, requestId: 'r1' },
      { type: 'approval_resolved', key: KEY, requestId: 'r2' },
    ])
  })
})
