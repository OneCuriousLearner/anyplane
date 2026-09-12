import { describe, expect, test } from 'bun:test'
import { CodexRuntime } from './runtime'

describe('readHistory 双轨（paginated 分页 / legacy thread/read）', () => {
  /** rpcRequest 打桩：按 method 路由到录制表，返回 canned 应答 */
  const stubRpc = (handlers: Record<string, (params: Record<string, unknown>) => unknown>) => {
    const runtime = new CodexRuntime()
    const calls: Array<{ method: string; params: Record<string, unknown> }> = []
    ;(runtime as unknown as { rpcRequest: unknown }).rpcRequest = async (method: string, params?: unknown) => {
      const p = (params ?? {}) as Record<string, unknown>
      calls.push({ method, params: p })
      const h = handlers[method]
      if (!h) throw new Error(`未打桩的 RPC: ${method}`)
      return h(p)
    }
    return { runtime, calls }
  }

  test('legacy 线程：thread/read includeTurns 单链路（不分页），轮首 userMessage 以 turnId 为锚', async () => {
    const { runtime, calls } = stubRpc({
      'thread/read': (p) =>
        p.includeTurns
          ? {
              thread: {
                historyMode: 'legacy',
                turns: [
                  {
                    id: 'turn-1',
                    items: [
                      { id: 'u1', type: 'userMessage', content: [{ type: 'text', text: '问题' }] },
                      { id: 'a1', type: 'agentMessage', text: '回答' },
                    ],
                  },
                ],
              },
            }
          : { thread: { historyMode: 'legacy' } },
    })
    const msgs = await runtime.readHistory('th-legacy')
    expect(calls.map((c) => c.method)).toEqual(['thread/read', 'thread/read'])
    expect(calls.some((c) => c.method.includes('list'))).toBe(false)
    expect(msgs.map((m) => [m.uuid, m.role])).toEqual([
      ['turn-1', 'user'],
      ['a1', 'assistant'],
    ])
    expect(msgs[0].rewindable).toBe(true)
  })

  test('paginated 线程：turns/list asc + items/list 分页；工具卡完整（legacy 缺口修复路径）', async () => {
    const { runtime, calls } = stubRpc({
      'thread/read': () => ({ thread: { historyMode: 'paginated' } }),
      'thread/turns/list': (p) =>
        p.cursor === 'tc1'
          ? {
              data: [{ id: 'turn-2', startedAt: 200, completedAt: 250 }],
              nextCursor: null,
            }
          : { data: [{ id: 'turn-1', startedAt: 100, completedAt: 150 }], nextCursor: 'tc1' },
      'thread/items/list': (p) =>
        p.cursor === 'ic1'
          ? {
              data: [
                { turnId: 'turn-2', item: { id: 'u2', type: 'userMessage', content: [{ type: 'text', text: '继续' }] } },
                { turnId: 'turn-2', item: { id: 'c2', type: 'commandExecution', command: 'ls', aggregatedOutput: 'ok', exitCode: 0, status: 'completed' } },
              ],
              nextCursor: null,
            }
          : {
              data: [
                { turnId: 'turn-1', item: { id: 'u1', type: 'userMessage', content: [{ type: 'text', text: '开始' }] } },
                { turnId: 'turn-1', item: { id: 'r1', type: 'reasoning', summary: ['想了想'], content: [] } },
                { turnId: 'turn-1', item: { id: 'c1', type: 'commandExecution', command: 'echo hi', aggregatedOutput: 'hi\n', exitCode: 0, status: 'completed' } },
                { turnId: 'turn-1', item: { id: 'a1', type: 'agentMessage', text: '完成' } },
              ],
              nextCursor: 'ic1',
            },
    })
    const msgs = await runtime.readHistory('th-page')
    // turns/list 必须显式 asc（默认 desc 会把顺序弄反，实测）；items/list 跨 turn 分页
    const turnsCalls = calls.filter((c) => c.method === 'thread/turns/list')
    expect(turnsCalls[0].params.sortDirection).toBe('asc')
    expect(turnsCalls.map((c) => c.params.cursor)).toEqual([undefined, 'tc1'])
    expect(calls.filter((c) => c.method === 'thread/items/list').map((c) => c.params.cursor)).toEqual([undefined, 'ic1'])
    // 内容：commandExecution 出工具卡对（legacy thread/read 缺这类 item，是刷新丢卡的根因）
    const kinds = msgs.flatMap((m) => m.blocks.map((b) => b.kind))
    expect(kinds).toContain('tool_use')
    expect(kinds).toContain('tool_result')
    expect(kinds).toContain('thinking')
    // 每轮首条 userMessage 以各自 turnId 为锚（rewindable）
    const users = msgs.filter((m) => m.role === 'user' && m.blocks.some((b) => b.kind === 'text'))
    expect(users.map((m) => m.uuid)).toEqual(['turn-1', 'turn-2'])
    expect(users.every((m) => m.rewindable)).toBe(true)
  })

  test('paginated：item 的 turnId 不在 turns/list 时按末段追加，不静默丢弃', async () => {
    const { runtime } = stubRpc({
      'thread/read': () => ({ thread: { historyMode: 'paginated' } }),
      'thread/turns/list': () => ({ data: [{ id: 'turn-1' }], nextCursor: null }),
      'thread/items/list': () => ({
        data: [
          { turnId: 'turn-1', item: { id: 'u1', type: 'userMessage', content: [{ type: 'text', text: '在册' }] } },
          { turnId: 'turn-x', item: { id: 'u9', type: 'userMessage', content: [{ type: 'text', text: '编外' }] } },
        ],
        nextCursor: null,
      }),
    })
    const msgs = await runtime.readHistory('th-page2')
    expect(msgs.map((m) => m.uuid)).toEqual(['turn-1', 'turn-x'])
  })
})

describe('thread/reverted 通知与回滚 RPC', () => {
  test('revertAt 发 thread/revert；historyModeOf 无在线会话时走 thread/read 惰性解析', async () => {
    const runtime = new CodexRuntime()
    const calls: Array<{ method: string; params: Record<string, unknown> }> = []
    ;(runtime as unknown as { rpcRequest: unknown }).rpcRequest = async (method: string, params?: unknown) => {
      calls.push({ method, params: (params ?? {}) as Record<string, unknown> })
      if (method === 'thread/read') return { thread: { historyMode: 'paginated' } }
      return {}
    }
    await runtime.revertAt('th-1', 'turn-3')
    expect(calls[0]).toEqual({ method: 'thread/revert', params: { threadId: 'th-1', beforeTurnId: 'turn-3' } })
    expect(await runtime.historyModeOf('th-1')).toBe('paginated')
    expect(calls[1].params.includeTurns).toBe(false)
  })

  test('thread meta 缓存按 CodexRuntime 实例隔离', async () => {
    const makeRuntime = (mode: string) => {
      const runtime = new CodexRuntime()
      let reads = 0
      ;(runtime as unknown as { rpcRequest: unknown }).rpcRequest = async () => {
        reads++
        return { thread: { historyMode: mode } }
      }
      return { runtime, reads: () => reads }
    }
    const first = makeRuntime('legacy')
    const second = makeRuntime('paginated')

    expect(await first.runtime.threadMeta('same-thread')).toEqual({ historyMode: 'legacy', cwd: undefined })
    expect(await second.runtime.historyModeOf('same-thread')).toBe('paginated')
    expect(await first.runtime.historyModeOf('same-thread')).toBe('legacy')
    expect(first.reads()).toBe(1)
    expect(second.reads()).toBe(1)
  })
})
