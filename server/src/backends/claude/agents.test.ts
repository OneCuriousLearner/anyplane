import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { config } from '../../config'
import { backgroundAlive, daemonAgents, parseAgentsJson, setAgentsCacheForTest, type DaemonAgent } from './agents'

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
        cwd: '/srv/anyplane',
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

// daemonAgents 的 TTL / stale-while-revalidate / MAX_STALE 清空语义（TTL_MS=60s，MAX_STALE_MS=10min）。
// 缓存是模块单态：每个用例经 setAgentsCacheForTest 注入受控时间戳，不依赖文件内/跨文件执行顺序。
describe('daemonAgents：TTL 缓存与陈旧上限', () => {
  const entry: DaemonAgent = { sessionId: 's-1', kind: 'background', state: 'running' }
  const freshMap = () => new Map([[entry.sessionId, entry]])
  let savedClaudePath: string | undefined

  beforeEach(() => {
    setAgentsCacheForTest(undefined)
    // 冷启动/过期路径会触发后台 refresh（spawn `claude agents --json --all`）。
    // 把 claudePath 指到本测试文件（存在但不可执行）让 spawn 立即失败走静默降级——
    // 本机与 CI 都不真起 CLI，也不依赖 claude 是否在 PATH（refresh 失败语义即保持旧缓存）
    savedClaudePath = config.claudePath
    config.claudePath = import.meta.path
  })

  afterEach(() => {
    config.claudePath = savedClaudePath
    setAgentsCacheForTest(undefined)
  })

  test('冷启动无缓存：返回空表（首轮为空是约定，后台刷新异步补）', () => {
    const got = daemonAgents()
    expect(got.size).toBe(0)
  })

  test('TTL 内命中：原样返回缓存实例', () => {
    const map = freshMap()
    setAgentsCacheForTest({ at: Date.now() - 1_000, map })
    expect(daemonAgents()).toBe(map)
  })

  test('TTL 过期但未超陈旧上限：旧数据照常下发（stale-while-revalidate）', () => {
    const map = freshMap()
    setAgentsCacheForTest({ at: Date.now() - 61_000, map })
    expect(daemonAgents()).toBe(map)
  })

  test('超过 MAX_STALE：清空缓存返回空表——CLI 长期失败/被卸载时旧缓存不得留 busy 幽灵会话', () => {
    const map = freshMap()
    setAgentsCacheForTest({ at: Date.now() - 11 * 60_000, map })
    const got = daemonAgents()
    expect(got.size).toBe(0)
    expect(got).not.toBe(map)
    // 清空是持久的：再调仍为空（不是返回上一拍的旧值）
    expect(daemonAgents().size).toBe(0)
  })
})
