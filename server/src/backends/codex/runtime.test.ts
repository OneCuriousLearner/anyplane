// 权限模式映射是双后端体验一致的接缝：claude 风格模式与 codex 预设都汇聚到
// approvalPolicy+sandbox；wire 枚举双轨（thread/start 用 kebab-case sandbox，
// turn/start 用 camelCase sandboxPolicy 对象）是本文件锁定的重点。
import { describe, expect, test } from 'bun:test'
import { CodexSession, extractTokenCountFromRolloutTail, mapPermissionMode, sandboxPolicyOf } from './runtime'

describe('mapPermissionMode（codex 原生预设）', () => {
  test('四档预设', () => {
    expect(mapPermissionMode('readOnly')).toEqual({ approvalPolicy: 'on-request', sandbox: 'read-only' })
    expect(mapPermissionMode('workspace')).toEqual({ approvalPolicy: 'on-request', sandbox: 'workspace-write' })
    expect(mapPermissionMode('workspaceAuto')).toEqual({ approvalPolicy: 'never', sandbox: 'workspace-write' })
    expect(mapPermissionMode('fullAccess')).toEqual({ approvalPolicy: 'never', sandbox: 'danger-full-access' })
  })
})

describe('mapPermissionMode（claude 名称近似映射）', () => {
  test('bypassPermissions → 完全访问', () => {
    expect(mapPermissionMode('bypassPermissions')).toEqual({ approvalPolicy: 'never', sandbox: 'danger-full-access' })
  })
  test('acceptEdits/auto → 工作区免审', () => {
    expect(mapPermissionMode('acceptEdits')).toEqual({ approvalPolicy: 'never', sandbox: 'workspace-write' })
    expect(mapPermissionMode('auto')).toEqual({ approvalPolicy: 'never', sandbox: 'workspace-write' })
  })
  test('plan → 只读询问', () => {
    expect(mapPermissionMode('plan')).toEqual({ approvalPolicy: 'on-request', sandbox: 'read-only' })
  })
  test('default/未知/缺省 → 工作区询问（安全中间档）', () => {
    expect(mapPermissionMode('default')).toEqual({ approvalPolicy: 'on-request', sandbox: 'workspace-write' })
    expect(mapPermissionMode(undefined)).toEqual({ approvalPolicy: 'on-request', sandbox: 'workspace-write' })
    expect(mapPermissionMode('some-future-mode')).toEqual({ approvalPolicy: 'on-request', sandbox: 'workspace-write' })
  })
})

describe('sandboxPolicyOf（kebab → camelCase 对象的双轨转换）', () => {
  test('已知三档', () => {
    expect(sandboxPolicyOf('read-only')).toEqual({ type: 'readOnly' })
    expect(sandboxPolicyOf('workspace-write')).toEqual({ type: 'workspaceWrite' })
    expect(sandboxPolicyOf('danger-full-access')).toEqual({ type: 'dangerFullAccess' })
  })
  test('未知值返回 undefined（调用方省略字段，不发明枚举）', () => {
    expect(sandboxPolicyOf('')).toBeUndefined()
    expect(sandboxPolicyOf('yolo')).toBeUndefined()
  })
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

describe('extractTokenCountFromRolloutTail（resume 水合）', () => {
  const rec = (last: Record<string, number>, total?: Record<string, number>, w?: number) => JSON.stringify({
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: {
        total_token_usage: total ?? last,
        last_token_usage: last,
        ...(w != null ? { model_context_window: w } : {}),
      },
    },
  })
  const u1 = { input_tokens: 14548, cached_input_tokens: 8704, cache_write_input_tokens: 0, output_tokens: 41, reasoning_output_tokens: 37, total_tokens: 14589 }
  const u2 = { input_tokens: 15492, cached_input_tokens: 14464, cache_write_input_tokens: 0, output_tokens: 3, reasoning_output_tokens: 0, total_tokens: 15495 }

  test('取尾部最后一条 token_count；snake → camel 与 wire 同形', () => {
    const text = [rec(u1), rec(u2, { ...u2, total_tokens: 30084 }, 996147)].join('\n')
    expect(extractTokenCountFromRolloutTail(text)).toEqual({
      last: { totalTokens: 15495, inputTokens: 15492, cachedInputTokens: 14464, cacheWriteInputTokens: 0, outputTokens: 3, reasoningOutputTokens: 0 },
      total: { totalTokens: 30084, inputTokens: 15492, cachedInputTokens: 14464, cacheWriteInputTokens: 0, outputTokens: 3, reasoningOutputTokens: 0 },
      modelContextWindow: 996147,
    })
  })

  test('截断行/非 token_count 行跳过；缺 model_context_window 时省略', () => {
    const truncated = '{"type":"event_msg","payload":{"type":"token_count","info":{"las'
    const other = JSON.stringify({ type: 'response_item', payload: { type: 'message' } })
    const text = [truncated, other, rec(u1)].join('\n')
    const got = extractTokenCountFromRolloutTail(text)
    expect(got?.last.totalTokens).toBe(14589)
    expect(got?.modelContextWindow).toBeUndefined()
    expect(extractTokenCountFromRolloutTail(other)).toBeUndefined()
  })
})

// ---------- 方向五：delta 接入与子线程实时转发 ----------
import { afterAll } from 'bun:test'
import { rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { CodexRuntime, reasoningSidecarUuid } from './runtime'
import { ThreadTranslator } from './translate'
import { readReasoning } from './reasoningStore'
import type { CliMessage } from '../claude/protocol'

const REASONING_THREAD = `test-child-${crypto.randomUUID()}`
afterAll(() => {
  rmSync(join(homedir(), '.anyplane', 'reasoning', `${REASONING_THREAD}.jsonl`), { force: true })
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

describe('reasoningSidecarUuid（侧车回插去重锚点）', () => {
  test('itemId 优先，缺省回退 rs-<ts>-<i>', () => {
    expect(reasoningSidecarUuid({ ts: 1000, itemId: 'r-1' }, 3)).toBe('r-1')
    expect(reasoningSidecarUuid({ ts: 1000 }, 3)).toBe('rs-1000-3')
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

describe('readHistory 双轨（paginated 分页 / legacy thread/read）', () => {
  /** rpcRequest 打桩：按 method 路由到录制表，返回 canned 应答 */
  const stubRpc = (handlers: Record<string, (params: Record<string, unknown>) => unknown>) => {
    const runtime = new CodexRuntime()
    const calls: Array<{ method: string; params: Record<string, unknown> }> = []
    ;(runtime as unknown as { rpcRequest: unknown }).rpcRequest = async (method: string, params?: unknown) => {
      const p = (params ?? {}) as Record<string, unknown>
      calls.push({ method, params: p })
      const h = handlers[method]
      if (!h) throw new Error(`未打桩的 RPC: ${method}`)
      return h(p)
    }
    return { runtime, calls }
  }

  test('legacy 线程：thread/read includeTurns 单链路（不分页），轮首 userMessage 以 turnId 为锚', async () => {
    const { runtime, calls } = stubRpc({
      'thread/read': (p) =>
        p.includeTurns
          ? {
              thread: {
                historyMode: 'legacy',
                turns: [
                  {
                    id: 'turn-1',
                    items: [
                      { id: 'u1', type: 'userMessage', content: [{ type: 'text', text: '问题' }] },
                      { id: 'a1', type: 'agentMessage', text: '回答' },
                    ],
                  },
                ],
              },
            }
          : { thread: { historyMode: 'legacy' } },
    })
    const msgs = await runtime.readHistory('th-legacy')
    expect(calls.map((c) => c.method)).toEqual(['thread/read', 'thread/read'])
    expect(calls.some((c) => c.method.includes('list'))).toBe(false)
    expect(msgs.map((m) => [m.uuid, m.role])).toEqual([
      ['turn-1', 'user'],
      ['a1', 'assistant'],
    ])
    expect(msgs[0].rewindable).toBe(true)
  })

  test('paginated 线程：turns/list asc + items/list 分页；工具卡完整（legacy 缺口修复路径）', async () => {
    const { runtime, calls } = stubRpc({
      'thread/read': () => ({ thread: { historyMode: 'paginated' } }),
      'thread/turns/list': (p) =>
        p.cursor === 'tc1'
          ? {
              data: [{ id: 'turn-2', startedAt: 200, completedAt: 250 }],
              nextCursor: null,
            }
          : { data: [{ id: 'turn-1', startedAt: 100, completedAt: 150 }], nextCursor: 'tc1' },
      'thread/items/list': (p) =>
        p.cursor === 'ic1'
          ? {
              data: [
                { turnId: 'turn-2', item: { id: 'u2', type: 'userMessage', content: [{ type: 'text', text: '继续' }] } },
                { turnId: 'turn-2', item: { id: 'c2', type: 'commandExecution', command: 'ls', aggregatedOutput: 'ok', exitCode: 0, status: 'completed' } },
              ],
              nextCursor: null,
            }
          : {
              data: [
                { turnId: 'turn-1', item: { id: 'u1', type: 'userMessage', content: [{ type: 'text', text: '开始' }] } },
                { turnId: 'turn-1', item: { id: 'r1', type: 'reasoning', summary: ['想了想'], content: [] } },
                { turnId: 'turn-1', item: { id: 'c1', type: 'commandExecution', command: 'echo hi', aggregatedOutput: 'hi\n', exitCode: 0, status: 'completed' } },
                { turnId: 'turn-1', item: { id: 'a1', type: 'agentMessage', text: '完成' } },
              ],
              nextCursor: 'ic1',
            },
    })
    const msgs = await runtime.readHistory('th-page')
    // turns/list 必须显式 asc（默认 desc 会把顺序弄反，实测）；items/list 跨 turn 分页
    const turnsCalls = calls.filter((c) => c.method === 'thread/turns/list')
    expect(turnsCalls[0].params.sortDirection).toBe('asc')
    expect(turnsCalls.map((c) => c.params.cursor)).toEqual([undefined, 'tc1'])
    expect(calls.filter((c) => c.method === 'thread/items/list').map((c) => c.params.cursor)).toEqual([undefined, 'ic1'])
    // 内容：commandExecution 出工具卡对（legacy thread/read 缺这类 item，是刷新丢卡的根因）
    const kinds = msgs.flatMap((m) => m.blocks.map((b) => b.kind))
    expect(kinds).toContain('tool_use')
    expect(kinds).toContain('tool_result')
    expect(kinds).toContain('thinking')
    // 每轮首条 userMessage 以各自 turnId 为锚（rewindable）
    const users = msgs.filter((m) => m.role === 'user' && m.blocks.some((b) => b.kind === 'text'))
    expect(users.map((m) => m.uuid)).toEqual(['turn-1', 'turn-2'])
    expect(users.every((m) => m.rewindable)).toBe(true)
  })

  test('paginated：item 的 turnId 不在 turns/list 时按末段追加，不静默丢弃', async () => {
    const { runtime } = stubRpc({
      'thread/read': () => ({ thread: { historyMode: 'paginated' } }),
      'thread/turns/list': () => ({ data: [{ id: 'turn-1' }], nextCursor: null }),
      'thread/items/list': () => ({
        data: [
          { turnId: 'turn-1', item: { id: 'u1', type: 'userMessage', content: [{ type: 'text', text: '在册' }] } },
          { turnId: 'turn-x', item: { id: 'u9', type: 'userMessage', content: [{ type: 'text', text: '编外' }] } },
        ],
        nextCursor: null,
      }),
    })
    const msgs = await runtime.readHistory('th-page2')
    expect(msgs.map((m) => m.uuid)).toEqual(['turn-1', 'turn-x'])
  })
})

describe('thread/reverted 通知与回滚 RPC', () => {
  test('thread/reverted → 广播 cli 系统消息（入环，重连补发放逐"被回滚的未来"）', () => {
    const { session, msgs } = makeSession()
    session.handleNotification('thread/reverted', { threadId: 'parent-tid' })
    expect(msgs).toEqual([{ type: 'system', subtype: 'thread_reverted' }])
  })

  test('revertAt 发 thread/revert；historyModeOf 无在线会话时走 thread/read 惰性解析', async () => {
    const runtime = new CodexRuntime()
    const calls: Array<{ method: string; params: Record<string, unknown> }> = []
    ;(runtime as unknown as { rpcRequest: unknown }).rpcRequest = async (method: string, params?: unknown) => {
      calls.push({ method, params: (params ?? {}) as Record<string, unknown> })
      if (method === 'thread/read') return { thread: { historyMode: 'paginated' } }
      return {}
    }
    await runtime.revertAt('th-1', 'turn-3')
    expect(calls[0]).toEqual({ method: 'thread/revert', params: { threadId: 'th-1', beforeTurnId: 'turn-3' } })
    expect(await runtime.historyModeOf('th-1')).toBe('paginated')
    expect(calls[1].params.includeTurns).toBe(false)
  })
})
