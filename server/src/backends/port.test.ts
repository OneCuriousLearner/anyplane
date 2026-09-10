import { describe, expect, test } from 'bun:test'
import { keyFor as claudeKeyFor, keyForBranch, keyForNew as claudeKeyForNew } from './claude/backend'
import { keyFor as codexKeyFor, keyForNew as codexKeyForNew } from './codex/backend'
import { describeKey } from './port'

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
