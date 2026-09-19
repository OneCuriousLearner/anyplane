import { afterAll, describe, expect, test } from 'bun:test'
import { keyFor as claudeKeyFor, keyForBranch, keyForNew as claudeKeyForNew } from './claude/backend'
import { keyFor as codexKeyFor, keyForNew as codexKeyForNew } from './codex/backend'
import { backendPort, describeKey, isCodexKey, portFor, registerBackend, resetBackendsForTest, resolvedSessionKey, type BackendPort } from './port'

// describeKey 是 key 形状的零 I/O 解析唯一正本（routes/misc、push/fanout 共用）；
// 本测试把它与两后端 keyFor/keyForNew/keyForBranch 构造器的一一对应锁死——
// 构造器改形状时这里必须同步失败，而不是消费方静默落空。
describe('describeKey', () => {
  test('claude existing: s|<slug>|<sessionId>', () => {
    expect(describeKey(claudeKeyFor('-tmp-proj', 'sess-1'))).toEqual({
      backend: 'claude',
      kind: 'existing',
      slug: '-tmp-proj',
      sessionId: 'sess-1',
    })
  })

  test('codex existing: x|<threadId>', () => {
    expect(describeKey(codexKeyFor('th-1'))).toEqual({
      backend: 'codex',
      kind: 'existing',
      sessionId: 'th-1',
    })
  })

  test('claude new: n|<encoded cwd>（含空格与斜杠的 cwd 解码还原）', () => {
    expect(describeKey(claudeKeyForNew('/tmp/my proj'))).toEqual({
      backend: 'claude',
      kind: 'new',
      cwd: '/tmp/my proj',
    })
  })

  test('codex new: xn|<encoded cwd>', () => {
    expect(describeKey(codexKeyForNew('/tmp/my proj'))).toEqual({
      backend: 'codex',
      kind: 'new',
      cwd: '/tmp/my proj',
    })
  })

  test('claude branch: b|<encoded cwd>|<源 sessionId>', () => {
    expect(describeKey(keyForBranch('/tmp/proj', 'src-9'))).toEqual({
      backend: 'claude',
      kind: 'branch',
      cwd: '/tmp/proj',
      sessionId: 'src-9',
    })
  })

  test('畸形 key 一律 null：未知前缀 / 段数不符 / 非法 % 转义 / 空串', () => {
    expect(describeKey('z|whatever')).toBeNull()
    expect(describeKey('s|only-two')).toBeNull()
    expect(describeKey('xn|a|b')).toBeNull()
    expect(describeKey('n|%E4%B8')).toBeNull() // 截断的 UTF-8 转义，decodeURIComponent 抛错
    expect(describeKey('')).toBeNull()
  })
})

describe('resolvedSessionKey', () => {
  const port = {
    keyForExisting: (sessionId: string, cwd?: string) => `s|${cwd ?? ''}|${sessionId}`,
  } as BackendPort

  test('已是 existing 原样返回，不重建', () => {
    expect(resolvedSessionKey(port, 's|slug|sid', 'other', '/tmp')).toBe('s|slug|sid')
    expect(resolvedSessionKey(port, 'x|th-1', 'other')).toBe('x|th-1')
  })

  test('n|/xn|/b| 升成 existing；sessionId 缺席则 undefined', () => {
    expect(resolvedSessionKey(port, 'n|%2Ftmp', 'sid-2', '/tmp/proj')).toBe('s|/tmp/proj|sid-2')
    expect(resolvedSessionKey(port, 'xn|%2Ftmp', 'th-9', '/ignored')).toBe('s|/ignored|th-9')
    expect(resolvedSessionKey(port, 'n|%2Ftmp', undefined, '/tmp')).toBeUndefined()
  })
})

// 注册表（13.3）：契约叶子不自带适配器单例，portFor/backendPort 经 registerBackend 取用。
// 用最小假 port 锁死分发与 fail fast——不测真实适配器（那是各 port 自身测试的事）。
describe('isCodexKey', () => {
  test('前缀判定、不预解码：x|/xn| 为真，损坏 xn| 仍为真', () => {
    expect(isCodexKey('x|th-1')).toBe(true)
    expect(isCodexKey('xn|%2Ftmp')).toBe(true)
    expect(isCodexKey('xn|%E4%B8')).toBe(true)
    expect(isCodexKey('s|slug|sid')).toBe(false)
    expect(isCodexKey('n|%2Ftmp')).toBe(false)
    expect(isCodexKey('b|%2Ftmp|src')).toBe(false)
  })
})

describe('注册表：backendPort / portFor', () => {
  // bun test 单进程跨文件共享注册表：本文件用过假 port，结束后复位清场——
  // 其他文件各自在顶部注册真实适配器，任何执行顺序下都不互相污染（AGENTS.md 复位口纪律）
  afterAll(() => resetBackendsForTest())

  const fakePort = (name: 'claude' | 'codex') => ({ name }) as BackendPort

  test('未注册即取用 fail fast（编程错误不是静默 undefined）', () => {
    resetBackendsForTest()
    expect(() => backendPort('claude')).toThrow('未注册')
    expect(() => portFor('s|slug|sid')).toThrow('未注册')
  })

  test('portFor 按 key 前缀分发：x|/xn| → codex，其余 → claude', () => {
    resetBackendsForTest()
    const claude = fakePort('claude')
    const codex = fakePort('codex')
    registerBackend('claude', claude)
    registerBackend('codex', codex)
    expect(portFor('s|slug|sid')).toBe(claude)
    expect(portFor('n|%2Ftmp')).toBe(claude)
    expect(portFor('b|%2Ftmp|src')).toBe(claude)
    expect(portFor('x|th-1')).toBe(codex)
    expect(portFor('xn|%2Ftmp')).toBe(codex)
    // 损坏的 xn| 编码历史上也走 codex 兜底（逐字等价 isCodexKey，不预解码）
    expect(portFor('xn|%E4%B8')).toBe(codex)
    expect(backendPort('claude')).toBe(claude)
    expect(backendPort('codex')).toBe(codex)
  })
})
