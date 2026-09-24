// selectHistoryBuckets 纯函数单测：历史加载时哪些 subagent 该回填成桶
import { describe, expect, test } from 'bun:test'
import type { SubagentHistory } from '@anyplane/protocol'
import type { ChatMsg } from '../lib/blocks'
import { isBackgroundRunningResult, selectHistoryBuckets } from './useTaskBuckets'

describe('isBackgroundRunningResult：后台运行声明不算终态（上游三变体同构）', () => {
  test('run_in_background / 手动 backgrounded / 超预算自动后台都识别', () => {
    expect(isBackgroundRunningResult('Command running in background with ID: b1. Output is being written to: /tmp/o')).toBe(true)
    expect(isBackgroundRunningResult('Command was manually backgrounded by user with ID: b2. Output is being written to: /tmp/o')).toBe(true)
    expect(
      isBackgroundRunningResult(
        'Command exceeded the assistant-mode blocking budget (10s) and was moved to the background with ID: b3. It is still running — you will be notified when it completes.',
      ),
    ).toBe(true)
  })
  test('正常完成的输出不误判（含 background 字样但无 ID 声明）', () => {
    expect(isBackgroundRunningResult('still-going')).toBe(false)
    expect(isBackgroundRunningResult('background job finished, exit 0')).toBe(false)
    expect(isBackgroundRunningResult('')).toBe(false)
  })
})

const agentMsg = (id: string, pending: boolean | undefined): ChatMsg => ({
  id: `m-${id}`,
  role: 'assistant',
  blocks: [{ kind: 'tool', id, name: 'Agent', input: {}, ...(pending === undefined ? {} : { pending }) }],
})

const sub = (toolUseId: string, agentId = `a-${toolUseId}`): SubagentHistory => ({
  toolUseId,
  agentId,
  messages: [{ uuid: `s-${toolUseId}`, role: 'assistant', blocks: [{ kind: 'text', text: 'x' }] }],
})

describe('selectHistoryBuckets：历史桶回填口径', () => {
  test('窗口内未完成（pending=true/缺省）建桶；已完成（pending=false）不建', () => {
    const msgs = [agentMsg('t-run', true), agentMsg('t-done', false), agentMsg('t-noflag', undefined)]
    const picked = selectHistoryBuckets(msgs, [sub('t-run'), sub('t-done'), sub('t-noflag')])
    expect(picked.map((s) => s.toolUseId)).toEqual(['t-run', 't-noflag'])
  })

  test('调用在历史分页窗口之外（消息未下发）一律不建桶——状态不可考，靠 activeTasks 水合兜底', () => {
    // 主线只有无关消息：subagent 的 tool_use 不在已加载窗口内
    const msgs: ChatMsg[] = [{ id: 'm1', role: 'user', blocks: [{ kind: 'text', text: '问' }] }]
    const picked = selectHistoryBuckets(msgs, [sub('t-old-1'), sub('t-old-2')])
    expect(picked).toEqual([])
  })

  test('Task 工具名同口径；无 toolUseId/agentId 的条目跳过；subagents 缺省返回空', () => {
    const msgs: ChatMsg[] = [
      { id: 'm1', role: 'assistant', blocks: [{ kind: 'tool', id: 't-task', name: 'Task', input: {}, pending: true }] },
    ]
    const picked = selectHistoryBuckets(msgs, [sub('t-task'), { messages: [] } as SubagentHistory])
    expect(picked.map((s) => s.toolUseId)).toEqual(['t-task'])
    expect(selectHistoryBuckets(msgs, undefined)).toEqual([])
  })

  test('非 Agent/Task 工具块不参与判定', () => {
    const msgs: ChatMsg[] = [
      { id: 'm1', role: 'assistant', blocks: [{ kind: 'tool', id: 't-bash', name: 'Bash', input: {}, pending: true }] },
    ]
    expect(selectHistoryBuckets(msgs, [sub('t-bash')])).toEqual([])
  })
})
