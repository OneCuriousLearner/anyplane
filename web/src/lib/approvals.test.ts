import { describe, expect, test } from 'bun:test'
import { reconcileApprovals } from './approvals'

const card = (requestId: string) => ({ requestId, toolName: 'Bash', input: {} })

describe('reconcileApprovals（审批卡按服务端 pending 快照对齐）', () => {
  test('删除快照外的卡（裁决时离线/重启失效的收敛点）', () => {
    const local = [card('r1'), card('r2'), card('r3')]
    const next = reconcileApprovals(local, ['r2'])
    expect(next.map((a) => a.requestId)).toEqual(['r2'])
  })

  test('仍在 pending 的卡保留原元素引用（React key 不变不 remount，进行中输入不丢）', () => {
    const a = card('r1')
    const b = card('r2')
    const next = reconcileApprovals([a, b], ['r1'])
    expect(next[0]).toBe(a)
  })

  test('快照为空：清空全部本地卡（服务端重启后 pending 为空）', () => {
    expect(reconcileApprovals([card('r1')], [])).toEqual([])
  })

  test('无变化返回原数组引用（不触发多余渲染）', () => {
    const local = [card('r1'), card('r2')]
    expect(reconcileApprovals(local, ['r1', 'r2'])).toBe(local)
  })

  test('本地为空且快照有卡：不增（新卡只由 approval_request 事件引入）', () => {
    const local: ReturnType<typeof card>[] = []
    expect(reconcileApprovals(local, ['r9'])).toBe(local)
  })
})
