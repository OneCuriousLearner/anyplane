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

describe('CodexRuntime app-server 闲置回收', () => {
  /** TS private 是编译期概念，测试直接注入假 rpc */
  function withFakeRpc(rt: CodexRuntime, onKill: () => void) {
    ;(rt as unknown as { rpc: unknown }).rpc = { exited: false, kill: onKill }
  }

  test('无会话无收集器：到时 kill 且置空 rpc', async () => {
    const rt = new CodexRuntime()
    let killed = 0
    withFakeRpc(rt, () => killed++)
    rt.scheduleRpcIdleShutdownIfIdle(30)
    await new Promise((r) => setTimeout(r, 80))
    expect(killed).toBe(1)
    expect(rt.peekRpc()).toBeUndefined()
  })

  test('有 live 会话句柄：不回收', async () => {
    const rt = new CodexRuntime()
    let killed = 0
    withFakeRpc(rt, () => killed++)
    rt.ensure('xn|%2Ftmp', { cwd: '/tmp' }, {
      onMessage: () => {},
      onApprovalRequest: () => {},
      onExit: () => {},
      onStatusChange: () => {},
    })
    rt.scheduleRpcIdleShutdownIfIdle(30)
    await new Promise((r) => setTimeout(r, 80))
    expect(killed).toBe(0)
  })

  test('dispose 最后一个会话句柄自动进入回收倒计时；期间再来新会话则取消', async () => {
    const rt = new CodexRuntime()
    let killed = 0
    withFakeRpc(rt, () => killed++)
    rt.ensure('xn|%2Ftmp', { cwd: '/tmp' }, {
      onMessage: () => {},
      onApprovalRequest: () => {},
      onExit: () => {},
      onStatusChange: () => {},
    })
    // dispose 时 sessions 仍非空？不——dispose 先删键再调度，所以倒计时已启动
    rt.dispose('xn|%2Ftmp')
    await new Promise((r) => setTimeout(r, 10))
    // 倒计时进行中来了新会话：ensure 不直接取消（取消在 ensureRpc），但回收条件复查 sessions.size
    rt.ensure('xn|%2Ftmp2', { cwd: '/tmp' }, {
      onMessage: () => {},
      onApprovalRequest: () => {},
      onExit: () => {},
      onStatusChange: () => {},
    })
    await new Promise((r) => setTimeout(r, 80))
    expect(killed).toBe(0)
  })
})
