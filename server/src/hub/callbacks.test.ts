// 共享会话回调的纯 Hub 编排边界：
// - 内部 user 载荷不进入广播/回放环
// - 普通 cli/result 广播并把 turn 完成发布到 inbox
// - 进程退出撤销全部死审批，再推送明确的退出状态

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { CliMessage } from '../backends/claude/protocol'
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
  send(text: string): void
}

function fakeWs(): FakeWs {
  return { sent: [], send(text: string) { this.sent.push(text) } }
}

function payloads(ws: FakeWs): Array<Record<string, unknown>> {
  return ws.sent.map((text) => JSON.parse(text) as Record<string, unknown>)
}

const extraKeys: string[] = []

function freshHub(): { hub: Hub; ws: FakeWs } {
  hubs.delete(KEY)
  const hub = getHub(KEY)
  const ws = fakeWs()
  hub.clients.add(ws as never)
  return { hub, ws }
}

function hubAt(key: string): { hub: Hub; ws: FakeWs } {
  extraKeys.push(key)
  hubs.delete(key)
  const hub = getHub(key)
  const ws = fakeWs()
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
  for (const k of extraKeys) hubs.delete(k)
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
