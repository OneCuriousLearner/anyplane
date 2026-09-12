// CodexSession：token 用量、工具流式 partial、collab 子线程转发。
import { afterAll, describe, expect, test } from 'bun:test'
import { rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { CodexRuntime } from './runtime'
import { CodexSession } from './session'
import { ThreadTranslator } from './translate'
import { readReasoning } from './reasoningStore'
import type { CliMessage } from '../claude/protocol'

const REASONING_THREAD = `test-child-${crypto.randomUUID()}`
afterAll(() => {
  rmSync(join(homedir(), '.anyplane', 'reasoning', `${REASONING_THREAD}.jsonl`), { force: true })
})

describe('CodexSession contextUsage（tokenUsage/updated → 统一形状）', () => {
  // CodexSession 的 tokenUsage 分支只触字段与回调，不碰 rpc——stub runtime 即可直测
  const makeSession = () => {
    let statusPushes = 0
    const session = new CodexSession('x|thread-1', { cwd: '/tmp' }, {} as never, {
      onMessage: () => {},
      onApprovalRequest: () => {},
      onExit: () => {},
      onStatusChange: () => statusPushes++,
    })
    return { session, pushes: () => statusPushes }
  }
  const payload = {
    tokenUsage: {
      total: { totalTokens: 30000, inputTokens: 29000, cachedInputTokens: 9000, cacheWriteInputTokens: 0, outputTokens: 1000, reasoningOutputTokens: 400 },
      last: { totalTokens: 14589, inputTokens: 14548, cachedInputTokens: 8704, cacheWriteInputTokens: 0, outputTokens: 41, reasoningOutputTokens: 37 },
      modelContextWindow: 996147,
    },
  }

  test('首个通知前为 undefined；last.totalTokens + modelContextWindow 合成窗口占用', () => {
    const { session, pushes } = makeSession()
    expect(session.contextUsage).toBeUndefined()
    session.handleNotification('thread/tokenUsage/updated', payload)
    expect(session.contextUsage).toEqual({
      usedTokens: 14589, // last.totalTokens = 最新活跃上下文大小
      windowSize: 996147,
      outputTokens: 41,
      inputTokens: 14548,
      cacheReadTokens: 8704,
      cacheWriteTokens: 0,
      reasoningTokens: 37,
    })
    expect(pushes()).toBe(1)
  })

  test('旧版缺 modelContextWindow 时保持隐藏；累计用量（tokenUsage）走 total 桶', () => {
    const { session } = makeSession()
    session.handleNotification('thread/tokenUsage/updated', {
      tokenUsage: { total: payload.tokenUsage.total, last: payload.tokenUsage.last },
    })
    expect(session.contextUsage).toBeUndefined()
    expect(session.tokenUsage.inputTokens).toBe(29000)
    expect(session.tokenUsage.reasoningTokens).toBe(400)
  })
})

/** 带真实 CodexRuntime 的会话（translator/threadId 私有字段按测试需要注入） */
const makeSession = (key = 'x|parent-tid') => {
  const runtime = new CodexRuntime()
  const msgs: CliMessage[] = []
  const session = new CodexSession(key, { cwd: '/tmp' }, runtime, {
    onMessage: (m) => msgs.push(m),
    onApprovalRequest: () => {},
    onExit: () => {},
    onStatusChange: () => {},
  })
  const inject = session as unknown as { translator: ThreadTranslator; threadId: string }
  inject.translator = new ThreadTranslator()
  inject.threadId = 'parent-tid'
  const demux = (method: string, params: Record<string, unknown>) =>
    (runtime as unknown as { demux: (m: string, p: Record<string, unknown>) => void }).demux(method, params)
  return { runtime, session, msgs, demux }
}

describe('工具流式部分结果（outputDelta → partial tool_result）', () => {
  test('accumulate 合并：窗口内 delta 合并为一条 append partial；下一窗口只发新增量', async () => {
    const { session, msgs } = makeSession()
    session.handleNotification('item/commandExecution/outputDelta', { itemId: 'c1', delta: 'tick-1\n' })
    session.handleNotification('item/commandExecution/outputDelta', { itemId: 'c1', delta: 'tick-2\n' })
    expect(msgs).toHaveLength(0) // 窗口内不下发
    await Bun.sleep(400)
    const partials = msgs.filter((m) => m.partial === true)
    expect(partials).toHaveLength(1)
    expect(partials[0]).toMatchObject({
      type: 'user',
      partial: true,
      append: true,
      message: { content: [{ type: 'tool_result', tool_use_id: 'c1', content: 'tick-1\ntick-2\n', is_error: false }] },
    })
    // 第二窗口只发新增量（append 模式下行量 ≈ 实际产出，不全量重发）
    session.handleNotification('item/commandExecution/outputDelta', { itemId: 'c1', delta: 'tick-3\n' })
    await Bun.sleep(400)
    const partials2 = msgs.filter((m) => m.partial === true)
    expect(partials2).toHaveLength(2)
    expect(partials2[1]).toMatchObject({ append: true, message: { content: [{ content: 'tick-3\n' }] } })
  })

  test('mcpToolCall/progress 是 latest 语义：只保留最新一条进度，替换下发（无 append 标记）', async () => {
    const { session, msgs } = makeSession()
    session.handleNotification('item/mcpToolCall/progress', { itemId: 'm1', message: '连接中…' })
    session.handleNotification('item/mcpToolCall/progress', { itemId: 'm1', message: '拉取第 3 页' })
    await Bun.sleep(400)
    const partials = msgs.filter((m) => m.partial === true)
    expect(partials).toHaveLength(1)
    expect(partials[0].append).toBeUndefined()
    expect((partials[0].message as { content: Array<{ content: string }> }).content[0].content).toBe('拉取第 3 页')
  })

  test('单窗口超 32KB 截断并带标记（防极端刷频下单元格无界增长）', async () => {
    const { session, msgs } = makeSession()
    session.handleNotification('item/commandExecution/outputDelta', { itemId: 'c1', delta: 'x'.repeat(40 * 1024) })
    await Bun.sleep(400)
    const partials = msgs.filter((m) => m.partial === true)
    expect(partials).toHaveLength(1)
    const text = (partials[0].message as { content: Array<{ content: string }> }).content[0].content
    expect(text.startsWith('…（输出过快，中间有截断）\n')).toBe(true)
    expect(text.length).toBeLessThanOrEqual(32 * 1024 + 64)
  })

  test('终态 item/completed 清缓冲：之后不再下发该工具的 partial', async () => {
    const { session, msgs } = makeSession()
    session.handleNotification('item/commandExecution/outputDelta', { itemId: 'c1', delta: 'partial' })
    session.handleNotification('item/completed', {
      item: { id: 'c1', type: 'commandExecution', status: 'completed', exitCode: 0, aggregatedOutput: 'full output' },
    })
    await Bun.sleep(400)
    expect(msgs.filter((m) => m.partial === true)).toHaveLength(0)
    // 终态 tool_result 走正常路径（权威全文）
    expect(msgs.some((m) => (m.message as { content?: Array<{ content?: string }> })?.content?.[0]?.content === 'full output')).toBe(true)
  })

  test('turn/completed 清空全部缓冲（含 pending 的 flush 计时器）', async () => {
    const { session, msgs } = makeSession()
    session.handleNotification('item/commandExecution/outputDelta', { itemId: 'c1', delta: 'x' })
    session.handleNotification('turn/completed', { turn: { status: 'completed' } })
    await Bun.sleep(400)
    expect(msgs.filter((m) => m.partial === true)).toHaveLength(0)
  })
})

describe('collab 子线程注册与父子事件链转发', () => {
  test('subAgentActivity(started) 与 collab spawn End 都注册子线程路由', () => {
    const { runtime, session, demux } = makeSession()
    const registerCalls: string[] = []
    ;(runtime as unknown as { registerChild: (tid: string) => void }).registerChild = (tid: string) => registerCalls.push(tid)
    session.handleNotification('item/completed', {
      item: { id: 'e1', type: 'subAgentActivity', kind: 'started', agentThreadId: 'th-child', agentPath: 'worker' },
    })
    session.handleNotification('item/completed', {
      item: { id: 'call-1', type: 'collabAgentToolCall', tool: 'spawnAgent', status: 'completed', receiverThreadIds: ['th-child-2'] },
    })
    expect(registerCalls).toEqual(['th-child', 'th-child-2'])
    void demux
  })

  test('demux 把子线程 item/completed 转发给父会话（sidechain 形状），delta 不进桶', () => {
    const { runtime, session, msgs, demux } = makeSession()
    runtime.registerChild('th-child', session, 1)
    demux('item/completed', {
      threadId: 'th-child',
      turnId: 'turn-1',
      item: { id: 'm1', type: 'agentMessage', text: '子代理正文' },
    })
    expect(msgs).toEqual([
      {
        type: 'assistant',
        uuid: 'm1',
        parent_tool_use_id: 'th-child',
        message: { role: 'assistant', content: [{ type: 'text', text: '子代理正文' }] },
      },
    ])
    // 子线程的 delta / tokenUsage / turn 级事件一律不进桶
    demux('item/agentMessage/delta', { threadId: 'th-child', itemId: 'm2', delta: '流式片段' })
    demux('thread/tokenUsage/updated', { threadId: 'th-child', tokenUsage: {} })
    demux('turn/completed', { threadId: 'th-child', turn: { status: 'completed' } })
    expect(msgs).toHaveLength(1)
  })

  test('孙代理：子线程内的 collab End 注册孙线程并发 task_started（带父桶血缘与深度）', () => {
    const { runtime, session, msgs, demux } = makeSession()
    runtime.registerChild('th-child', session, 1)
    demux('item/completed', {
      threadId: 'th-child',
      item: {
        id: 'call-9',
        type: 'collabAgentToolCall',
        tool: 'spawnAgent',
        status: 'completed',
        receiverThreadIds: ['th-grand'],
        prompt: '孙任务',
      },
    })
    const started = msgs.find((m) => m.subtype === 'task_started')
    expect(started).toMatchObject({
      tool_use_id: 'th-grand',
      parent_tool_use_id: 'th-child',
      spawn_depth: 2,
    })
    // 孙线程已注册：其后的事件能继续转发到同一父会话
    msgs.length = 0
    demux('item/completed', { threadId: 'th-grand', item: { id: 'g1', type: 'agentMessage', text: '孙正文' } })
    expect(msgs).toEqual([
      expect.objectContaining({ parent_tool_use_id: 'th-grand', uuid: 'g1' }),
    ])
  })

  test('子线程 reasoning：转发 thinking sidechain 并落侧车（itemId 作去重锚点）', () => {
    const { runtime, session, msgs, demux } = makeSession()
    runtime.registerChild(REASONING_THREAD, session, 1)
    demux('item/completed', {
      threadId: REASONING_THREAD,
      turnId: 'turn-7',
      item: { id: 'r-77', type: 'reasoning', summary: ['子代理想了想'], content: [] },
    })
    expect(msgs).toEqual([
      expect.objectContaining({
        type: 'assistant',
        uuid: 'r-77',
        parent_tool_use_id: REASONING_THREAD,
      }),
    ])
    const sidecar = readReasoning(REASONING_THREAD)
    expect(sidecar).toHaveLength(1)
    expect(sidecar[0]).toMatchObject({ turnId: 'turn-7', text: '子代理想了想', itemId: 'r-77' })
  })

  test('父会话 exited 后子线程路由摘除，不再转发', () => {
    const { runtime, session, msgs, demux } = makeSession()
    runtime.registerChild('th-child', session, 1)
    ;(session as unknown as { exited: boolean }).exited = true
    demux('item/completed', { threadId: 'th-child', item: { id: 'm1', type: 'agentMessage', text: 'x' } })
    expect(msgs).toHaveLength(0)
    // 再次注册表已清理：unregisterChildrenOf 后路由 miss
    runtime.unregisterChildrenOf(session)
    ;(session as unknown as { exited: boolean }).exited = false
    demux('item/completed', { threadId: 'th-child', item: { id: 'm2', type: 'agentMessage', text: 'x' } })
    expect(msgs).toHaveLength(0)
  })
})

describe('子线程 userMessage 的 turnId 锚点（与 history 去重同键）', () => {
  test('每轮首条 userMessage uuid=turnId，后续回落 item.id；新一轮重新标记', () => {
    const { runtime, session, msgs, demux } = makeSession()
    runtime.registerChild('th-u', session, 1)
    const user = (id: string) => ({ id, type: 'userMessage', content: [{ type: 'text', text: 'x' }] })
    demux('item/completed', { threadId: 'th-u', turnId: 'turn-1', item: user('u1') })
    demux('item/completed', { threadId: 'th-u', turnId: 'turn-1', item: user('u2') })
    demux('item/completed', { threadId: 'th-u', turnId: 'turn-2', item: user('u3') })
    expect(msgs.map((m) => m.uuid)).toEqual(['turn-1', 'u2', 'turn-2'])
  })
})

describe('thread/reverted 通知', () => {
  test('thread/reverted → 广播 cli 系统消息（入环，重连补发放逐"被回滚的未来"）', () => {
    const { session, msgs } = makeSession()
    session.handleNotification('thread/reverted', { threadId: 'parent-tid' })
    expect(msgs).toEqual([{ type: 'system', subtype: 'thread_reverted' }])
  })
})
