import { describe, expect, test } from 'bun:test'
import { CodexRuntime } from './runtime'

describe('CodexRuntime.rekey（handoff 播种线程 xn|→x| 重键）', () => {
  test('会话对象不换、map 键跟随真实 threadId；旧键摘除且重复重键返回 false', () => {
    const runtime = new CodexRuntime()
    const s = runtime.ensure('xn|%2Ftmp', { cwd: '/tmp' }, {
      onMessage: () => {},
      onApprovalRequest: () => {},
      onExit: () => {},
      onStatusChange: () => {},
    })
    expect(runtime.get('xn|%2Ftmp')).toBe(s)
    expect(runtime.rekey('xn|%2Ftmp', 'x|tid-1')).toBe(true)
    expect(runtime.get('xn|%2Ftmp')).toBeUndefined()
    expect(runtime.get('x|tid-1')).toBe(s)
    expect(s.key).toBe('x|tid-1')
    expect(runtime.rekey('xn|%2Ftmp', 'x|tid-2')).toBe(false)
  })
})
