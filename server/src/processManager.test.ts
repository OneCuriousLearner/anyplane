import { afterEach, describe, expect, test } from 'bun:test'
import { config } from './config'
import { ClaudeSession } from './processManager'

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
})
