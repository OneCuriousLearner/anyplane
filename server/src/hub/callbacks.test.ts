// 共享会话回调的纯 Hub 编排边界：
// - 内部 user 载荷不进入广播/回放环
// - 普通 cli/result 广播并把 turn 完成发布到 inbox
// - 进程退出撤销全部死审批，再推送明确的退出状态

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { CliMessage } from '../backends/claude/protocol'
import { resetInboxSinkForTest, setInboxSink } from './broadcast'
import { sessionCallbacks } from './callbacks'
import { getHub, hubs } from './registry'
import type { Hub, InboxEvent } from './types'

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

function freshHub(): { hub: Hub; ws: FakeWs } {
  hubs.delete(KEY)
  const hub = getHub(KEY)
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
