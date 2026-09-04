// SessionSocket：会话频道 WS 客户端的自有逻辑——url 构造（key 编码）、
// open 前发送排队 / open 时 FIFO 冲刷、断线期间重排队并在重连后冲刷到新连接。
// 重连退避本身由基类 reconnectingSocket.test.ts 覆盖,这里只测 SessionSocket 增量。
// 用 FakeWebSocket + 捕获式 setTimeout 全同步驱动（同基类测试的模式）。

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { SessionSocket, type ClientCommand, type ServerEvent } from './ws'

class FakeWebSocket {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSED = 3
  static instances: FakeWebSocket[] = []

  readyState = FakeWebSocket.CONNECTING
  sent: string[] = []
  onopen: ((e: unknown) => void) | null = null
  onclose: ((e: unknown) => void) | null = null
  onmessage: ((e: { data: string }) => void) | null = null
  onerror: ((e: unknown) => void) | null = null

  constructor(public url: string) {
    FakeWebSocket.instances.push(this)
  }

  send(text: string): void {
    this.sent.push(text)
  }

  close(): void {
    if (this.readyState === FakeWebSocket.CLOSED) return
    this.readyState = FakeWebSocket.CLOSED
    this.onclose?.({})
  }

  // ---- 测试驱动辅助 ----
  open(): void {
    this.readyState = FakeWebSocket.OPEN
    this.onopen?.({})
  }
  receive(data: string): void {
    this.onmessage?.({ data })
  }
}

interface ScheduledCall {
  delay: number
  fn: () => void
}

let scheduled: ScheduledCall[] = []
let storedToken: string | null = null
const real = {
  setTimeout: globalThis.setTimeout,
  WebSocket: globalThis.WebSocket,
  location: (globalThis as Record<string, unknown>).location,
  localStorage: (globalThis as Record<string, unknown>).localStorage,
}

beforeEach(() => {
  scheduled = []
  storedToken = null
  FakeWebSocket.instances = []
  const g = globalThis as Record<string, unknown>
  g.WebSocket = FakeWebSocket as unknown as typeof WebSocket
  g.setTimeout = ((fn: () => void, delay?: number) => {
    scheduled.push({ delay: delay ?? 0, fn })
    return 0
  }) as unknown as typeof setTimeout
  g.location = { protocol: 'http:', host: 'cc.test', search: '', href: 'http://cc.test/' }
  g.localStorage = {
    getItem: (k: string) => (k === 'anyplane-token' ? storedToken : null),
    setItem: (_k: string, v: string) => {
      storedToken = v
    },
    removeItem: () => {},
    clear: () => {},
  }
})

afterEach(() => {
  const g = globalThis as Record<string, unknown>
  g.setTimeout = real.setTimeout
  g.WebSocket = real.WebSocket
  g.location = real.location
  g.localStorage = real.localStorage
})

function makeSocket(key = 's|-proj|sid-1') {
  const events: ServerEvent[] = []
  const opens: boolean[] = []
  const s = new SessionSocket(
    key,
    (ev) => events.push(ev),
    (open) => opens.push(open),
  )
  return { s, events, opens }
}

const userCmd: ClientCommand = { kind: 'user', text: '你好' }

describe('SessionSocket URL 构造', () => {
  test('key 经 encodeURIComponent 拼入 /ws/sessions/ 路径', () => {
    makeSocket('n|/tmp/a b')
    expect(FakeWebSocket.instances[0]?.url).toBe('ws://cc.test/ws/sessions/n%7C%2Ftmp%2Fa%20b')
  })

  test('localStorage 有 token 时由 wsUrl 附加编码后的 query', () => {
    storedToken = 'tok 1'
    makeSocket('x|thread-9')
    expect(FakeWebSocket.instances[0]?.url).toBe('ws://cc.test/ws/sessions/x%7Cthread-9?token=tok%201')
  })
})

describe('SessionSocket 发送队列', () => {
  test('open 前 send 只排队不发送；open 时按 FIFO 冲刷且之后直发', () => {
    const { s } = makeSocket()
    const ws = FakeWebSocket.instances[0]!
    s.send({ kind: 'attach' })
    s.send(userCmd)
    expect(ws.sent).toEqual([]) // CONNECTING 期间一条都不发

    ws.open()
    expect(ws.sent.map((t) => JSON.parse(t))).toEqual([{ kind: 'attach' }, userCmd]) // 按序冲刷

    ws.sent.length = 0
    s.send({ kind: 'btw', question: 'q' }) // open 后直发,不经队列
    expect(ws.sent.map((t) => JSON.parse(t))).toEqual([{ kind: 'btw', question: 'q' }])
  })

  test('队列只冲刷一次:重连 open 不会重发历史命令', () => {
    const { s } = makeSocket()
    const ws = FakeWebSocket.instances[0]!
    s.send(userCmd)
    ws.open()
    expect(ws.sent).toHaveLength(1)

    // 断线 → 捕获的重连定时器到点 → 新连接 open:队列已空,不应重放
    ws.close()
    scheduled.shift()?.fn()
    const ws2 = FakeWebSocket.instances[1]!
    ws2.open()
    expect(ws2.sent).toEqual([])
  })

  test('断线期间 send 重新排队,重连 open 时冲刷到新连接且保持先后序', () => {
    const { s } = makeSocket()
    const ws = FakeWebSocket.instances[0]!
    ws.open()
    s.send({ kind: 'user', text: '第一条' })
    expect(ws.sent).toHaveLength(1)

    ws.close() // 断线,open 状态回退
    s.send({ kind: 'user', text: '断线期' }) // 未 open → 排队
    s.send({ kind: 'control', subtype: 'interrupt' })
    scheduled.shift()?.fn() // 重连

    const ws2 = FakeWebSocket.instances[1]!
    expect(ws2.sent).toEqual([]) // 新连接 open 前仍不发
    ws2.open()
    expect(ws2.sent.map((t) => JSON.parse(t))).toEqual([
      { kind: 'user', text: '断线期' },
      { kind: 'control', subtype: 'interrupt' },
    ])
  })
})

describe('SessionSocket 事件与连接状态回调', () => {
  test('下行消息透传 onEvent;open/close 驱动 openCb', () => {
    const { events, opens } = makeSocket()
    const ws = FakeWebSocket.instances[0]!
    ws.open()
    ws.receive(JSON.stringify({ kind: 'status', state: { spawned: true, busy: true } }))
    expect(events).toEqual([{ kind: 'status', state: { spawned: true, busy: true } }])
    ws.close()
    expect(opens).toEqual([true, false])
  })
})
