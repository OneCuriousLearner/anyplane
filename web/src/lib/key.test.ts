// 前端 key 形状判断与服务端 backends/*/backend.ts 的编码一一对应；
// sessionFromKey 是深链（#s=<key>）与归档后导航的兜底构造，损坏编码必须返回 null 而非炸掉导航。
import { describe, expect, test } from 'bun:test'
import { isCodexKey, isExistingKey, sessionFromKey, slugOf } from './key'

describe('isCodexKey / isExistingKey', () => {
  test('codex：x| 与 xn|', () => {
    expect(isCodexKey('x|thread-1')).toBe(true)
    expect(isCodexKey('xn|%2Ftmp')).toBe(true)
    expect(isCodexKey('s|slug|sid')).toBe(false)
    expect(isCodexKey('n|%2Ftmp')).toBe(false)
    expect(isCodexKey('b|%2Ftmp|sid')).toBe(false)
  })

  test('已存在会话（有历史可读）：s| x| b|', () => {
    expect(isExistingKey('s|slug|sid')).toBe(true)
    expect(isExistingKey('x|thread-1')).toBe(true)
    expect(isExistingKey('b|%2Ftmp|sid')).toBe(true)
    expect(isExistingKey('n|%2Ftmp')).toBe(false)
    expect(isExistingKey('xn|%2Ftmp')).toBe(false)
  })
})

describe('slugOf（与服务端 discovery.sanitizePath 一致）', () => {
  test('非字母数字全部转 -', () => {
    expect(slugOf('/data/workspace/anyplane')).toBe('-data-workspace-anyplane')
    expect(slugOf('C:\\Users\\name\\项目')).toBe('C--Users-name---')
  })
})

describe('sessionFromKey', () => {
  test('s| 三段式 → claude 离线会话', () => {
    const s = sessionFromKey('s|-data-workspace|01a03cac-3fdc-7b80-9c5d-f14ba518f4dc')
    expect(s).toMatchObject({
      slug: '-data-workspace',
      sessionId: '01a03cac-3fdc-7b80-9c5d-f14ba518f4dc',
      status: 'offline',
      backend: 'claude',
    })
  })

  test('x| 两段式 → codex 离线线程', () => {
    const s = sessionFromKey('x|thread-9')
    expect(s).toMatchObject({ sessionId: 'thread-9', backend: 'codex', status: 'offline' })
  })

  test('b| 三段式 → 懒分叉：cwd 解码 + slug 重算', () => {
    const s = sessionFromKey('b|%2Fdata%2Fworkspace%2Fanyplane|source-sid')
    expect(s).toMatchObject({
      cwd: '/data/workspace/anyplane',
      slug: '-data-workspace-anyplane',
      sessionId: 'source-sid',
      backend: 'claude',
    })
  })

  test('非法形状与损坏编码 → null', () => {
    expect(sessionFromKey('n|%2Ftmp')).toBeNull() // 新会话没有历史可兜底
    expect(sessionFromKey('xn|%2Ftmp')).toBeNull()
    expect(sessionFromKey('s|only-two')).toBeNull()
    expect(sessionFromKey('x|a|b')).toBeNull()
    expect(sessionFromKey('whatever')).toBeNull()
    expect(sessionFromKey('')).toBeNull()
    expect(sessionFromKey('b|%E4%B8|sid')).toBeNull() // 截断的百分号编码
  })
})
