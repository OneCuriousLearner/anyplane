// codex sessionKey 编码：x|<threadId> 已存在线程、xn|<encodeURIComponent(cwd)> 新线程。
// parseKey 是 spawn 参数的唯一入口，编码段损坏必须按"无法解析"（null）而非抛异常处理。
import { describe, expect, test } from 'bun:test'
import { isCodexKey, keyFor, keyForNew, parseKey, splitThreadId } from './backend'

describe('keyFor / keyForNew / isCodexKey', () => {
  test('编码形状', () => {
    expect(keyFor('0198f4d2-7d1e-7e80-a1b2-c3d4e5f60708')).toBe('x|0198f4d2-7d1e-7e80-a1b2-c3d4e5f60708')
    expect(keyForNew('/data/workspace/cc-remote')).toBe('xn|%2Fdata%2Fworkspace%2Fcc-remote')
  })

  test('isCodexKey 与 claude key 互斥', () => {
    expect(isCodexKey('x|abc')).toBe(true)
    expect(isCodexKey('xn|%2Ftmp')).toBe(true)
    expect(isCodexKey('s|slug|sid')).toBe(false)
    expect(isCodexKey('n|%2Ftmp')).toBe(false)
    expect(isCodexKey('b|%2Ftmp|sid')).toBe(false)
    // 注意：xn| 以 x 开头但不以 x| 开头，两段判断缺一不可
    expect(isCodexKey('x')).toBe(false)
  })
})

describe('parseKey', () => {
  test('x| → resumeThreadId；xn| → 解码 cwd', () => {
    expect(parseKey('x|thread-1')).toEqual({ resumeThreadId: 'thread-1' })
    expect(parseKey('xn|%2Fdata%2Fworkspace')).toEqual({ cwd: '/data/workspace' })
  })

  test('中文与空格等需要转义的 cwd 往返无损', () => {
    const cwd = '/home/用户/我的 项目'
    expect(parseKey(keyForNew(cwd))).toEqual({ cwd })
  })

  test('非法形状/损坏编码 → null（不炸掉深链导航）', () => {
    expect(parseKey('s|slug|sid')).toBeNull()
    expect(parseKey('n|%2Ftmp')).toBeNull()
    expect(parseKey('x|a|b')).toBeNull()
    expect(parseKey('x')).toBeNull()
    expect(parseKey('')).toBeNull()
    expect(parseKey('xn|%E4%B8')).toBeNull() // 截断的 UTF-8 百分号编码
  })
})

describe('splitThreadId', () => {
  test('纯形状解析：只有 x| 两段式有 threadId', () => {
    expect(splitThreadId('x|thread-1')).toBe('thread-1')
    expect(splitThreadId('xn|%2Ftmp')).toBeUndefined()
    expect(splitThreadId('s|slug|sid')).toBeUndefined()
    expect(splitThreadId('x|a|b')).toBeUndefined()
  })
})
