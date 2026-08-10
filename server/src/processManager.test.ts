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
