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

  test('dispose 最后句柄后进入回收倒计时；回调触发时复查 sessions.size，已有新会话则跳过 kill', async () => {
    const rt = new CodexRuntime()
    let killed = 0
    withFakeRpc(rt, () => killed++)
    rt.ensure('xn|%2Ftmp', { cwd: '/tmp' }, {
      onMessage: () => {},
      onApprovalRequest: () => {},
      onExit: () => {},
      onStatusChange: () => {},
    })
    // dispose 先删键再以默认 10min 延迟调度回收——测试等不了默认延迟，
    // 以短延迟重设同一计时器（schedule 开头会 cancel 既有），模拟倒计时临近触发
    rt.dispose('xn|%2Ftmp')
    rt.scheduleRpcIdleShutdownIfIdle(30)
    // 倒计时进行中来了新会话：ensure 不直接取消计时器（取消在 ensureRpc），
    // 回调里的 sessions.size 复查是最后防线——删掉它本用例即红
    rt.ensure('xn|%2Ftmp2', { cwd: '/tmp' }, {
      onMessage: () => {},
      onApprovalRequest: () => {},
      onExit: () => {},
      onStatusChange: () => {},
    })
    await new Promise((r) => setTimeout(r, 80))
    expect(killed).toBe(0)
    expect(rt.peekRpc()).toBeDefined()
  })
})

describe('CodexRuntime.runEphemeralTitleQuestion（E4 AI 标题）', () => {
  /** fake rpcRequest：记录调用、按线程驱动 collector 全流程（fork→turn/start→item/completed→turn/completed） */
  function withTitleFlow(rt: CodexRuntime, opts: { answerText: string; captureModel?: (m: unknown) => void; captureSchema?: (s: unknown) => void }) {
    const forkId = 'fork-title-1'
    ;(rt as unknown as { rpcRequest: unknown }).rpcRequest = async (method: string, params: Record<string, unknown>) => {
      if (method === 'thread/fork') return { thread: { id: forkId } }
      if (method === 'turn/start') {
        opts.captureModel?.(params.model)
        opts.captureSchema?.(params.outputSchema)
        return {}
      }
      if (method === 'turn/interrupt') return {}
      throw new Error(`unexpected rpc ${method}`)
    }
    return forkId
  }

  test('output_schema ≤36 字符 + 模型透传 + JSON 解析取 title', async () => {
    const rt = new CodexRuntime()
    let model: unknown
    let schema: unknown
    const forkId = withTitleFlow(rt, {
      answerText: '{"title":"修复登录页崩溃"}',
      captureModel: (m) => (model = m),
      captureSchema: (s) => (schema = s),
    })
    // turn/start 后手动喂 collector：agentMessage + turn/completed
    const promise = rt.runEphemeralTitleQuestion('src-tid', '帮我看看登录页点登录就白屏', 'k3-256k')
    // 等 collector 注册（turn/start 已发）
    await new Promise((r) => setTimeout(r, 10))
    const feed = (rt as unknown as { feedCollector: (t: string, c: unknown, m: string, p: unknown) => void }).feedCollector.bind(rt)
    const col = (rt as unknown as { collectors: Map<string, unknown> }).collectors.get(forkId)
    feed(forkId, col, 'item/completed', { item: { type: 'agentMessage', text: '{"title":"修复登录页崩溃"}' } })
    feed(forkId, col, 'turn/completed', { turn: { status: 'completed' } })

    await expect(promise).resolves.toBe('修复登录页崩溃')
    expect(model).toBe('k3-256k')
    expect(schema).toMatchObject({
      type: 'object',
      properties: { title: { type: 'string', maxLength: 36 } },
      required: ['title'],
      additionalProperties: false,
    })
  })

  test('非 JSON 回答兜原文；model undefined 时不带 model 字段', async () => {
    const rt = new CodexRuntime()
    let model: unknown = 'unset'
    const forkId = withTitleFlow(rt, { answerText: '会话标题纯文本', captureModel: (m) => (model = m) })
    const promise = rt.runEphemeralTitleQuestion('src-tid', '你好', undefined)
    await new Promise((r) => setTimeout(r, 10))
    const feed = (rt as unknown as { feedCollector: (t: string, c: unknown, m: string, p: unknown) => void }).feedCollector.bind(rt)
    const col = (rt as unknown as { collectors: Map<string, unknown> }).collectors.get(forkId)
    feed(forkId, col, 'item/completed', { item: { type: 'agentMessage', text: '会话标题纯文本' } })
    feed(forkId, col, 'turn/completed', { turn: { status: 'completed' } })

    await expect(promise).resolves.toBe('会话标题纯文本')
    expect(model).toBeUndefined() // model undefined → turn/start 不带 model（上游默认）
  })
})
