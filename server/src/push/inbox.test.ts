// push/inbox.ts 的 publish 扇出与 initInbox 装配边界：
// - initInbox 接线后 publishInbox 经真实 publish 扇出到全部 /ws/inbox 客户端
// - 坏连接（send 抛错）是竞态常态：降 debug 留痕，不影响其余客户端，不向上抛
// - fanoutPush 的推送过滤不管 WS 通道：snapshot/approval_resolved 照常在客户端侧送达
// - inboxSnapshot 的 states 过滤口径（spawned||busy||waiting 才进）与 approval detail 摘要
// 安全隔离：publish 会连带 fanoutPush——本机 ~/.anyplane 可能有真实推送订阅，
// 全程 setSubsForTest([]) + 清空 config.pushWebhooks 钉死零订阅零 webhook（纯 no-op），
// 结束后按 vapid.ts 纪律复位，不碰真实订阅表。

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { claudePort } from '../backends/claude/port'
import { codexPort } from '../backends/codex/port'
import { registerBackend } from '../backends/port'
import { config } from '../config'
import { publishInbox, resetInboxChannelForTest, resetInboxSinkForTest } from '../hub/broadcast'
import { getHub, hubs } from '../hub/registry'
import type { InboxEvent } from '@anyplane/protocol'
import { addInboxClient, initInbox, inboxSnapshot, removeInboxClient } from './inbox'
import { setSubsForTest } from './vapid'

// portFor 经注册表取用：注册真实适配器，镜像 index.ts 装配（与 hub/socket.test.ts 同款，幂等）
registerBackend('claude', claudePort)
registerBackend('codex', codexPort)

interface FakeWs {
  sent: string[]
  send(text: string): void
}

function fakeWs(): FakeWs {
  return {
    sent: [],
    send(text: string) {
      this.sent.push(text)
    },
  }
}

/** send 必炸的坏连接（模拟 close 竞态：close 处理器未跑完时的下行） */
function brokenWs(): FakeWs {
  return {
    sent: [],
    send() {
      throw new Error('connection closed')
    },
  }
}

const usedKeys: string[] = []
const liveClients: FakeWs[] = []

function track(key: string): string {
  usedKeys.push(key)
  return key
}

function addClient(ws: FakeWs): FakeWs {
  addInboxClient(ws as never)
  liveClients.push(ws)
  return ws
}

let savedWebhooks: typeof config.pushWebhooks

beforeEach(() => {
  // 镜像 index.ts 装配：真实 sink + 真实 channel（本文件正是要钉这条真实链路）
  initInbox()
  // 钉死 fanoutPush 的 no-op 前提：零订阅零 webhook（本机/他机真实配置不得泄漏进测试）
  setSubsForTest([])
  savedWebhooks = config.pushWebhooks
  config.pushWebhooks = undefined
})

afterEach(() => {
  resetInboxSinkForTest()
  resetInboxChannelForTest()
  setSubsForTest(undefined)
  config.pushWebhooks = savedWebhooks
  for (const ws of liveClients.splice(0)) removeInboxClient(ws as never)
  for (const key of usedKeys.splice(0)) hubs.delete(key)
})

describe('initInbox 装配后的 publish 扇出', () => {
  test('publishInbox 事件扇出到全部 inbox 客户端，载荷逐字可解析', () => {
    const a = addClient(fakeWs())
    const b = addClient(fakeWs())

    publishInbox({ type: 'done', key: 'n|%2Ftmp%2Finbox-fanout', ok: true })

    for (const ws of [a, b]) {
      expect(ws.sent).toHaveLength(1)
      expect(JSON.parse(ws.sent[0]!)).toEqual({ type: 'done', key: 'n|%2Ftmp%2Finbox-fanout', ok: true })
    }
  })

  test('removeInboxClient 后不再收到事件；重复移除是空操作', () => {
    const a = addClient(fakeWs())
    const b = addClient(fakeWs())
    removeInboxClient(a as never)
    removeInboxClient(a as never)

    publishInbox({ type: 'error', key: 'k', message: 'boom' })

    expect(a.sent).toHaveLength(0)
    expect(b.sent).toHaveLength(1)
  })

  test('坏连接 send 抛错不影响其他客户端，publish 不向上抛', () => {
    const bad = addClient(brokenWs())
    const good = addClient(fakeWs())

    expect(() => publishInbox({ type: 'done', key: 'k', ok: false })).not.toThrow()
    expect(good.sent).toHaveLength(1)
    expect(bad.sent).toHaveLength(0)
  })

  test('fanoutPush 的推送过滤不管 WS 通道：snapshot 与 approval_resolved 照常送达客户端', () => {
    const ws = addClient(fakeWs())
    const snap = inboxSnapshot()

    publishInbox(snap)
    publishInbox({ type: 'approval_resolved', key: 'k', requestId: 'r1' })

    expect(ws.sent.map((t) => (JSON.parse(t) as InboxEvent).type)).toEqual(['snapshot', 'approval_resolved'])
  })

  test('零订阅零 webhook 且无客户端时 publish 静默返回（fanoutPush 早退不炸）', () => {
    expect(() => publishInbox({ type: 'approval', key: 'k', requestId: 'r', toolName: 'Bash', input: {} })).not.toThrow()
  })
})

describe('inboxSnapshot', () => {
  test('空闲 Hub（未 spawn/无审批/不忙）不进 states', () => {
    const idleKey = track('n|%2Ftmp%2Finbox-snap-idle')
    getHub(idleKey)

    const snap = inboxSnapshot()
    expect(snap.type).toBe('snapshot')
    expect(snap.states.map((s) => s.key)).not.toContain(idleKey)
    expect(snap.approvals.filter((a) => a.key === idleKey)).toEqual([])
  })

  test('带待审批的 Hub：approval 条目带 summarizeInput detail，states 标 waiting', () => {
    const key = track('n|%2Ftmp%2Finbox-snap-waiting')
    const hub = getHub(key)
    hub.pendingApprovals.set('r1', { requestId: 'r1', toolName: 'Bash', input: { command: 'ls -la' } })

    const snap = inboxSnapshot()

    // wire 实况：实现把 approval 事件条目（含 type）原样塞进快照，契约字段类型只声明 InboxApproval——
    // 经 JSON 往返钉住实际下行形状（与 hub/socket.test.ts 解析帧同款口径）
    const wire = JSON.parse(JSON.stringify(snap.approvals.filter((a) => a.key === key))) as Array<Record<string, unknown>>
    expect(wire).toEqual([
      // detail 是服务端唯一口径（summarizeInput）算好的摘要，Bash → command 本体
      { type: 'approval', key, requestId: 'r1', toolName: 'Bash', input: { command: 'ls -la' }, detail: 'ls -la' },
    ])
    const st = snap.states.find((s) => s.key === key)
    expect(st?.waiting).toBe(true)
    expect(st?.spawned).toBe(false)
    expect(st?.pendingApprovalIds).toEqual(['r1'])
  })

  test('多条待审批按插入序全部进快照（重放同源：客户端 reconcile 的唯一权威）', () => {
    const key = track('n|%2Ftmp%2Finbox-snap-multi')
    const hub = getHub(key)
    hub.pendingApprovals.set('r1', { requestId: 'r1', toolName: 'Bash', input: { command: 'ls' } })
    hub.pendingApprovals.set('r2', { requestId: 'r2', toolName: 'Write', input: { file_path: '/tmp/a.ts', content: 'x' } })

    const snap = inboxSnapshot()
    const mine = snap.approvals.filter((a) => a.key === key)

    expect(mine.map((a) => a.requestId)).toEqual(['r1', 'r2'])
    expect(mine[1]!.detail).toBe('/tmp/a.ts') // Write → file_path 摘要口径
  })
})
