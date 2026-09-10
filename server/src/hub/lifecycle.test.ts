// 审批裁决共享路径与回滚互斥守卫（hub/lifecycle.ts）：
// - rewindBusy：回滚进行中拒绝新操作（错误已广播）
// - resolveApproval：WS approval 消息与推送能力 URL 共用——requestId 出 pending 才裁决，
//   重复点击/别处已处理返回 false（幂等）；裁决后 approval_resolved 广播 + inbox 留痕 + status 刷新
// - deliverApproval：会话句柄缺席时决定无处投递——广播明确错误而不静默吞掉
//
// 会话存活投递成功（sendApproval）的路径由 e2e-approval.ts 覆盖，这里只测无进程的边界与错误路径。
// 注意：resolveApproval 内部走真实 pushStatus → claudePort.statusOf；用 n| key（新会话）时
// 无 pid 扫描、无 transcript 读（splitExistingKey/hydratedContextOf 对 n| 快路径返回）。
import { afterEach, describe, expect, test } from 'bun:test'
import { setInboxSink } from './broadcast'
import { deliverApproval, resolveApproval, rewindBusy } from './lifecycle'
import { getHub, hubs } from './registry'
import type { Hub, InboxEvent } from './types'

const KEY = 'n|%2Ftmp%2Fanyplane-lifecycle-test'

const inboxEvents: InboxEvent[] = []
// 文件加载即注册：本文件的广播路径（broadcastError 等）都会触发 publishInbox，
// 提前注册避免触发 sink 缺失的 warn-once 路径（该路径由 broadcast.test.ts 专测）
setInboxSink({ publish: (ev) => inboxEvents.push(ev) })

interface FakeWs {
  sent: string[]
  send(text: string): void
}

function fakeWs(): FakeWs {
  return { sent: [], send(text: string) { this.sent.push(text) } }
}

function sentPayloads(ws: FakeWs): Array<Record<string, unknown>> {
  return ws.sent.map((t) => JSON.parse(t) as Record<string, unknown>)
}

function freshHub(): { hub: Hub; ws: FakeWs } {
  hubs.delete(KEY)
  const hub = getHub(KEY)
  const ws = fakeWs()
  hub.clients.add(ws as never)
  return { hub, ws }
}

afterEach(() => {
  hubs.delete(KEY)
  inboxEvents.length = 0
})

describe('rewindBusy：回滚互斥守卫', () => {
  test('无回滚进行时放行（false）且零广播', () => {
    const { hub, ws } = freshHub()
    expect(rewindBusy(hub)).toBe(false)
    expect(ws.sent).toEqual([])
  })

  test('rewindPending 时拒绝（true）并广播指定错误', () => {
    const { hub, ws } = freshHub()
    hub.rewindPending = true
    expect(rewindBusy(hub, '正在恢复文件，请等待回滚完成后再发送消息')).toBe(true)
    expect(sentPayloads(ws)).toEqual([
      { kind: 'error', message: '正在恢复文件，请等待回滚完成后再发送消息' },
    ])
    // 默认文案路径
    expect(rewindBusy(hub)).toBe(true)
    expect(sentPayloads(ws)[1]).toEqual({ kind: 'error', message: '已有回滚操作正在进行' })
  })
})

describe('resolveApproval：裁决幂等与留痕', () => {
  test('requestId 不在 pending：返回 false，零广播零 inbox（重复点击/别处已处理）', () => {
    const { hub, ws } = freshHub()
    expect(resolveApproval(hub, 'r-unknown', { behavior: 'allow' })).toBe(false)
    expect(ws.sent).toEqual([])
    expect(inboxEvents).toEqual([])
  })

  test('pending 中裁决：出 pending、广播 resolved 与 status、inbox 留痕；重复裁决幂等', () => {
    const { hub, ws } = freshHub()
    hub.pendingApprovals.set('r1', { requestId: 'r1', toolName: 'Bash', input: { command: 'ls' } })
    expect(resolveApproval(hub, 'r1', { behavior: 'allow' })).toBe(true)
    expect(hub.pendingApprovals.size).toBe(0)

    const payloads = sentPayloads(ws)
    const kinds = payloads.map((p) => p.kind)
    // 会话未运行（无进程）：先广播投递失败错误，再 resolved，最后 status 刷新
    expect(kinds).toEqual(['error', 'approval_resolved', 'status'])
    expect(payloads[0]!.message).toContain('会话未在运行')
    expect(payloads[1]).toMatchObject({ requestId: 'r1' })
    // status 反映裁决后状态：pending 已清 → waiting=false
    expect(payloads[2]!.state).toMatchObject({ waiting: false, spawned: false })

    expect(inboxEvents).toEqual([
      { type: 'error', key: KEY, message: expect.stringContaining('会话未在运行') },
      { type: 'approval_resolved', key: KEY, requestId: 'r1' },
    ])

    // 同一 requestId 再次裁决：已出 pending，幂等返回 false，无新增广播
    const before = ws.sent.length
    expect(resolveApproval(hub, 'r1', { behavior: 'deny', message: 'x' })).toBe(false)
    expect(ws.sent.length).toBe(before)
  })
})

describe('deliverApproval：投递半段的错误路径', () => {
  test('会话句柄缺席时广播明确错误且不 throw（外部门禁 no-op）', () => {
    const { hub, ws } = freshHub()
    expect(() => deliverApproval(hub, 'r2', { behavior: 'allow' })).not.toThrow()
    expect(sentPayloads(ws)).toEqual([
      { kind: 'error', message: '会话未在运行，审批未能送达（该请求会在上游自行超时）' },
    ])
  })
})
