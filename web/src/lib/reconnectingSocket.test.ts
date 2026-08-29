// ReconnectingSocket 的重连状态机：指数退避（1s 起 15s 封顶）、open 复位、
// close 终止重连、sendRaw 门控、下行 JSON 解析容错。
// 用 FakeWebSocket + 捕获式 setTimeout 全同步驱动，不做真实等待。

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { ReconnectingSocket, wsUrl } from './reconnectingSocket'

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
  error(): void {
    this.onerror?.({})
  }
}

class TestSocket extends ReconnectingSocket {
  messages: unknown[] = []
  openStates: boolean[] = []
  openCount = 0

  protected url(): string {
    return '/ws/test'
  }
  protected onMessage(data: unknown): void {
    this.messages.push(data)
  }
  protected onOpenChange(open: boolean): void {
    this.openStates.push(open)
  }
  protected onOpen(): void {
    this.openCount++
  }
  /** 构造后手动启动：对应子类构造函数末尾调 start() 的约定 */
  boot(): void {
    this.start()
  }
  trySend(text: string): boolean {
    return this.sendRaw(text)
  }
}

interface ScheduledCall {
  delay: number
  fn: () => void
}

let scheduled: ScheduledCall[] = []
const realSetTimeout = globalThis.setTimeout
const realWebSocket = globalThis.WebSocket

beforeEach(() => {
  scheduled = []
  FakeWebSocket.instances = []
  globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket
  // 捕获重连定时器：不断言真实时间流，手动 fire
  globalThis.setTimeout = ((fn: () => void, delay?: number) => {
    scheduled.push({ delay: delay ?? 0, fn })
    return 0
  }) as unknown as typeof setTimeout
})

afterEach(() => {
  globalThis.setTimeout = realSetTimeout
  globalThis.WebSocket = realWebSocket
})

describe('wsUrl', () => {
  test('按页面协议映射 ws/wss；localStorage 有 token 时附加编码后的 query', () => {
    const g = globalThis as Record<string, unknown>
    const saved = { location: g.location, localStorage: g.localStorage }
    let storedToken: string | null = null
    g.localStorage = {
      getItem: (k: string) => (k === 'anyplane-token' ? storedToken : null),
      setItem: (_k: string, v: string) => {
        storedToken = v
      },
      removeItem: () => {},
      clear: () => {},
    }
    try {
      g.location = { protocol: 'http:', host: 'cc.test', search: '', href: 'http://cc.test/' }
      expect(wsUrl('/ws/inbox')).toBe('ws://cc.test/ws/inbox')
      g.location = { protocol: 'https:', host: 'cc.test', search: '', href: 'https://cc.test/' }
      expect(wsUrl('/ws/inbox')).toBe('wss://cc.test/ws/inbox')
      storedToken = 'tok 123'
      expect(wsUrl('/ws/inbox')).toBe('wss://cc.test/ws/inbox?token=tok%20123')
    } finally {
      g.location = saved.location
      g.localStorage = saved.localStorage
    }
  })
})

describe('ReconnectingSocket 连接与消息', () => {
  test('open 后回调 onOpenChange(true) 与 onOpen 钩子', () => {
    const s = new TestSocket()
    s.boot()
    const ws = FakeWebSocket.instances[0]
    expect(ws?.url).toBe('/ws/test')
    ws?.open()
    expect(s.openStates).toEqual([true])
    expect(s.openCount).toBe(1)
  })

  test('下行消息逐条 JSON 解析分发；坏 JSON 静默吞掉', () => {
    const s = new TestSocket()
    s.boot()
    const ws = FakeWebSocket.instances[0]
    ws?.open()
    ws?.receive(JSON.stringify({ kind: 'status', state: { busy: true } }))
    ws?.receive('{broken')
    ws?.receive(JSON.stringify({ kind: 'error', message: 'x' }))
    expect(s.messages).toEqual([{ kind: 'status', state: { busy: true } }, { kind: 'error', message: 'x' }])
  })

  test('sendRaw 仅在 open 时发送：CONNECTING/CLOSED 返回 false 且不发送', () => {
    const s = new TestSocket()
    s.boot()
    const ws = FakeWebSocket.instances[0]
    expect(s.trySend('a')).toBe(false)
    expect(ws?.sent).toEqual([])
    ws?.open()
    expect(s.trySend('b')).toBe(true)
    expect(ws?.sent).toEqual(['b'])
    ws?.close()
    expect(s.trySend('c')).toBe(false)
    expect(ws?.sent).toEqual(['b'])
  })
})

describe('ReconnectingSocket 断线重连退避', () => {
  test('退避序列 1s 起每次翻倍，15s 封顶', () => {
    const s = new TestSocket()
    s.boot()
    const expected = [1000, 2000, 4000, 8000, 15000, 15000]
    for (const delay of expected) {
      FakeWebSocket.instances.at(-1)?.close() // 连接失败/断线
      const call = scheduled.shift()
      expect(call?.delay).toBe(delay)
      call?.fn() // 定时器到点 → 发起新连接
    }
    expect(FakeWebSocket.instances).toHaveLength(expected.length + 1)
  })

  test('重连成功后退避复位：再次断线从 1s 重新计', () => {
    const s = new TestSocket()
    s.boot()
    FakeWebSocket.instances[0]?.close()
    const retry = scheduled.shift()
    expect(retry?.delay).toBe(1000)
    retry?.fn() // 重连 #2
    FakeWebSocket.instances[1]?.open() // 成功 → retry 清零
    FakeWebSocket.instances[1]?.close() // 再次断线
    expect(scheduled.shift()?.delay).toBe(1000) // 回到起点而非 2000
  })

  test('onerror 等效断线：触发 close 并排程重连', () => {
    const s = new TestSocket()
    s.boot()
    FakeWebSocket.instances[0]?.error()
    expect(s.openStates).toEqual([false])
    expect(scheduled.shift()?.delay).toBe(1000)
  })
})

describe('ReconnectingSocket close 终止', () => {
  test('close() 后断线不再排程重连', () => {
    const s = new TestSocket()
    s.boot()
    const ws = FakeWebSocket.instances[0]
    s.close()
    expect(ws?.readyState).toBe(FakeWebSocket.CLOSED)
    expect(scheduled).toHaveLength(0)
    expect(s.openStates).toEqual([false])
  })

  test('close() 前已排程的重连在到点时被 closed 守卫拦下', () => {
    const s = new TestSocket()
    s.boot()
    FakeWebSocket.instances[0]?.close() // 排程 1s
    expect(scheduled).toHaveLength(1)
    s.close()
    scheduled.shift()?.fn() // 定时器到点，但已 closed
    expect(FakeWebSocket.instances).toHaveLength(1) // 没有发起新连接
  })
})
