// WS 连接生命周期（hub/socket.ts）的编排边界：
// - wsOpen：inbox 频道只收快照不建 Hub；会话频道建 Hub、首发 status、单播重放待审批
// - wsMessage：inbox 只发不收；非 JSON 帧静默丢弃；attach 的审批重放只给发起方
// - wsClose：保活定时器清除；无客户端且无存活会话才回收 Hub（存活期间删 Hub = 消息黑洞）；
//   /clear 重键后按客户端成员资格找回 Hub
// 用 n| key 走真实 portFor → claude 适配器：无 pid 扫描、无 transcript 读、不 spawn 进程。

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { processManager } from '../backends/claude/processManager'
import { claudePort } from '../backends/claude/port'
import { codexPort } from '../backends/codex/port'
import { initBackendPorts, registerBackend } from '../backends/port'
import { addInboxClient, inboxSnapshot, removeInboxClient } from '../push/inbox'
import { broadcast, broadcastError, resetInboxChannelForTest, resetInboxSinkForTest, setInboxChannel, setInboxSink } from './broadcast'
import { rewindBusy } from './lifecycle'
import { getHub, hubs } from './registry'
import { wsClose, wsMessage, wsOpen } from './socket'
import { pushStatus } from './status'
import type { InboxEvent } from '@anyplane/protocol'

// attach 会经 claude 适配器 onAttach → hubServices().pushStatus：装配层注入一次（镜像 index.ts）。
// sessionCallbacks 在本文件路径中不应触达（不 spawn），触达即 fail fast 暴露意外耦合。
initBackendPorts({
  broadcast,
  broadcastError,
  pushStatus,
  sessionCallbacks: (() => {
    throw new Error('socket 测试不应触达 sessionCallbacks（会 spawn 真实 CLI）')
  }) as never,
  getHub,
  sessionNameOf: () => 'socket-test',
  rewindBusy,
})
// portFor 经注册表取用（13.3 起契约叶子不再自带适配器单例）：注册真实适配器，镜像 index.ts 装配。
// 各测试文件注册同一单例，幂等且无顺序依赖。
registerBackend('claude', claudePort)
registerBackend('codex', codexPort)

interface FakeWs {
  data: { key?: string; inbox?: true; keepalive?: ReturnType<typeof setInterval> }
  sent: string[]
  send(text: string): void
  ping(): void
}

function fakeWs(data: FakeWs['data']): FakeWs {
  return {
    data,
    sent: [],
    send(text: string) {
      this.sent.push(text)
    },
    ping() {},
  }
}

function sessionWs(key: string): FakeWs {
  return fakeWs({ key })
}

function inboxWs(): FakeWs {
  return fakeWs({ inbox: true })
}

function frames(ws: FakeWs): Array<Record<string, unknown>> {
  return ws.sent.map((t) => JSON.parse(t) as Record<string, unknown>)
}

// 本文件用到的全部会话 key，afterEach 统一回收 Hub 与保活定时器
const usedKeys: string[] = []
const liveSockets: FakeWs[] = []

function track(key: string): string {
  usedKeys.push(key)
  return key
}

/** 往 processManager 登记未退出的假会话句柄（等价 ensure() 的登记半段，不 spawn 真实进程） */
function injectFakeSession(key: string, fake: { exited: boolean; detachClient(): void }): void {
  ;(processManager as unknown as { sessions: Map<string, unknown> }).sessions.set(key, fake)
}

const inboxEvents: InboxEvent[] = []

beforeEach(() => {
  inboxEvents.length = 0
  setInboxSink({ publish: (ev) => inboxEvents.push(ev) })
  // 镜像 index.ts 的 InboxChannel 注入：实现仍是 push/inbox，socket 不再直连
  setInboxChannel({ add: addInboxClient, remove: removeInboxClient, snapshot: inboxSnapshot })
})

afterEach(() => {
  resetInboxSinkForTest()
  resetInboxChannelForTest()
  for (const ws of liveSockets.splice(0)) {
    if (ws.data.keepalive) clearInterval(ws.data.keepalive)
  }
  for (const key of usedKeys.splice(0)) {
    hubs.delete(key)
    // 假句柄没有 dispose（不是真进程）：直接从私有 map 摘除
    ;(processManager as unknown as { sessions: Map<string, unknown> }).sessions.delete(key)
  }
})

describe('wsOpen：inbox 频道', () => {
  test('下发快照（预置 Hub 的状态与待审批），自身不建 Hub，登记保活', () => {
    const key = track('n|%2Ftmp%2Fsocket-inbox-open')
    const hub = getHub(key)
    hub.pendingApprovals.set('r1', { requestId: 'r1', toolName: 'Bash', input: { command: 'ls' } })
    const hubCount = hubs.size

    const ws = inboxWs()
    liveSockets.push(ws)
    wsOpen(ws as never)

    expect(hubs.size).toBe(hubCount) // inbox 连接不产生会话 Hub
    expect(ws.data.keepalive).toBeDefined()
    expect(ws.sent).toHaveLength(1)
    const snap = JSON.parse(ws.sent[0]) as {
      type: string
      states: Array<{ key: string; waiting: boolean; spawned: boolean }>
      approvals: Array<Record<string, unknown>>
    }
    expect(snap.type).toBe('snapshot')
    expect(snap.approvals).toEqual([
      // detail 是服务端唯一口径（summarizeInput）算好的摘要，Bash → command 本体
      { type: 'approval', key, requestId: 'r1', toolName: 'Bash', input: { command: 'ls' }, detail: 'ls' },
    ])
    const row = snap.states.find((s) => s.key === key)
    expect(row).toBeDefined()
    expect(row?.waiting).toBe(true) // 待审批计入 waiting
    expect(row?.spawned).toBe(false)
  })

  test('InboxChannel 未注入时 inbox 开连接 fail fast，且不挂 keepalive', () => {
    resetInboxChannelForTest()
    const ws = inboxWs()
    liveSockets.push(ws)
    expect(() => wsOpen(ws as never)).toThrow('InboxChannel')
    expect(ws.data.keepalive).toBeUndefined()
  })

  test('开/关走 InboxChannel：add 与 remove 各一次、同一连接', () => {
    const added: unknown[] = []
    const removed: unknown[] = []
    setInboxChannel({
      add: (ws) => {
        added.push(ws)
        addInboxClient(ws)
      },
      remove: (ws) => {
        removed.push(ws)
        removeInboxClient(ws)
      },
      snapshot: inboxSnapshot,
    })
    const ws = inboxWs()
    liveSockets.push(ws)
    wsOpen(ws as never)
    expect(added).toEqual([ws])
    expect(removed).toEqual([])
    wsClose(ws as never)
    expect(removed).toEqual([ws])
  })
})

describe('wsOpen：会话频道', () => {
  test('建 Hub、登记客户端、首帧 status、随后单播重放待审批', () => {
    const key = track('n|%2Ftmp%2Fsocket-session-open')
    const hub = getHub(key)
    hub.pendingApprovals.set('r1', { requestId: 'r1', toolName: 'Bash', input: { command: 'ls' } })

    const ws = sessionWs(key)
    liveSockets.push(ws)
    wsOpen(ws as never)

    expect(hub.clients.has(ws as never)).toBe(true)
    const f = frames(ws)
    expect(f[0]).toMatchObject({ kind: 'status', state: { spawned: false, waiting: true, clients: 1 } })
    // 待审批紧随后发，且只给本连接
    expect(f.slice(1)).toEqual([
      { kind: 'approval_request', requestId: 'r1', toolName: 'Bash', input: { command: 'ls' } },
    ])
  })
})

describe('wsMessage：上行分发边界', () => {
  test('inbox 频道只发不收：上行帧完全忽略', () => {
    const ws = inboxWs()
    liveSockets.push(ws)
    wsOpen(ws as never)
    ws.sent.length = 0
    const hubCount = hubs.size

    wsMessage(ws as never, '{"kind":"attach"}')
    wsMessage(ws as never, 'not json at all')

    expect(ws.sent).toEqual([])
    expect(hubs.size).toBe(hubCount)
  })

  test('非 JSON 帧静默丢弃：不抛、不下行（仅日志留痕）', () => {
    const key = track('n|%2Ftmp%2Fsocket-badjson')
    const ws = sessionWs(key)
    liveSockets.push(ws)
    wsOpen(ws as never)
    ws.sent.length = 0

    expect(() => wsMessage(ws as never, '{"kind":')).not.toThrow()
    expect(ws.sent).toEqual([])
  })

  test('attach：status 广播给 Hub 全部客户端，待审批只重放给发起连接', () => {
    const key = track('n|%2Ftmp%2Fsocket-attach')
    const ws1 = sessionWs(key)
    const ws2 = sessionWs(key)
    liveSockets.push(ws1, ws2)
    wsOpen(ws1 as never)
    wsOpen(ws2 as never)
    getHub(key).pendingApprovals.set('r9', {
      requestId: 'r9',
      toolName: 'Edit',
      input: { file_path: '/x.ts' },
    })
    ws1.sent.length = 0
    ws2.sent.length = 0

    wsMessage(ws1 as never, JSON.stringify({ kind: 'attach' }))

    const f1 = frames(ws1)
    const f2 = frames(ws2)
    // onAttach → pushStatus 是 Hub 级广播，两路都收
    expect(f1.some((f) => f.kind === 'status')).toBe(true)
    expect(f2.some((f) => f.kind === 'status')).toBe(true)
    // 审批重放严格单播：其他在线客户端收到重复审批卡是纯噪声
    expect(f1.filter((f) => f.kind === 'approval_request')).toEqual([
      { kind: 'approval_request', requestId: 'r9', toolName: 'Edit', input: { file_path: '/x.ts' } },
    ])
    expect(f2.some((f) => f.kind === 'approval_request')).toBe(false)
  })

  test('Buffer 上行帧按 toString 解析后正常分发', () => {
    const key = track('n|%2Ftmp%2Fsocket-buffer')
    const ws = sessionWs(key)
    liveSockets.push(ws)
    wsOpen(ws as never)
    ws.sent.length = 0

    wsMessage(ws as never, Buffer.from(JSON.stringify({ kind: 'attach' })))

    expect(frames(ws).some((f) => f.kind === 'status')).toBe(true)
  })
})

describe('wsClose：Hub 存活不变量', () => {
  test('最后一个客户端断开且无存活会话：回收 Hub', () => {
    const key = track('n|%2Ftmp%2Fsocket-close-last')
    const ws = sessionWs(key)
    liveSockets.push(ws)
    wsOpen(ws as never)
    expect(hubs.has(key)).toBe(true)

    wsClose(ws as never)

    expect(hubs.has(key)).toBe(false)
  })

  test('关闭连接即清除 30s 下行保活定时器', () => {
    const calls: unknown[] = []
    const realClear = globalThis.clearInterval
    globalThis.clearInterval = ((t: unknown) => {
      calls.push(t)
      return realClear(t as never)
    }) as typeof clearInterval
    try {
      const key = track('n|%2Ftmp%2Fsocket-close-keepalive')
      const ws = sessionWs(key)
      wsOpen(ws as never)
      const timer = ws.data.keepalive
      expect(timer).toBeDefined()

      wsClose(ws as never)

      expect(calls).toContain(timer)
    } finally {
      globalThis.clearInterval = realClear
    }
  })

  test('仍有其他客户端在线：Hub 保留，其余客户端不受影响', () => {
    const key = track('n|%2Ftmp%2Fsocket-close-peer')
    const ws1 = sessionWs(key)
    const ws2 = sessionWs(key)
    liveSockets.push(ws1, ws2)
    wsOpen(ws1 as never)
    wsOpen(ws2 as never)
    const hub = getHub(key)

    wsClose(ws1 as never)

    expect(hubs.get(key)).toBe(hub)
    expect(hub.clients.has(ws1 as never)).toBe(false)
    expect(hub.clients.has(ws2 as never)).toBe(true)
  })

  test('会话句柄存活期间 Hub 不得删除；句柄 detachClient、tailer 停止', () => {
    const key = track('n|%2Ftmp%2Fsocket-close-alive')
    const ws = sessionWs(key)
    liveSockets.push(ws)
    wsOpen(ws as never)
    const hub = getHub(key)
    let detached = 0
    const fakeSession = {
      exited: false,
      detachClient: () => {
        detached++
      },
    }
    injectFakeSession(key, fakeSession)
    let tailerStopped = 0
    hub.tailer = {
      stop: () => {
        tailerStopped++
      },
    } as never

    wsClose(ws as never)

    // 不变量：句柄存活 → Hub 保留（否则重连复用旧会话时事件广播进已删 Hub = 消息黑洞）
    expect(hubs.get(key)).toBe(hub)
    expect(hub.clients.size).toBe(0)
    expect(detached).toBe(1)
    expect(tailerStopped).toBe(1)
    expect(hub.tailer).toBeUndefined()
  })

  test('ws.data.key 已过期（/clear 重键后）：按客户端成员资格找回并回收 Hub', () => {
    const oldKey = track('n|%2Ftmp%2Fsocket-rekey-old')
    const newKey = track('n|%2Ftmp%2Fsocket-rekey-new')
    // 重键后进程/客户端落在 newKey 的 Hub 上，连接的 data.key 仍可能是旧值
    const ws = sessionWs(oldKey)
    liveSockets.push(ws)
    const hub = getHub(newKey)
    hub.clients.add(ws as never)
    expect(hubs.has(oldKey)).toBe(false)

    wsClose(ws as never)

    expect(hub.clients.has(ws as never)).toBe(false)
    expect(hubs.has(newKey)).toBe(false) // 无客户端且无存活会话 → 正常回收
  })

  test('既无 Hub 又无成员资格的连接关闭：静默返回不抛', () => {
    const ws = sessionWs('n|%2Ftmp%2Fsocket-ghost')
    liveSockets.push(ws)
    expect(() => wsClose(ws as never)).not.toThrow()
  })
})

describe('wsClose：inbox 频道', () => {
  test('关闭 inbox 连接：清保活、不触碰会话 Hub（只发不收，无 Hub 可入）', () => {
    const key = track('n|%2Ftmp%2Fsocket-inbox-close')
    getHub(key) // 预置一个会话 Hub，验证 inbox 关闭路径不误伤
    const hubCount = hubs.size
    const ws = inboxWs()
    wsOpen(ws as never)
    const timer = ws.data.keepalive

    const calls: unknown[] = []
    const realClear = globalThis.clearInterval
    globalThis.clearInterval = ((t: unknown) => {
      calls.push(t)
      return realClear(t as never)
    }) as typeof clearInterval
    try {
      wsClose(ws as never)
    } finally {
      globalThis.clearInterval = realClear
    }

    expect(calls).toContain(timer)
    expect(hubs.size).toBe(hubCount)
    expect(hubs.has(key)).toBe(true)
  })
})
