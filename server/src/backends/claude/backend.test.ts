import { describe, expect, test } from 'bun:test'
import { splitExistingKey } from './backend'

// splitExistingKey 是 key → ~/.claude/projects/ 文件路径的唯一入口（rename/archive/restore/tailer），
// 字符集闸必须挡住路径遍历与分隔符注入。
describe('splitExistingKey', () => {
  test('合法 s| key 解析', () => {
    expect(splitExistingKey('s|-data-workspace-anyplane|01a03cac-3fdc-7b80-9c5d-f14ba518f4dc')).toEqual({
      slug: '-data-workspace-anyplane',
      sessionId: '01a03cac-3fdc-7b80-9c5d-f14ba518f4dc',
    })
  })

  test('路径遍历一律拒绝', () => {
    expect(splitExistingKey('s|../foo|bar')).toBeNull()
    expect(splitExistingKey('s|..|bar')).toBeNull()
    expect(splitExistingKey('s|foo|..')).toBeNull()
    expect(splitExistingKey('s|foo/bar|baz')).toBeNull()
    expect(splitExistingKey('s|foo|bar/baz')).toBeNull()
    expect(splitExistingKey('s|foo\\bar|baz')).toBeNull()
    expect(splitExistingKey('s|foo|bar.exe')).toBeNull()
    expect(splitExistingKey('s|%2e%2e|bar')).toBeNull()
  })

  test('非 s| 形状拒绝', () => {
    expect(splitExistingKey('n|%2Ftmp')).toBeNull()
    expect(splitExistingKey('b|%2Ftmp|sid')).toBeNull()
    expect(splitExistingKey('x|thread-id')).toBeNull()
    expect(splitExistingKey('s|only-two')).toBeNull()
    expect(splitExistingKey('s|a|b|c')).toBeNull()
    expect(splitExistingKey('')).toBeNull()
  })
})
