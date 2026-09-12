// WS 上行消息编排的高风险边界：
// - 非 JSON 帧只丢弃，不把异常抛回 socket 处理器
// - attach 的审批与 CLI 断线补发严格单播，缺口显式通知发起方
// - rewindPending 时 user 消息同步拒绝，不解析/启动任何真实后端

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { BackendPort } from '../backends/port'
import { resetInboxSinkForTest, setInboxSink } from './broadcast'
import { handleClientMessage } from './messages'
import { getHub, hubs } from './registry'
import type { Hub } from './types'

const KEY = 'n|%2Ftmp%2Fmessages-test'

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

function freshHub(): Hub {
  hubs.delete(KEY)
  return getHub(KEY)
}

beforeEach(() => setInboxSink({ publish: () => {} }))

afterEach(() => {
  resetInboxSinkForTest()
  hubs.delete(KEY)
})

describe('handleClientMessage', () => {
  test('非法 JSON 不抛且不解析后端', () => {
    const hub = freshHub()
    let resolved = 0
    const resolvePort = () => {
      resolved++
      return {} as BackendPort
    }

    expect(() => handleClientMessage(hub, '{"kind":', undefined, resolvePort)).not.toThrow()
    expect(resolved).toBe(0)
  })

  test('attach 审批与 CLI 补发只发给发起连接，replay gap 也仅单播', () => {
    const hub = freshHub()
    const target = fakeWs()
    const peer = fakeWs()
    hub.clients.add(target as never)
    hub.clients.add(peer as never)
    hub.pendingApprovals.set('approval-1', {
      requestId: 'approval-1',
      toolName: 'Bash',
      input: { command: 'git status' },
    })
    hub.cliSeq = 5
    hub.cliRing = [
      { seq: 4, payload: { kind: 'cli', seq: 4, msg: { type: 'assistant', text: 'four' } } },
      { seq: 5, payload: { kind: 'cli', seq: 5, msg: { type: 'result', is_error: false } } },
    ]

    let attaches = 0
    const fakePort = {
      onAttach: () => {
        attaches++
      },
    } as unknown as BackendPort
    handleClientMessage(
      hub,
      JSON.stringify({ kind: 'attach', fromSeq: 2 }),
      target as never,
      () => fakePort,
    )

    expect(attaches).toBe(1)
    expect(peer.sent).toEqual([])
    expect(payloads(target)).toEqual([
      {
        kind: 'approval_request',
        requestId: 'approval-1',
        toolName: 'Bash',
        input: { command: 'git status' },
      },
      { kind: 'cli', seq: 4, msg: { type: 'assistant', text: 'four' }, replay: true },
      { kind: 'cli', seq: 5, msg: { type: 'result', is_error: false }, replay: true },
      { kind: 'replay_gap', fromSeq: 2 },
    ])
    expect(hub.cliSeq).toBe(5)
    expect(hub.cliRing).toHaveLength(2)
  })

  test('rewindPending 拒绝 user，且不会触发 ensureForSend 或真实 CLI', () => {
    const hub = freshHub()
    const ws = fakeWs()
    hub.clients.add(ws as never)
    hub.rewindPending = true

    let ensures = 0
    const fakePort = {
      ensureForSend: async () => {
        ensures++
        return undefined
      },
    } as unknown as BackendPort
    handleClientMessage(
      hub,
      JSON.stringify({ kind: 'user', text: 'must not send' }),
      ws as never,
      () => fakePort,
    )

    expect(ensures).toBe(0)
    expect(payloads(ws)).toEqual([
      { kind: 'error', message: '正在恢复文件，请等待回滚完成后再发送消息' },
    ])
  })
})
