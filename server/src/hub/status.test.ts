// status 编排层的 leading+trailing 节流不变量：
// - 首次变化立即推送，300ms 窗口内任意次数只合并为一次 trailing
// - Hub 已从注册表回收时，旧定时器不得向旧连接补发

import { afterEach, describe, expect, test } from 'bun:test'
import { getHub, hubs } from './registry'
import { throttledPushStatus } from './status'
import type { Hub } from './types'

const KEYS = ['n|%2Ftmp%2Fstatus-throttle', 'n|%2Ftmp%2Fstatus-deleted']

interface FakeWs {
  sent: string[]
  send(text: string): void
}

function fakeWs(): FakeWs {
  return { sent: [], send(text: string) { this.sent.push(text) } }
}

function freshHub(key: string): { hub: Hub; ws: FakeWs } {
  hubs.delete(key)
  const hub = getHub(key)
  const ws = fakeWs()
  hub.clients.add(ws as never)
  return { hub, ws }
}

function controlledScheduler() {
  const jobs: Array<{ callback: () => void; delayMs: number }> = []
  const schedule = (callback: () => void, delayMs: number) => {
    jobs.push({ callback, delayMs })
    const timer = { unref: () => timer }
    return timer as unknown as ReturnType<typeof setTimeout>
  }
  return { jobs, schedule }
}

afterEach(() => {
  for (const key of KEYS) hubs.delete(key)
})

describe('throttledPushStatus', () => {
  test('首发立即、窗口固定 300ms，窗口内多次变化合并为一个 trailing', () => {
    const { jobs, schedule } = controlledScheduler()
    const { hub, ws } = freshHub(KEYS[0]!)

    throttledPushStatus(hub, schedule)
    throttledPushStatus(hub, schedule)
    throttledPushStatus(hub, schedule)

    expect(ws.sent).toHaveLength(1)
    expect(jobs).toHaveLength(1)
    expect(jobs[0]!.delayMs).toBe(300)

    jobs[0]!.callback()
    expect(ws.sent).toHaveLength(2)
    expect(ws.sent.map((text) => JSON.parse(text).kind)).toEqual(['status', 'status'])
  })

  test('窗口内变脏后 Hub 被删除，不执行 trailing 补发', () => {
    const { jobs, schedule } = controlledScheduler()
    const { hub, ws } = freshHub(KEYS[1]!)

    throttledPushStatus(hub, schedule)
    throttledPushStatus(hub, schedule)
    expect(ws.sent).toHaveLength(1)

    hubs.delete(hub.key)
    jobs[0]!.callback()

    expect(ws.sent).toHaveLength(1)
  })
})
