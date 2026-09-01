import { afterEach, describe, expect, test } from 'bun:test'
import { config } from '../../config'
import { ClaudeSession, contextWindowOf, extractUsageFromTranscriptTail } from './processManager'

const originalDetachRecycleMs = config.detachRecycleMs

afterEach(() => {
  config.detachRecycleMs = originalDetachRecycleMs
})

describe('ClaudeSession background task lifecycle', () => {
  test('does not recycle an idle, detached session while a background task is active', async () => {
    // Keep the test short while exercising the real recycle timer and gate.
    config.detachRecycleMs = 20
    const exits: number[] = []
    const session = new ClaudeSession('test-task-lifecycle', { cwd: process.cwd() }, {
      onMessage: () => {},
      onApprovalRequest: () => {},
      onExit: (code) => exits.push(code),
    })
    const handleLine = (session as unknown as { handleLine(line: string): void }).handleLine.bind(session)

    handleLine(JSON.stringify({ type: 'system', subtype: 'task_started', task_id: 'agent-1', description: 'scan repository', task_type: 'local_agent' }))
    handleLine(JSON.stringify({ type: 'system', subtype: 'session_state_changed', state: 'idle' }))
    session.syncClients(0)

    await Bun.sleep(60)
    expect(session.sessionState).toBe('idle')
    expect(session.activeTaskCount).toBe(1)
    expect(session.busy).toBe(true)
    expect(exits).toEqual([])

    handleLine(JSON.stringify({ type: 'system', subtype: 'task_progress', task_id: 'agent-1', last_tool_name: 'Read', summary: 'reading files' }))
    expect(session.backgroundTasks).toEqual([
      expect.objectContaining({ id: 'agent-1', lastToolName: 'Read', summary: 'reading files' }),
    ])

    handleLine(JSON.stringify({ type: 'system', subtype: 'task_notification', task_id: 'agent-1', status: 'completed', summary: 'done' }))
    expect(session.activeTaskCount).toBe(0)
    expect(session.busy).toBe(false)

    await Bun.sleep(60)
    expect(exits).toEqual([-1])
  })
})

describe('ClaudeSession awaited control requests', () => {
  test('matches a successful control response by request ID', async () => {
    const seen: unknown[] = []
    const session = new ClaudeSession('test-awaited-control', { cwd: process.cwd() }, {
      onMessage: (message) => seen.push(message),
      onApprovalRequest: () => {},
      onExit: () => {},
    })
    let requestId = ''
    ;(session as unknown as { write(message: { request_id?: string }): void }).write = (message) => {
      requestId = message.request_id ?? ''
    }
    const handleLine = (session as unknown as { handleLine(line: string): void }).handleLine.bind(session)

    const response = session.sendControlAndWait('rewind_files', { user_message_id: 'message-1' }, 100)
    expect(requestId).not.toBe('')
    handleLine(JSON.stringify({
      type: 'control_response',
      response: { subtype: 'success', request_id: requestId, response: { restored: true } },
    }))

    await expect(response).resolves.toEqual({ restored: true })
    // 已被 sendControlAndWait 消费的应答不透传给普通消息流，避免双重展示
    expect(seen).toHaveLength(0)
  })

  test('rejects an awaited control request when the CLI reports an error', async () => {
    const session = new ClaudeSession('test-awaited-control-error', { cwd: process.cwd() }, {
      onMessage: () => {},
      onApprovalRequest: () => {},
      onExit: () => {},
    })
    let requestId = ''
    ;(session as unknown as { write(message: { request_id?: string }): void }).write = (message) => {
      requestId = message.request_id ?? ''
    }
    const handleLine = (session as unknown as { handleLine(line: string): void }).handleLine.bind(session)

    const response = session.sendControlAndWait('rewind_files', { user_message_id: 'message-1' }, 100)
    handleLine(JSON.stringify({
      type: 'control_response',
      response: { subtype: 'error', request_id: requestId, error: 'checkpoint unavailable' },
    }))

    await expect(response).rejects.toThrow('checkpoint unavailable')
  })

  test('counts a pending awaited control request as busy so recycle stays off', async () => {
    // rewind_files 处理期间 CLI 不发 session_state_changed；等待应答时必须按 busy 处理
    config.detachRecycleMs = 20
    const exits: number[] = []
    const session = new ClaudeSession('test-awaited-control-busy', { cwd: process.cwd() }, {
      onMessage: () => {},
      onApprovalRequest: () => {},
      onExit: (code) => exits.push(code),
    })
    let requestId = ''
    ;(session as unknown as { write(message: { request_id?: string }): void }).write = (message) => {
      requestId = message.request_id ?? ''
    }
    const handleLine = (session as unknown as { handleLine(line: string): void }).handleLine.bind(session)

    // 启用权威状态事件，回收才走 detachRecycleMs（否则回退到 30min 的 idleTimeoutMs）
    handleLine(JSON.stringify({ type: 'system', subtype: 'session_state_changed', state: 'idle' }))

    const response = session.sendControlAndWait('rewind_files', { user_message_id: 'message-1' }, 500)
    session.syncClients(0)
    expect(session.busy).toBe(true)
    await Bun.sleep(60) // 远超 20ms 的回收窗口：若未计入 busy 已被回收
    expect(exits).toEqual([])

    handleLine(JSON.stringify({
      type: 'control_response',
      response: { subtype: 'success', request_id: requestId, response: {} },
    }))
    await expect(response).resolves.toEqual({})
    expect(session.busy).toBe(false)

    await Bun.sleep(60) // 应答后恢复空闲，正常回收
    expect(exits).toEqual([-1])
  })

  test('pushes a status change when the awaited control request settles (busy flips back)', async () => {
    // 回归：详情面板（get_context_usage 等纯控制查询）触发懒 spawn 后，会话收不到
    // session_state_changed；若应答/超时不清除 pending 时不推状态，前端"工作中"永挂。
    let statusPushes = 0
    const session = new ClaudeSession('test-awaited-control-status', { cwd: process.cwd() }, {
      onMessage: () => {},
      onApprovalRequest: () => {},
      onExit: () => {},
      onStatusChange: () => statusPushes++,
    })
    let requestId = ''
    ;(session as unknown as { write(message: { request_id?: string }): void }).write = (message) => {
      requestId = message.request_id ?? ''
    }
    const handleLine = (session as unknown as { handleLine(line: string): void }).handleLine.bind(session)

    const response = session.sendControlAndWait('get_context_usage', {}, 500)
    expect(session.busy).toBe(true)
    const beforeReply = statusPushes
    handleLine(JSON.stringify({
      type: 'control_response',
      response: { subtype: 'success', request_id: requestId, response: {} },
    }))
    await expect(response).resolves.toEqual({})
    expect(session.busy).toBe(false)
    expect(statusPushes).toBeGreaterThan(beforeReply)
  })

  test('pushes a status change when the awaited control request times out', async () => {
    let statusPushes = 0
    const session = new ClaudeSession('test-awaited-control-timeout', { cwd: process.cwd() }, {
      onMessage: () => {},
      onApprovalRequest: () => {},
      onExit: () => {},
      onStatusChange: () => statusPushes++,
    })
    ;(session as unknown as { write(message: unknown): void }).write = () => {}

    const response = session.sendControlAndWait('get_context_usage', {}, 20)
    expect(session.busy).toBe(true)
    const beforeTimeout = statusPushes
    await expect(response).rejects.toThrow('超时')
    expect(session.busy).toBe(false)
    expect(statusPushes).toBeGreaterThan(beforeTimeout)
  })
})

describe('contextWindowOf（官方 getContextWindowForModel 的 headless 近似）', () => {
  const envKey = 'CLAUDE_CODE_DISABLE_1M_CONTEXT'
  const saved = process.env[envKey]
  const restore = () => {
    if (saved === undefined) delete process.env[envKey]
    else process.env[envKey] = saved
  }

  test('[1m] 后缀 → 1M（大小写不敏感），否则 200k', () => {
    delete process.env[envKey]
    expect(contextWindowOf('k3[1m]')).toBe(1_000_000)
    expect(contextWindowOf('claude-sonnet-4-6[1M]')).toBe(1_000_000)
    expect(contextWindowOf('claude-opus-4-6')).toBe(200_000)
    expect(contextWindowOf(undefined)).toBe(200_000)
    restore()
  })

  test('CLAUDE_CODE_DISABLE_1M_CONTEXT 为真时恒 200k', () => {
    process.env[envKey] = '1'
    expect(contextWindowOf('k3[1m]')).toBe(200_000)
    process.env[envKey] = 'true'
    expect(contextWindowOf('k3[1m]')).toBe(200_000)
    process.env[envKey] = '0'
    expect(contextWindowOf('k3[1m]')).toBe(1_000_000)
    restore()
  })
})

describe('ClaudeSession contextUsage（官方 statusline current_usage 的 headless 等价物）', () => {
  const makeSession = () => {
    let statusPushes = 0
    const session = new ClaudeSession('test-context-usage', { cwd: process.cwd() }, {
      onMessage: () => {},
      onApprovalRequest: () => {},
      onExit: () => {},
      onStatusChange: () => statusPushes++,
    })
    const handleLine = (session as unknown as { handleLine(line: string): void }).handleLine.bind(session)
    return { session, handleLine, pushes: () => statusPushes }
  }
  const usage = { input_tokens: 1000, cache_creation_input_tokens: 200, cache_read_input_tokens: 300, output_tokens: 50 }

  test('首个 API 应答前为 undefined；主线 assistant 消息水合', () => {
    const { session, handleLine } = makeSession()
    expect(session.contextUsage).toBeUndefined()
    handleLine(JSON.stringify({
      type: 'assistant',
      parent_tool_use_id: null,
      message: { id: 'msg-1', role: 'assistant', content: [], usage },
    }))
    expect(session.contextUsage).toEqual({
      usedTokens: 1500, // input + cacheWrite + cacheRead（不含 output）
      windowSize: 200_000,
      outputTokens: 50,
      inputTokens: 1000,
      cacheReadTokens: 300,
      cacheWriteTokens: 200,
    })
  })

  test('sidechain（子代理）消息不计入主窗口占用', () => {
    const { session, handleLine } = makeSession()
    handleLine(JSON.stringify({
      type: 'assistant',
      parent_tool_use_id: 'toolu-subagent',
      message: { id: 'msg-sub', role: 'assistant', content: [], usage },
    }))
    expect(session.contextUsage).toBeUndefined()
    handleLine(JSON.stringify({
      type: 'assistant',
      parent_tool_use_id: null,
      isSidechain: true,
      message: { id: 'msg-sub-2', role: 'assistant', content: [], usage },
    }))
    expect(session.contextUsage).toBeUndefined()
  })

  test('相同 usage 按值去重不重复广播；init 的 [1m] 模型驱动 windowSize', () => {
    const { session, handleLine, pushes } = makeSession()
    handleLine(JSON.stringify({ type: 'system', subtype: 'init', session_id: 's-1', model: 'k3[1m]' }))
    const afterInit = pushes()
    const line = JSON.stringify({
      type: 'assistant',
      parent_tool_use_id: null,
      message: { id: 'msg-1', role: 'assistant', content: [], usage },
    })
    handleLine(line)
    expect(pushes()).toBe(afterInit + 1)
    handleLine(line) // 同一 message 的后续块（thinking/text）携带相同 usage → 去重
    expect(pushes()).toBe(afterInit + 1)
    expect(session.contextUsage?.windowSize).toBe(1_000_000)
    // 值变化 → 再广播
    handleLine(JSON.stringify({
      type: 'assistant',
      parent_tool_use_id: null,
      message: { id: 'msg-2', role: 'assistant', content: [], usage: { ...usage, input_tokens: 2000 } },
    }))
    expect(pushes()).toBe(afterInit + 2)
    expect(session.contextUsage?.usedTokens).toBe(2500)
  })

  test('result.usage 是 turn 累计：input 侧不写入占用（防翻倍），只取 output 终值', () => {
    const { session, handleLine } = makeSession()
    // 实测场景：2 次 API 调用的 turn（tool_use → 最终文本）
    handleLine(JSON.stringify({
      type: 'assistant',
      parent_tool_use_id: null,
      message: { id: 'msg-1', role: 'assistant', content: [{ type: 'tool_use' }], usage: { input_tokens: 28412, cache_read_input_tokens: 768, cache_creation_input_tokens: 0, output_tokens: 0 } },
    }))
    handleLine(JSON.stringify({
      type: 'assistant',
      parent_tool_use_id: null,
      message: { id: 'msg-2', role: 'assistant', content: [{ type: 'text' }], usage: { input_tokens: 1389, cache_read_input_tokens: 28928, cache_creation_input_tokens: 0, output_tokens: 0 } },
    }))
    // turn 结束时 result 带的是两次调用之和（实测值）
    handleLine(JSON.stringify({
      type: 'result',
      subtype: 'success',
      usage: { input_tokens: 29801, cache_read_input_tokens: 29696, cache_creation_input_tokens: 0, output_tokens: 167 },
    }))
    // 占用必须保持最后一次调用口径（1389+28928），不得变成 turn 总和（29801+29696）
    expect(session.contextUsage?.usedTokens).toBe(30317)
    expect(session.contextUsage?.inputTokens).toBe(1389)
    expect(session.contextUsage?.cacheReadTokens).toBe(28928)
    // output 以 result 的 turn 总输出为终值（assistant 流式快照恒为 0）
    expect(session.contextUsage?.outputTokens).toBe(167)
    // usageAcc 仍按 turn 累计（session 累计口径不变）
    expect(session.tokenUsage.inputTokens).toBe(29801)
    expect(session.tokenUsage.cacheReadTokens).toBe(29696)
  })
})

describe('extractUsageFromTranscriptTail（resume/fork 水合）', () => {
  const line = (over: Record<string, unknown>) => JSON.stringify({
    type: 'assistant',
    isSidechain: false,
    uuid: 'u',
    message: { id: 'msg-x', role: 'assistant', content: [], usage: { input_tokens: 100, cache_read_input_tokens: 50, cache_creation_input_tokens: 10, output_tokens: 7 } },
    ...over,
  })

  test('取尾部最后一条主线 assistant 的 usage；transcript 的 output 为真实值', () => {
    const text = [
      line({ uuid: 'old' }),
      line({ uuid: 'new', message: { id: 'msg-y', role: 'assistant', content: [], usage: { input_tokens: 200, cache_read_input_tokens: 60, cache_creation_input_tokens: 20, output_tokens: 9 } } }),
    ].join('\n')
    expect(extractUsageFromTranscriptTail(text)).toEqual({ inputTokens: 200, outputTokens: 9, cacheReadTokens: 60, cacheWriteTokens: 20 })
  })

  test('sidechain 行与无 usage 行跳过；尾块首行截断容错', () => {
    const side = JSON.stringify({
      type: 'assistant', isSidechain: true,
      message: { id: 'msg-s', role: 'assistant', content: [], usage: { input_tokens: 999, cache_read_input_tokens: 999, cache_creation_input_tokens: 999, output_tokens: 999 } },
    })
    const noUsage = JSON.stringify({ type: 'assistant', isSidechain: false, message: { id: 'msg-n', role: 'assistant', content: [] } })
    const truncated = '{"type":"assistant","isSidechain":false,"message":{"id":"msg-t' // 截断行（尾块首行）
    const text = [line({ uuid: 'main' }), truncated, noUsage, side].join('\n')
    expect(extractUsageFromTranscriptTail(text)).toEqual({ inputTokens: 100, outputTokens: 7, cacheReadTokens: 50, cacheWriteTokens: 10 })
  })

  test('找不到主线 usage 返回 undefined', () => {
    expect(extractUsageFromTranscriptTail('{"type":"user","message":{}}')).toBeUndefined()
    expect(extractUsageFromTranscriptTail('')).toBeUndefined()
  })
})
