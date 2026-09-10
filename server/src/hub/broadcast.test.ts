// Hub 级广播与 inbox 事件出口（hub/broadcast.ts）：
// - broadcast：全客户端投递同一 JSON；kind=cli 才入环（重连补发的数据源）；kind=error 同步进 inbox
// - replayApprovals：待审批只补发给目标连接（attach/socket 单播路径共用）
// - publishInbox：sink 未注册是装配错误——warn 留痕一次但绝不 throw（error 广播路径会经过这里，
//   throw 会把普通错误广播变成异常）
import { describe, expect, test } from 'bun:test'
import { broadcast, broadcastError, publishInbox, replayApprovals, resetInboxSinkForTest, setInboxSink } from './broadcast'
import type { Hub, InboxEvent } from './types'

interface FakeWs {
  sent: string[]
  fail?: boolean
  send(text: string): void
}

function fakeWs(fail = false): FakeWs {
  return {
    sent: [],
    fail,
    send(text: string) {
      if (this.fail) throw new Error('connection closed')
      this.sent.push(text)
    },
  }
}

function makeHub(key = 'n|%2Ftmp%2Fanyplane-test'): Hub {
  return { key, clients: new Set(), pendingApprovals: new Map() } as unknown as Hub
}

/** 收集 sink 事件的注册器（publishInbox 的唯一出口） */
function collectInbox(): InboxEvent[] {
  const events: InboxEvent[] = []
  setInboxSink({ publish: (ev) => events.push(ev) })
  return events
}

describe('publishInbox：sink 注册语义', () => {
  // 模块级 sink/warn-once 单态跨测试文件共享（bun test 单进程），用例开头显式复位，
  // 不依赖文件执行顺序（各平台枚举顺序不同，顺序敏感曾在 ubuntu CI 误红）
  test('sink 未注册时丢弃事件：warn 留痕一次、不 throw', () => {
    resetInboxSinkForTest()
    const warns: unknown[][] = []
    const origWarn = console.warn
    console.warn = (...a: unknown[]) => {
      warns.push(a)
    }
    try {
      publishInbox({ type: 'done', key: 'n|x', ok: true })
      publishInbox({ type: 'done', key: 'n|x', ok: true })
    } finally {
      console.warn = origWarn
    }
    expect(warns).toHaveLength(1) // 两次调用只留痕一次（不刷屏）
    expect(String(warns[0]![0])).toContain('sink 未注册')
  })

  test('注册后事件原样经 sink.publish 流出', () => {
    const events = collectInbox()
    const ev: InboxEvent = { type: 'approval', key: 'n|x', requestId: 'r1', toolName: 'Bash', input: {} }
    publishInbox(ev)
    expect(events).toEqual([ev])
  })
})

describe('replayApprovals：待审批单播重放', () => {
  test('逐条补发全部 pending，形状为 approval_request', () => {
    const hub = makeHub()
    hub.pendingApprovals.set('r1', { requestId: 'r1', toolName: 'Bash', input: { command: 'ls' } })
    hub.pendingApprovals.set('r2', { requestId: 'r2', toolName: 'Write', input: {} })
    const sent: unknown[] = []
    replayApprovals(hub, (p) => sent.push(p))
    expect(sent).toEqual([
      { kind: 'approval_request', requestId: 'r1', toolName: 'Bash', input: { command: 'ls' } },
      { kind: 'approval_request', requestId: 'r2', toolName: 'Write', input: {} },
    ])
  })

  test('无 pending 时零调用', () => {
    const sent: unknown[] = []
    replayApprovals(makeHub(), (p) => sent.push(p))
    expect(sent).toEqual([])
  })
})

describe('broadcast：投递与环/收件箱接线', () => {
  test('向全部客户端投递同一 JSON；单连接 send 抛错不影响其余连接', () => {
    const hub = makeHub()
    const dead = fakeWs(true)
    const alive = fakeWs()
    hub.clients.add(dead as never)
    hub.clients.add(alive as never)
    collectInbox()
    broadcast(hub, { kind: 'status', state: { busy: true } })
    expect(alive.sent).toEqual([JSON.stringify({ kind: 'status', state: { busy: true } })])
  })

  test('kind=cli 分配单调 seq 并入环；其他 kind 不占环、不带 seq', () => {
    const hub = makeHub()
    collectInbox()
    const first = { kind: 'cli', msg: { type: 'user' } }
    const second = { kind: 'cli', msg: { type: 'assistant' } }
    broadcast(hub, first)
    broadcast(hub, { kind: 'status', state: {} })
    broadcast(hub, second)
    expect(hub.cliSeq).toBe(2)
    expect(first).toMatchObject({ seq: 1 })
    expect(second).toMatchObject({ seq: 2 })
    expect(hub.cliRing?.map((s) => s.seq)).toEqual([1, 2])
  })

  test('kind=error 同步发布 inbox error 事件；其他 kind 不进 inbox', () => {
    const hub = makeHub('s|slug|sid')
    const events = collectInbox()
    broadcastError(hub, 'boom')
    broadcast(hub, { kind: 'status', state: {} })
    expect(events).toEqual([{ type: 'error', key: 's|slug|sid', message: 'boom' }])
  })

  test('空客户端集合投递不抛（含 error kind 的 inbox 路径）', () => {
    const hub = makeHub()
    const events = collectInbox()
    broadcast(hub, { kind: 'cli', msg: { type: 'result' } })
    broadcastError(hub, 'no clients')
    expect(hub.cliSeq).toBe(1)
    expect(events).toEqual([{ type: 'error', key: hub.key, message: 'no clients' }])
  })
})
