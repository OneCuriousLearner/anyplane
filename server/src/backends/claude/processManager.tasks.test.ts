// 嵌套 agent 血缘：toolUseParents 从侧链 assistant 消息推导（Agent/Task tool_use →
// 父任务 tool_use_id），task_started 时随 spawn_depth 一起写入任务表。

import { describe, expect, test } from 'bun:test'
import { ClaudeSession } from './processManager'

function makeSession(): ClaudeSession {
  return new ClaudeSession('test|nested', { cwd: '/tmp' }, {
    onMessage: () => {},
    onApprovalRequest: () => {},
    onExit: () => {},
    onStatusChange: () => {},
  })
}

/** 侧链 assistant 消息：父任务转录里扇出嵌套 agent 的 tool_use 现场 */
function sidechainToolUse(parentToolUseId: string, toolUseId: string, name: string): string {
  return JSON.stringify({
    type: 'assistant',
    parent_tool_use_id: parentToolUseId,
    message: { role: 'assistant', content: [{ type: 'tool_use', id: toolUseId, name, input: {} }] },
  })
}

function taskStarted(taskId: string, toolUseId: string, depth: number): string {
  return JSON.stringify({
    type: 'system',
    subtype: 'task_started',
    task_id: taskId,
    tool_use_id: toolUseId,
    description: taskId,
    spawn_depth: depth,
    task_type: 'local_agent',
  })
}

describe('嵌套 agent 血缘（toolUseParents）', () => {
  test('task_started 写入 depth；侧链 Agent tool_use 先于它到达时回填 parentToolUseId', () => {
    const s = makeSession()
    s.injectLine(taskStarted('task-parent', 'tool-parent', 1))
    // 父代理转录里的嵌套扇出（实测先于子任务 task_started 到达）
    s.injectLine(sidechainToolUse('tool-parent', 'tool-child', 'Agent'))
    s.injectLine(taskStarted('task-child', 'tool-child', 2))

    const tasks = s.backgroundTasks
    const parent = tasks.find((t) => t.id === 'task-parent')
    const child = tasks.find((t) => t.id === 'task-child')
    expect(parent).toMatchObject({ depth: 1, toolUseId: 'tool-parent' })
    expect(parent?.parentToolUseId).toBeUndefined()
    expect(child).toMatchObject({ depth: 2, parentToolUseId: 'tool-parent' })
  })

  test('只记录 Agent/Task 调用：普通工具不产生血缘', () => {
    const s = makeSession()
    s.injectLine(taskStarted('task-parent', 'tool-parent', 1))
    s.injectLine(sidechainToolUse('tool-parent', 'tool-bash', 'Bash'))
    s.injectLine(taskStarted('task-shell', 'tool-bash', 1))
    expect(s.backgroundTasks.find((t) => t.id === 'task-shell')?.parentToolUseId).toBeUndefined()
  })

  test('无侧链信息的任务 parentToolUseId 为 undefined（主线直发）', () => {
    const s = makeSession()
    s.injectLine(taskStarted('task-top', 'tool-top', 1))
    expect(s.backgroundTasks[0]).toMatchObject({ depth: 1, parentToolUseId: undefined })
  })

  test('task_notification 摘除任务', () => {
    const s = makeSession()
    s.injectLine(taskStarted('task-1', 'tool-1', 1))
    s.injectLine(JSON.stringify({ type: 'system', subtype: 'task_notification', task_id: 'task-1', status: 'completed' }))
    expect(s.backgroundTasks).toHaveLength(0)
  })
})
