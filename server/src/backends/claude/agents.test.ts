import { describe, expect, test } from 'bun:test'
import { backgroundAlive, parseAgentsJson } from './agents'

describe('parseAgentsJson', () => {
  test('解析 interactive 与 background 条目，字段齐全', () => {
    const text = JSON.stringify([
      {
        id: '9b68dc03',
        cwd: '/tmp',
        kind: 'background',
        startedAt: 1787314044888,
        sessionId: '9b68dc03-d3c7-4875-a65f-0e6603d82fe3',
        name: 'pong response',
        state: 'done',
      },
      {
        pid: 3459106,
        cwd: '/data/workspace/cc-remote',
        kind: 'interactive',
        startedAt: 1787811355350,
        sessionId: 'f5c5c987-9ca9-4778-bc68-dfd32d9a948b',
        name: 'free-explore',
        status: 'busy',
      },
    ])
    const map = parseAgentsJson(text)
    expect(map.size).toBe(2)
    const bg = map.get('9b68dc03-d3c7-4875-a65f-0e6603d82fe3')!
    expect(bg.kind).toBe('background')
    expect(bg.state).toBe('done')
    expect(bg.pid).toBeUndefined()
    const interactive = map.get('f5c5c987-9ca9-4778-bc68-dfd32d9a948b')!
    expect(interactive.pid).toBe(3459106)
    expect(interactive.status).toBe('busy')
  })

  test('缺 sessionId / 非对象条目跳过，不炸整体', () => {
    const map = parseAgentsJson(
      JSON.stringify([{ kind: 'background' }, null, 'garbage', { sessionId: 'ok', status: 'idle' }]),
    )
    expect(map.size).toBe(1)
    expect(map.get('ok')!.status).toBe('idle')
  })

  test('非法输入降级为空表', () => {
    expect(parseAgentsJson('not json').size).toBe(0)
    expect(parseAgentsJson('{"a":1}').size).toBe(0)
    expect(parseAgentsJson('').size).toBe(0)
  })

  test('未知字段忽略（宽松原则，官方新增字段不炸）', () => {
    const map = parseAgentsJson(
      JSON.stringify([{ sessionId: 'x', futureField: { nested: true }, kind: 'interactive' }]),
    )
    expect(map.get('x')!.kind).toBe('interactive')
  })
})

describe('backgroundAlive', () => {
  test('运行中算活着', () => {
    expect(backgroundAlive('running')).toBe(true)
    expect(backgroundAlive('queued')).toBe(true)
  })

  test('终态不算活着', () => {
    for (const s of ['done', 'error', 'failed', 'killed', 'stopped', 'cancelled']) {
      expect(backgroundAlive(s)).toBe(false)
    }
  })

  test('无 state 不算活着', () => {
    expect(backgroundAlive(undefined)).toBe(false)
  })
})
