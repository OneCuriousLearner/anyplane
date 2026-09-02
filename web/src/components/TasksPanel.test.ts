import { describe, expect, test } from 'bun:test'
import { flattenTasks, type TaskFeed } from './TasksPanel'
import type { ChatMsg } from '../lib/blocks'

function feed(toolUseId: string, extra?: Partial<TaskFeed>): TaskFeed {
  return { toolUseId, status: 'running', messages: [], ...extra }
}

/** 父桶转录里包含一条 Agent tool_use 块（嵌套 agent 的调用现场） */
function parentFeed(toolUseId: string, childToolUseIds: string[]): TaskFeed {
  const messages: ChatMsg[] = [
    {
      id: 'm1',
      role: 'assistant',
      blocks: childToolUseIds.map((id) => ({ kind: 'tool' as const, id, name: 'Agent' })),
    },
  ]
  return feed(toolUseId, { messages })
}

describe('flattenTasks', () => {
  test('平坦列表保持插入序，全部 depth 0', () => {
    const flat = flattenTasks([feed('a'), feed('b'), feed('c')])
    expect(flat.map((f) => f.feed.toolUseId)).toEqual(['a', 'b', 'c'])
    expect(flat.every((f) => f.depth === 0)).toBe(true)
  })

  test('显式 parentToolUseId：孩子紧跟父亲，深度递增', () => {
    const flat = flattenTasks([
      feed('child2', { parentToolUseId: 'root' }),
      feed('root'),
      feed('child1', { parentToolUseId: 'root' }),
      feed('grand', { parentToolUseId: 'child1' }),
    ])
    expect(flat.map((f) => [f.feed.toolUseId, f.depth])).toEqual([
      ['root', 0],
      ['child2', 1],
      ['child1', 1],
      ['grand', 2],
    ])
  })

  test('无 parentToolUseId 时从父桶转录的工具块归属反推', () => {
    const flat = flattenTasks([parentFeed('root', ['x1', 'x2']), feed('x1'), feed('x2'), feed('other')])
    expect(flat.map((f) => [f.feed.toolUseId, f.depth])).toEqual([
      ['root', 0],
      ['x1', 1],
      ['x2', 1],
      ['other', 0],
    ])
  })

  test('显式字段优先于转录反推', () => {
    // 转录会把 x1 反推给 root，但显式 parentToolUseId 指向别的桶（不在列表）→ 作为 root
    const flat = flattenTasks([parentFeed('root', ['x1']), feed('x1', { parentToolUseId: 'gone' })])
    expect(flat.map((f) => [f.feed.toolUseId, f.depth])).toEqual([
      ['root', 0],
      ['x1', 0],
    ])
  })

  test('父已驱逐（不在列表）的孤儿作为 root，不丢卡', () => {
    const flat = flattenTasks([feed('orphan', { parentToolUseId: 'gone' })])
    expect(flat).toEqual([{ feed: expect.objectContaining({ toolUseId: 'orphan' }), depth: 0 }])
  })

  test('成环数据不死循环、不丢卡', () => {
    const flat = flattenTasks([
      feed('a', { parentToolUseId: 'b' }),
      feed('b', { parentToolUseId: 'a' }),
    ])
    expect(flat.length).toBe(2)
  })
})
