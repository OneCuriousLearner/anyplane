// Codex → claude stream-json 翻译器：统一消息边界的保真度直接决定前端渲染是否正确。
// 重点锁定：live 流事件序（快照先于 stop）、tool_use/tool_result 配对 id、
// reasoning 镜像去重、历史首条 userMessage 的 rewindable 标记。
import { describe, expect, test } from 'bun:test'
import {
  itemsToHistory,
  mapThreadStatus,
  partialToolResultMsg,
  reasoningText,
  ThreadTranslator,
  turnCompletedMsg,
} from './translate'

describe('ThreadTranslator agentMessage 生命周期', () => {
  test('started → delta → completed 的事件序对齐 claude 真实序（快照先于 stop）', () => {
    const t = new ThreadTranslator()

    const started = t.itemStarted({ id: 'm1', type: 'agentMessage' })
    expect(started).toEqual([
      { type: 'stream_event', event: { type: 'message_start', message: { id: 'm1', role: 'assistant', content: [] } } },
      { type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } },
    ])

    const delta = t.itemDelta('item/agentMessage/delta', { itemId: 'm1', delta: '你好' })
    expect(delta).toEqual([
      {
        type: 'stream_event',
        event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '你好' } },
        message: { id: 'm1' },
      },
    ])

    const completed = t.itemCompleted({ id: 'm1', type: 'agentMessage', text: '你好，世界' })
    // assistant 快照必须在 message_stop 之前：快照合并草稿、stop 提交定稿
    expect(completed.map((m) => m.type)).toEqual(['assistant', 'stream_event', 'stream_event'])
    expect(completed[0]).toEqual({
      type: 'assistant',
      message: { id: 'm1', role: 'assistant', content: [{ type: 'text', text: '你好，世界' }] },
    })
    expect(completed[1]).toEqual({ type: 'stream_event', event: { type: 'content_block_stop', index: 0 } })
    expect(completed[2]).toEqual({ type: 'stream_event', event: { type: 'message_stop' } })
  })

  test('reasoning 走 thinking 块；delta 两种 method 都识别', () => {
    const t = new ThreadTranslator()
    const started = t.itemStarted({ id: 'r1', type: 'reasoning' })
    expect(started[1]).toEqual({
      type: 'stream_event',
      event: { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
    })

    for (const method of ['item/reasoning/textDelta', 'item/reasoning/summaryTextDelta']) {
      const d = t.itemDelta(method, { itemId: 'r1', delta: '嗯' })
      expect(d[0]).toMatchObject({
        event: { delta: { type: 'thinking_delta', thinking: '嗯' } },
        message: { id: 'r1' },
      })
    }
    // 不相关 method / 缺 itemId → 空
    expect(t.itemDelta('item/unknown/delta', { itemId: 'r1', delta: 'x' })).toEqual([])
    expect(t.itemDelta('item/agentMessage/delta', {})).toEqual([])
  })

  test('summaryPartAdded：只在见过 summaryTextDelta 的 item 上补段落分隔', () => {
    const t = new ThreadTranslator()
    // 未见过 summary delta 的 item（如只发 textDelta 的供应商）：partAdded 不产生事件
    expect(t.itemDelta('item/reasoning/summaryPartAdded', { itemId: 'r1', summaryIndex: 1 })).toEqual([])

    t.itemDelta('item/reasoning/summaryTextDelta', { itemId: 'r2', delta: '第一段' })
    const sep = t.itemDelta('item/reasoning/summaryPartAdded', { itemId: 'r2', summaryIndex: 1 })
    expect(sep).toEqual([
      {
        type: 'stream_event',
        event: { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: '\n\n' } },
        message: { id: 'r2' },
      },
    ])
  })

  test('缺 id/type 的残缺 item 不产生事件', () => {
    const t = new ThreadTranslator()
    expect(t.itemStarted({})).toEqual([])
    expect(t.itemCompleted({ id: 'x' })).toEqual([])
    expect(t.itemStarted({ id: 'u1', type: 'mysteryItem' })).toEqual([])
    expect(t.itemCompleted({ id: 'u1', type: 'mysteryItem' })).toEqual([])
  })
})

describe('ThreadTranslator 工具项', () => {
  test('commandExecution → Bash 卡，completed 按 id 配对 tool_result', () => {
    const t = new ThreadTranslator()
    const started = t.itemStarted({ id: 'c1', type: 'commandExecution', command: 'ls -la', cwd: '/data' })
    expect(started).toHaveLength(1)
    expect(started[0]).toMatchObject({
      type: 'assistant',
      message: {
        id: 'tool-c1',
        content: [{ type: 'tool_use', id: 'c1', name: 'Bash', input: { command: 'ls -la', description: 'cwd: /data' } }],
      },
    })

    const completed = t.itemCompleted({ id: 'c1', type: 'commandExecution', status: 'completed', exitCode: 0, aggregatedOutput: 'total 0' })
    expect(completed).toEqual([
      {
        type: 'user',
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'c1', content: 'total 0', is_error: false }] },
      },
    ])
  })

  test('commandExecution 失败判定：status failed / declined / 非零 exitCode', () => {
    const t = new ThreadTranslator()
    const failed = t.itemCompleted({ id: 'c2', type: 'commandExecution', status: 'completed', exitCode: 1, aggregatedOutput: 'boom' })
    expect(failed[0]).toMatchObject({ message: { content: [{ is_error: true }] } })

    const declined = t.itemCompleted({ id: 'c3', type: 'commandExecution', status: 'declined' })
    expect(declined[0]).toMatchObject({ message: { content: [{ content: '（用户拒绝）', is_error: true }] } })

    // 无输出时兜底 exit 文案
    const silent = t.itemCompleted({ id: 'c4', type: 'commandExecution', status: 'completed', exitCode: 2 })
    expect(silent[0]).toMatchObject({ message: { content: [{ content: '（exit 2）', is_error: true }] } })
  })

  test('fileChange → Edit 卡（paths 汇总 + diff 文本）', () => {
    const t = new ThreadTranslator()
    const started = t.itemStarted({
      id: 'f1',
      type: 'fileChange',
      changes: [{ path: 'a.ts' }, { path: 'b.ts' }],
    })
    expect(started[0]).toMatchObject({
      message: { content: [{ name: 'Edit', input: { file_path: 'a.ts', paths: ['a.ts', 'b.ts'] } }] },
    })
    const completed = t.itemCompleted({
      id: 'f1',
      type: 'fileChange',
      status: 'completed',
      changes: [{ path: 'a.ts', diff: '@@ -1 +1 @@' }, { path: 'b.ts', diff: '@@ -2 +2 @@' }],
    })
    expect(completed[0]).toMatchObject({
      message: { content: [{ content: '--- a.ts\n@@ -1 +1 @@\n\n--- b.ts\n@@ -2 +2 @@', is_error: false }] },
    })
  })

  test('mcpToolCall → server:tool 命名；error 序列化为失败结果', () => {
    const t = new ThreadTranslator()
    const started = t.itemStarted({ id: 'm1', type: 'mcpToolCall', server: 'chrome', tool: 'click', arguments: { uid: 'u1' } })
    expect(started[0]).toMatchObject({ message: { content: [{ name: 'chrome:click', input: { uid: 'u1' } }] } })

    const err = t.itemCompleted({ id: 'm1', type: 'mcpToolCall', status: 'failed', error: { code: -1, message: 'no such node' } })
    expect(err[0]).toMatchObject({
      message: { content: [{ content: '{"code":-1,"message":"no such node"}', is_error: true }] },
    })
  })

  test('webSearch 结果即正文，失败态不由 status 表达', () => {
    const t = new ThreadTranslator()
    const started = t.itemStarted({ id: 'w1', type: 'webSearch', query: 'bun windows socket bug' })
    expect(started[0]).toMatchObject({ message: { content: [{ name: 'WebSearch', input: { query: 'bun windows socket bug' } }] } })
    const completed = t.itemCompleted({ id: 'w1', type: 'webSearch', status: 'failed', result: '搜索结果…' })
    expect(completed[0]).toMatchObject({ message: { content: [{ content: '搜索结果…', is_error: false }] } })
  })

  test('contextCompaction → compact_boundary；review 模式 → system 文本', () => {
    const t = new ThreadTranslator()
    expect(t.itemCompleted({ id: 'x1', type: 'contextCompaction' })).toEqual([{ type: 'system', subtype: 'compact_boundary' }])
    expect(t.itemCompleted({ id: 'x2', type: 'enteredReviewMode', review: '未提交改动' })).toEqual([
      { type: 'system', subtype: 'status', text: '进入代码审查：未提交改动' },
    ])
    expect(t.itemCompleted({ id: 'x3', type: 'exitedReviewMode', review: 'LGTM' })).toEqual([
      { type: 'system', subtype: 'status', text: '审查完成\nLGTM' },
    ])
  })
})

describe('reasoningText（summary/content 可能互为镜像）', () => {
  test('镜像时只取一份', () => {
    expect(reasoningText(['第一段', '第二段'], ['第一段', '第二段'])).toBe('第一段\n\n第二段')
  })
  test('不同则拼接 summary 在前', () => {
    expect(reasoningText(['摘要'], ['正文'])).toBe('摘要\n\n正文')
  })
  test('空值容错', () => {
    expect(reasoningText(undefined, undefined)).toBe('')
    expect(reasoningText(['只有摘要'])).toBe('只有摘要')
    expect(reasoningText([], ['只有正文'])).toBe('只有正文')
    expect(reasoningText(['', '过滤空串'], [''])).toBe('过滤空串')
  })
})

describe('mapThreadStatus / turnCompletedMsg', () => {
  test('active → running，其余 → idle', () => {
    expect(mapThreadStatus(undefined)).toBe('idle')
    expect(mapThreadStatus({ type: 'active' })).toBe('running')
    expect(mapThreadStatus({ type: 'idle' })).toBe('idle')
    expect(mapThreadStatus({})).toBe('idle')
  })

  test('turn/completed → result 形状', () => {
    // lastUsage 与 thread/tokenUsage/updated wire 同形（camelCase，见 runtime.ts 注释）——
    // 旧测试传 snake_case 属误植，旧实现原样透传才碰巧通过
    const ok = turnCompletedMsg('thread-1', { status: 'completed' }, { inputTokens: 10, outputTokens: 5 })
    expect(ok).toMatchObject({ type: 'result', subtype: 'success', is_error: false, session_id: 'thread-1', usage: { output_tokens: 5 } })
    // 口径钉死：result.usage 只带 output_tokens（与 claude 一致）——input 侧是多 API 调用累计，
    // 多调用 turn 结束时虚增近翻倍，contextUsage 绝不从这里取数
    expect((ok.usage as Record<string, unknown>).input_tokens).toBeUndefined()

    const bad = turnCompletedMsg('thread-1', { status: 'failed', error: { message: '模型过载' } })
    expect(bad).toMatchObject({ subtype: 'error', is_error: true, result: '模型过载' })

    const badNoMsg = turnCompletedMsg('thread-1', { status: 'failed' })
    expect(badNoMsg).toMatchObject({ result: 'turn failed' })
  })
})

describe('itemsToHistory', () => {
  test('turnId 存在时首条 userMessage 以其为 uuid 且 rewindable（/rewind 定位锚点）', () => {
    const msgs = itemsToHistory(
      [
        { id: 'u1', type: 'userMessage', content: [{ type: 'text', text: '第一个问题' }] },
        { id: 'a1', type: 'agentMessage', text: '回答一' },
        { id: 'u2', type: 'userMessage', content: [{ type: 'text', text: '追问' }] },
      ],
      'turn-42',
    )
    expect(msgs).toHaveLength(3)
    expect(msgs[0]).toMatchObject({ uuid: 'turn-42', role: 'user', rewindable: true })
    // 后续 userMessage 不再标记
    expect(msgs[2]).toMatchObject({ uuid: 'u2', role: 'user' })
    expect(msgs[2]!.rewindable).toBeFalsy()
  })

  test('无 turnId 时不标记 rewindable', () => {
    const msgs = itemsToHistory([{ id: 'u1', type: 'userMessage', content: [{ type: 'text', text: '问' }] }])
    expect(msgs[0]!.rewindable).toBeFalsy()
    expect(msgs[0]!.uuid).toBe('u1')
  })

  test('工具项 → tool_use + tool_result 成对（tool_result uuid 带 -r 后缀）', () => {
    const msgs = itemsToHistory([
      { id: 'c1', type: 'commandExecution', command: 'ls', status: 'completed', exitCode: 0, aggregatedOutput: 'ok' },
    ])
    expect(msgs).toHaveLength(2)
    // 历史卡摘要有意不带 live 侧的 description(cwd)：避免抢占 toolSummary 首选字段
    expect(msgs[0]).toMatchObject({ role: 'assistant', blocks: [{ kind: 'tool_use', id: 'c1', name: 'Bash', input: { command: 'ls' } }] })
    expect(msgs[1]).toMatchObject({ uuid: 'c1-r', role: 'user', blocks: [{ kind: 'tool_result', id: 'c1', text: 'ok', isError: false }] })
  })

  test('reasoning 文本为空则整条跳过；plan 按文本入抄本', () => {
    const msgs = itemsToHistory([
      { id: 'r1', type: 'reasoning', summary: [], content: [] },
      { id: 'r2', type: 'reasoning', summary: ['想一下'] },
      { id: 'p1', type: 'plan', text: '计划文本' },
    ])
    expect(msgs.map((m) => m.uuid)).toEqual(['r2', 'p1'])
    expect(msgs[0]!.blocks).toEqual([{ kind: 'thinking', text: '想一下' }])
  })

  test('userMessage 富内容：图片占位 / skill / mention，空内容跳过', () => {
    const msgs = itemsToHistory([
      {
        id: 'u1',
        type: 'userMessage',
        content: [
          { type: 'text', text: '看这个' },
          { type: 'localImage', path: '/not-in-uploads/photo.png' }, // 不在 uploads 目录 → 占位
          { type: 'skill', name: 'review' },
          { type: 'mention', name: 'README.md' },
          { type: 'audio' },
        ],
      },
      { id: 'u2', type: 'userMessage', content: [] }, // 空内容整条跳过
      { id: 'u3', type: 'userMessage' }, // 非数组内容同样跳过
    ])
    expect(msgs).toHaveLength(1)
    expect(msgs[0]!.blocks).toEqual([{ kind: 'text', text: '看这个\n[图片]\n[skill: review]\n[README.md]\n[音频]' }])
  })

  test('contextCompaction → system 分隔；子代理项走侧栏不进主线', () => {
    const msgs = itemsToHistory([
      { id: 'x1', type: 'contextCompaction' },
      // collabAgentToolCall/subAgentActivity 有意不进主线（侧栏桶负责）
      { id: 'x2', type: 'collabAgentToolCall' },
      { id: 'x3', type: 'subAgentActivity' },
    ])
    expect(msgs).toEqual([{ uuid: 'x1', role: 'system', subtype: 'compact_boundary', blocks: [] }])
  })

  // 这五种是官方 ThreadItem union 成员，此前 live 与历史双双静默丢弃——
  // 用了 hooks / 动态工具 / 生图的会话在抄本里凭空缺一块，且无任何提示
  test('dynamicToolCall → namespace:tool 工具卡，多模态输出取文本、图音标注', () => {
    const msgs = itemsToHistory([
      {
        id: 'd1',
        type: 'dynamicToolCall',
        namespace: 'ns',
        tool: 'lookup',
        arguments: { q: 1 },
        status: 'completed',
        contentItems: [{ type: 'inputText', text: '结果正文' }, { type: 'inputImage', imageUrl: 'x' }],
      },
    ])
    expect(msgs[0].blocks[0]).toMatchObject({ kind: 'tool_use', name: 'ns:lookup' })
    expect(msgs[1].blocks[0]).toMatchObject({ kind: 'tool_result', text: '结果正文\n（图片）', isError: false })
  })

  test('dynamicToolCall 失败态：status=failed 或 success=false 均标失败；无 namespace 用裸 tool 名', () => {
    const a = itemsToHistory([{ id: 'd2', type: 'dynamicToolCall', tool: 'solo', status: 'failed' }])
    expect(a[0].blocks[0]).toMatchObject({ name: 'solo' })
    expect(a[1].blocks[0]).toMatchObject({ isError: true })
    const b = itemsToHistory([{ id: 'd3', type: 'dynamicToolCall', tool: 't', status: 'completed', success: false }])
    expect(b[1].blocks[0]).toMatchObject({ isError: true })
  })

  test('imageGeneration → 成功给 savedPath，失败标错', () => {
    const ok = itemsToHistory([{ id: 'g1', type: 'imageGeneration', status: 'completed', revisedPrompt: '一只猫', savedPath: '/tmp/a.png' }])
    expect(ok[0].blocks[0]).toMatchObject({ kind: 'tool_use', name: 'ImageGeneration', input: { prompt: '一只猫' } })
    expect(ok[1].blocks[0]).toMatchObject({ text: '已保存：/tmp/a.png', isError: false })
    const bad = itemsToHistory([{ id: 'g2', type: 'imageGeneration', status: 'failed', failure: '违规' }])
    expect(bad[1].blocks[0]).toMatchObject({ isError: true })
  })

  test('sleep → 工具卡，时长按秒展示', () => {
    const msgs = itemsToHistory([{ id: 's1', type: 'sleep', durationMs: 2500 }])
    expect(msgs[0].blocks[0]).toMatchObject({ kind: 'tool_use', name: 'Sleep', input: { durationMs: 2500 } })
    expect(msgs[1].blocks[0]).toMatchObject({ text: '等待 3s' })
  })

  test('hookPrompt → 系统提示（拼接片段）；空片段整条跳过', () => {
    const msgs = itemsToHistory([
      { id: 'h1', type: 'hookPrompt', fragments: [{ text: '第一段' }, { text: '第二段' }] },
      { id: 'h2', type: 'hookPrompt', fragments: [] },
    ])
    expect(msgs).toHaveLength(1)
    expect(msgs[0]).toMatchObject({ role: 'system' })
    expect(msgs[0].blocks[0]).toMatchObject({ text: '◎ hook 注入上下文\n第一段\n第二段' })
  })

  test('imageView → 系统提示带路径', () => {
    const msgs = itemsToHistory([{ id: 'v1', type: 'imageView', path: '/tmp/pic.png' }])
    expect(msgs[0].blocks[0]).toMatchObject({ text: '◎ 查看图片：/tmp/pic.png' })
  })
})

describe('live 侧新增 ThreadItem 与历史同形', () => {
  const t = () => new ThreadTranslator()

  test('dynamicToolCall/imageGeneration/sleep 在 live 侧同样出工具卡并配对结果', () => {
    for (const item of [
      { id: 'd1', type: 'dynamicToolCall', namespace: 'ns', tool: 'lookup', status: 'completed', contentItems: [{ type: 'inputText', text: 'ok' }] },
      { id: 'g1', type: 'imageGeneration', status: 'completed', savedPath: '/tmp/a.png' },
      { id: 's1', type: 'sleep', durationMs: 1000 },
    ]) {
      const tr = t()
      const started = tr.itemStarted(item)
      expect(started[0]).toMatchObject({ type: 'assistant' })
      const completed = tr.itemCompleted(item)
      expect(completed[0]).toMatchObject({ type: 'user' })
    }
  })

  test('hookPrompt/imageView 在 live 侧走系统提示，不出工具卡', () => {
    const tr = t()
    expect(tr.itemStarted({ id: 'h1', type: 'hookPrompt', fragments: [{ text: 'x' }] })).toEqual([])
    expect(tr.itemCompleted({ id: 'h1', type: 'hookPrompt', fragments: [{ text: 'x' }] })[0]).toMatchObject({
      type: 'system',
      subtype: 'status',
    })
    expect(tr.itemCompleted({ id: 'v1', type: 'imageView', path: '/p.png' })[0]).toMatchObject({ type: 'system' })
  })
})

describe('子代理生命周期翻译（collabAgentToolCall / subAgentActivity）', () => {  // 桶键统一为子线程 id（agentThreadId），两条事件线在前端归并成同一张卡；
  // 终态枚举严格用 claude 三值（completed/failed/stopped），前端映射直接生效。
  const t = () => new ThreadTranslator()

  test('subAgentActivity：started → task_started，completed/interrupted → task_notification，interacted 忽略', () => {
    const started = t().itemCompleted({ id: 'e1', type: 'subAgentActivity', kind: 'started', agentThreadId: 'th-1', agentPath: 'worker/explore' })
    expect(started).toEqual([
      {
        type: 'system',
        subtype: 'task_started',
        tool_use_id: 'th-1',
        agent_thread_id: 'th-1',
        task_type: 'subAgent',
        description: 'worker/explore',
      },
    ])

    expect(t().itemCompleted({ id: 'e2', type: 'subAgentActivity', kind: 'completed', agentThreadId: 'th-1', agentPath: 'worker/explore' })).toEqual([
      { type: 'system', subtype: 'task_notification', tool_use_id: 'th-1', agent_thread_id: 'th-1', status: 'completed' },
    ])
    expect(t().itemCompleted({ id: 'e3', type: 'subAgentActivity', kind: 'interrupted', agentThreadId: 'th-1', agentPath: 'worker/explore' })).toEqual([
      { type: 'system', subtype: 'task_notification', tool_use_id: 'th-1', agent_thread_id: 'th-1', status: 'stopped' },
    ])
    expect(t().itemCompleted({ id: 'e4', type: 'subAgentActivity', kind: 'interacted', agentThreadId: 'th-1', agentPath: 'p' })).toEqual([])
    // 缺 agentThreadId 无法归并，整条丢弃
    expect(t().itemCompleted({ id: 'e5', type: 'subAgentActivity', kind: 'started' })).toEqual([])
  })

  test('spawnAgent 成功 End → task_started（receiver 为桶键，prompt 截断作描述）', () => {
    const msgs = t().itemCompleted({
      id: 'call-1',
      type: 'collabAgentToolCall',
      tool: 'spawnAgent',
      status: 'completed',
      receiverThreadIds: ['th-9'],
      prompt: '去仓库里找到 Hub 的定义位置',
      agentsStates: { 'th-9': { status: 'running' } }, // 非终态不发通知
    })
    expect(msgs).toEqual([
      {
        type: 'system',
        subtype: 'task_started',
        tool_use_id: 'th-9',
        agent_thread_id: 'th-9',
        task_type: 'spawnAgent',
        description: '去仓库里找到 Hub 的定义位置',
      },
      // 主线 tool_result 配对卡（itemStarted 的 tool_use 在此收尾）
      {
        type: 'user',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'call-1', content: 'spawnAgent → completed\nagents: 1\nth-9 running', is_error: false }],
        },
      },
    ])
  })

  test('spawnAgent 失败 End 且无 receiver → 用 call id 建即终态卡（失败不得不可见）', () => {
    const msgs = t().itemCompleted({
      id: 'call-2',
      type: 'collabAgentToolCall',
      tool: 'spawnAgent',
      status: 'failed',
      receiverThreadIds: [],
      prompt: 'x',
    })
    expect(msgs).toEqual([
      { type: 'system', subtype: 'task_notification', tool_use_id: 'call-2', agent_thread_id: undefined, status: 'failed' },
      {
        type: 'user',
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call-2', content: 'spawnAgent → failed', is_error: true }] },
      },
    ])
  })

  test('wait End 的 agentsStates 逐个翻终态（报告正文入 summary），running/pendingInit 跳过', () => {
    const msgs = t().itemCompleted({
      id: 'call-3',
      type: 'collabAgentToolCall',
      tool: 'wait',
      status: 'completed',
      receiverThreadIds: ['th-1', 'th-2', 'th-3', 'th-4'],
      agentsStates: {
        'th-1': { status: 'completed', message: '报告正文' },
        'th-2': { status: 'errored', message: '炸了' },
        'th-3': { status: 'interrupted' },
        'th-4': { status: 'running' },
      },
    })
    expect(msgs).toEqual([
      { type: 'system', subtype: 'task_notification', tool_use_id: 'th-1', agent_thread_id: 'th-1', status: 'completed', summary: '报告正文' },
      { type: 'system', subtype: 'task_notification', tool_use_id: 'th-2', agent_thread_id: 'th-2', status: 'failed', summary: '炸了' },
      { type: 'system', subtype: 'task_notification', tool_use_id: 'th-3', agent_thread_id: 'th-3', status: 'stopped', summary: undefined },
      {
        type: 'user',
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'call-3',
              content: 'wait → completed\nagents: 4\nth-1 completed: 报告正文\nth-2 errored: 炸了\nth-3 interrupted\nth-4 running',
              is_error: false,
            },
          ],
        },
      },
    ])
  })

  test('非 spawn 工具 End 只出主线配对卡，不建侧栏桶；Begin（inProgress）不翻译', () => {
    const tr = t()
    expect(
      tr.itemCompleted({ id: 'c4', type: 'collabAgentToolCall', tool: 'sendInput', status: 'completed', receiverThreadIds: ['th-1'] }),
    ).toEqual([
      {
        type: 'user',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'c4', content: 'sendInput → completed\nagents: 1', is_error: false }],
        },
      },
    ])
    // itemStarted 出主线 tool_use 卡（Begin 时就该有卡，不能等 End）
    expect(tr.itemStarted({ id: 'c5', type: 'collabAgentToolCall', tool: 'spawnAgent', status: 'inProgress', prompt: 'x' })).toEqual([
      {
        type: 'assistant',
        message: { id: 'tool-c5', role: 'assistant', content: [{ type: 'tool_use', id: 'c5', name: 'Collab', input: { tool: 'spawnAgent', prompt: 'x' } }] },
      },
    ])
    // subAgentActivity 不是工具调用，不进主线卡
    expect(tr.itemStarted({ id: 'e6', type: 'subAgentActivity', kind: 'started', agentThreadId: 'th-1', agentPath: 'p' })).toEqual([])
  })
})

describe('partialToolResultMsg（工具流式部分结果）', () => {
  test('与终态 tool_result 同形 + partial 标记（前端保持运行态，cliRing 不占号）', () => {
    expect(partialToolResultMsg('c1', 'tick-1\n')).toEqual({
      type: 'user',
      partial: true,
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'c1', content: 'tick-1\n', is_error: false }],
      },
    })
  })
})

describe('childItemMsgs（子线程 item → sidechain 桶转录）', () => {
  const t = () => new ThreadTranslator()

  test('agentMessage/reasoning/userMessage → 单条 sidechain，parent_tool_use_id=子线程 id', () => {
    const tr = t()
    expect(tr.childItemMsgs('th-1', { id: 'm1', type: 'agentMessage', text: '子代理正文' })).toEqual([
      {
        type: 'assistant',
        uuid: 'm1',
        parent_tool_use_id: 'th-1',
        message: { role: 'assistant', content: [{ type: 'text', text: '子代理正文' }] },
      },
    ])
    expect(tr.childItemMsgs('th-1', { id: 'r1', type: 'reasoning', summary: ['想一下'], content: [] })).toEqual([
      {
        type: 'assistant',
        uuid: 'r1',
        parent_tool_use_id: 'th-1',
        message: { role: 'assistant', content: [{ type: 'thinking', thinking: '想一下' }] },
      },
    ])
    expect(
      tr.childItemMsgs('th-1', { id: 'u1', type: 'userMessage', content: [{ type: 'text', text: '数一数' }] }),
    ).toEqual([
      {
        type: 'user',
        uuid: 'u1',
        parent_tool_use_id: 'th-1',
        message: { role: 'user', content: [{ type: 'text', text: '数一数' }] },
      },
    ])
  })

  test('空文本的 agentMessage/reasoning/userMessage 不产生消息', () => {
    const tr = t()
    expect(tr.childItemMsgs('th-1', { id: 'm1', type: 'agentMessage', text: '  ' })).toEqual([])
    expect(tr.childItemMsgs('th-1', { id: 'r1', type: 'reasoning', summary: [], content: [] })).toEqual([])
    expect(tr.childItemMsgs('th-1', { id: 'u1', type: 'userMessage', content: [] })).toEqual([])
    expect(tr.childItemMsgs('th-1', {})).toEqual([])
  })

  test('commandExecution → tool_use + tool_result 成对（uuid 与历史同口径：item.id / item.id-r）', () => {
    const msgs = t().childItemMsgs('th-1', {
      id: 'c1',
      type: 'commandExecution',
      command: 'ls',
      status: 'completed',
      exitCode: 0,
      aggregatedOutput: 'ok',
    })
    expect(msgs).toHaveLength(2)
    expect(msgs[0]).toMatchObject({ type: 'assistant', uuid: 'c1', parent_tool_use_id: 'th-1' })
    expect(msgs[1]).toMatchObject({
      type: 'user',
      uuid: 'c1-r',
      parent_tool_use_id: 'th-1',
      message: { content: [{ type: 'tool_result', tool_use_id: 'c1', content: 'ok', is_error: false }] },
    })
  })

  test('孙代理 collab 工具卡以接收方线程 id 出块（前端嵌套血缘按工具块归属反推）', () => {
    const msgs = t().childItemMsgs('th-1', {
      id: 'call-1',
      type: 'collabAgentToolCall',
      tool: 'spawnAgent',
      status: 'completed',
      receiverThreadIds: ['th-2'],
      prompt: '孙任务',
      agentsStates: { 'th-2': { status: 'running' } },
    })
    expect(msgs[0]).toMatchObject({
      message: { content: [{ type: 'tool_use', id: 'th-2', name: 'Collab' }] },
    })
    expect(msgs[1]).toMatchObject({
      message: { content: [{ tool_use_id: 'th-2', is_error: false }] },
    })
    // 无接收方（spawn 失败）回退 call id，失败可见
    const failed = t().childItemMsgs('th-1', { id: 'call-2', type: 'collabAgentToolCall', tool: 'spawnAgent', status: 'failed' })
    expect(failed[0]).toMatchObject({ message: { content: [{ id: 'call-2' }] } })
    expect(failed[1]).toMatchObject({ message: { content: [{ is_error: true }] } })
  })

  test('subAgentActivity/hookPrompt 等非转录类型不进桶', () => {
    const tr = t()
    expect(tr.childItemMsgs('th-1', { id: 'e1', type: 'subAgentActivity', kind: 'started', agentThreadId: 'th-2' })).toEqual([])
    expect(tr.childItemMsgs('th-1', { id: 'h1', type: 'hookPrompt', fragments: [{ text: 'x' }] })).toEqual([])
  })
})

describe('childItemMsgs 首条 userMessage 的 turnId 锚点', () => {
  test('firstUserTurnId 存在时 uuid=turnId（与 history rewindable 锚点同键），否则 item.id', () => {
    const tr = new ThreadTranslator()
    const item = { id: 'u1', type: 'userMessage', content: [{ type: 'text', text: '数一数' }] }
    const withTurn = tr.childItemMsgs('th-1', item, { firstUserTurnId: 'turn-9' })
    expect(withTurn[0]).toMatchObject({ uuid: 'turn-9', parent_tool_use_id: 'th-1' })
    const without = tr.childItemMsgs('th-1', item)
    expect(without[0]).toMatchObject({ uuid: 'u1' })
  })
})
