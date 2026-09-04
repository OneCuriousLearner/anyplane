import { describe, expect, test } from 'bun:test'
import {
  buildTranscriptRows,
  draftBlockToBlock,
  fmtTokens,
  groupCollapsibleRuns,
  parseUserText,
  rewindPreview,
  stripAnsi,
  toolDetail,
  toolResultText,
  toolSummary,
  type ChatMsg,
} from './blocks'

describe('rewindPreview', () => {
  test('removes internal reminders and summarizes slash commands', () => {
    expect(
      rewindPreview(
        '<system-reminder>internal context</system-reminder><command-name>compact</command-name><command-args>focus on API</command-args>',
      ),
    ).toEqual({ summary: '/compact focus on API', detail: '/compact focus on API' })
  })

  test('omits local command output while keeping the user intent', () => {
    expect(
      rewindPreview('请检查当前项目。<local-command-stdout>\u001b[32mvery long command output\u001b[0m</local-command-stdout>然后总结。'),
    ).toEqual({ summary: '请检查当前项目。\n\n然后总结。', detail: '请检查当前项目。\n\n然后总结。' })
  })

  test('truncates only the summary and retains readable detail', () => {
    const preview = rewindPreview('这是一个很长的请求，'.repeat(30), 20)
    expect(preview.summary).toBe('这是一个很长的请求，这是一个很长的请求，…')
    expect(preview.detail.length).toBeGreaterThan(preview.summary.length)
  })
})

describe('parseUserText', () => {
  test('中断标记转为 interrupted 段并从正文剔除', () => {
    expect(parseUserText('[Request interrupted by user]')).toEqual([{ kind: 'interrupted', text: '已中断' }])
    const segs = parseUserText('做到一半[Request interrupted by user]')
    expect(segs.map((s) => s.kind)).toContain('interrupted')
    expect(segs.find((s) => s.kind === 'text')?.text).toBe('做到一半')
  })

  test('command-name 与 command-args 归并为一条命令段', () => {
    expect(
      parseUserText('<command-name>compact</command-name><command-args>focus on API</command-args>'),
    ).toEqual([{ kind: 'command', text: '/compact', args: 'focus on API' }])
  })

  test('command-message 不重复成段（compact 回显常与 command-name 成对）', () => {
    const segs = parseUserText('<command-message>compact</command-message><command-name>/compact</command-name>')
    expect(segs).toEqual([{ kind: 'command', text: '/compact' }])
  })

  test('命令名补 / 前缀；裸 args 无命令时降级为文本', () => {
    expect(parseUserText('<command-name>review</command-name>')).toEqual([{ kind: 'command', text: '/review' }])
    expect(parseUserText('<command-args>只有参数</command-args>')).toEqual([{ kind: 'text', text: '只有参数' }])
  })

  test('local-command 输出分段并剥 ANSI 颜色码', () => {
    const segs = parseUserText(
      '<local-command-stdout>[32mok green[0m</local-command-stdout><local-command-stderr>[31mbad red[0m</local-command-stderr>',
    )
    expect(segs).toEqual([
      { kind: 'local-out', text: 'ok green' },
      { kind: 'local-err', text: 'bad red' },
    ])
  })

  test('system-reminder 注入不进任何段，正文保留', () => {
    expect(parseUserText('前<system-reminder>内部上下文</system-reminder>后')).toEqual([
      { kind: 'text', text: '前后' },
    ])
  })
})

describe('toolSummary（一行摘要的字段取舍）', () => {
  test('按工具挑首选字段', () => {
    expect(toolSummary('Bash', { command: 'ls -la', description: '列目录' })).toBe('列目录')
    expect(toolSummary('Bash', { command: 'ls -la' })).toBe('ls -la')
    expect(toolSummary('Read', { file_path: '/a/b.ts' })).toBe('/a/b.ts')
    expect(toolSummary('Edit', { file_path: '/a/b.ts' })).toBe('/a/b.ts')
    expect(toolSummary('Grep', { pattern: 'TODO' })).toBe('TODO')
    expect(toolSummary('WebSearch', { query: 'bun bug' })).toBe('bun bug')
    expect(toolSummary('WebFetch', { url: 'https://x.com' })).toBe('https://x.com')
    expect(toolSummary('Agent', { description: '扫描仓库' })).toBe('扫描仓库')
  })

  test('超长截断加省略号；未知工具回退 JSON', () => {
    expect(toolSummary('Read', { file_path: 'x'.repeat(200) })).toBe('x'.repeat(120) + '…')
    expect(toolSummary('mcp:foo', { a: 1 })).toBe('{"a":1}')
    expect(toolSummary('mcp:foo', { big: 'y'.repeat(200) }).length).toBe(121)
  })
})

describe('toolDetail（折叠区的完整内容）', () => {
  test('Bash 给命令本体', () => {
    expect(toolDetail('Bash', { command: 'git status' })).toBe('git status')
  })
  test('Edit 拼 文件 + 旧/新 对照', () => {
    expect(toolDetail('Edit', { file_path: '/a.ts', old_string: 'old', new_string: 'new' })).toBe(
      '# /a.ts\n\n--- 旧\nold\n\n+++ 新\nnew',
    )
  })
  test('Write 拼 文件 + 内容；缺字段不留空行', () => {
    expect(toolDetail('Write', { file_path: '/a.ts', content: 'body' })).toBe('# /a.ts\n\nbody')
    expect(toolDetail('Write', { content: 'body' })).toBe('body')
  })
  test('未知工具回退格式化 JSON', () => {
    expect(toolDetail('mcp:foo', { a: 1 })).toBe('{\n  "a": 1\n}')
  })
})

describe('toolResultText / stripAnsi / fmtTokens', () => {
  test('tool_result content 的 string 与块数组两种形态', () => {
    expect(toolResultText('纯文本')).toBe('纯文本')
    expect(toolResultText([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }])).toBe('ab')
    expect(toolResultText([{ type: 'image' }, { type: 'text', text: 'x' }])).toBe('x')
    expect(toolResultText(undefined)).toBe('')
    expect(toolResultText(42)).toBe('')
  })

  test('stripAnsi 只剥转义序列不伤正文', () => {
    expect(stripAnsi('[1;31m红色[0m 普通')).toBe('红色 普通')
    expect(stripAnsi('没有颜色')).toBe('没有颜色')
  })

  test('fmtTokens 千位/百万位缩写', () => {
    expect(fmtTokens(undefined)).toBe('?')
    expect(fmtTokens(999)).toBe('999')
    expect(fmtTokens(1000)).toBe('1.0k')
    expect(fmtTokens(231952)).toBe('232.0k')
    expect(fmtTokens(2_500_000)).toBe('2.5M')
  })
})

describe('groupCollapsibleRuns / buildTranscriptRows', () => {
  const thinking = (text: string): ChatMsg['blocks'][number] => ({ kind: 'thinking', text })
  const tool = (
    id: string,
    name: string,
    extra?: { pending?: boolean; resultError?: boolean; resultText?: string },
  ): ChatMsg['blocks'][number] => ({
    kind: 'tool',
    id,
    name,
    input: { file_path: `/tmp/${id}` },
    ...extra,
  })
  const text = (t: string): ChatMsg['blocks'][number] => ({ kind: 'text', text: t })
  const msg = (id: string, role: ChatMsg['role'], blocks: ChatMsg['blocks']): ChatMsg => ({ id, role, blocks })

  test('一条消息内相邻思考/工具收成一段，正文打断', () => {
    const runs = groupCollapsibleRuns([
      thinking('a'),
      tool('w', 'Write'),
      text('hello'),
      thinking('b'),
      tool('r', 'Read'),
    ])
    expect(runs.map((r) => r.kind)).toEqual(['collapsible', 'content', 'collapsible'])
    if (runs[0]?.kind !== 'collapsible' || runs[2]?.kind !== 'collapsible') throw new Error('expected groups')
    expect(runs[0].blocks.map((b) => b.kind)).toEqual(['thinking', 'tool'])
    expect(runs[2].blocks.map((b) => b.kind)).toEqual(['thinking', 'tool'])
  })

  test('跨连续 assistant 消息把思考/工具并进同一 activity，正文单独成行', () => {
    const rows = buildTranscriptRows([
      msg('u1', 'user', [text('请写文件')]),
      msg('a1', 'assistant', [thinking('t1'), tool('w', 'Write', { resultError: true, resultText: 'fail' })]),
      msg('a2', 'assistant', [thinking('t2'), tool('r', 'Read', { resultText: 'ok' })]),
      msg('a3', 'assistant', [thinking('t3'), text('已存在，无需再写入。')]),
    ])
    expect(rows.map((r) => r.type)).toEqual(['message', 'activity', 'content'])
    const act = rows[1]
    if (act?.type !== 'activity') throw new Error('expected activity')
    expect(act.items.map((it) => (it.block.kind === 'tool' ? it.block.name : '思考'))).toEqual([
      '思考',
      'Write',
      '思考',
      'Read',
      '思考',
    ])
    const body = rows[2]
    if (body?.type !== 'content') throw new Error('expected content')
    expect(body.blocks[0]?.block).toEqual(text('已存在，无需再写入。'))
  })

  test('用户/系统消息打断 activity 组', () => {
    const rows = buildTranscriptRows([
      msg('a1', 'assistant', [thinking('t1'), tool('w', 'Write')]),
      msg('s1', 'system', [text('─ 本轮')]),
      msg('a2', 'assistant', [thinking('t2'), tool('r', 'Read')]),
    ])
    expect(rows.map((r) => r.type)).toEqual(['activity', 'message', 'activity'])
  })

  test('流式草稿的思考/工具并进上一段 activity', () => {
    const rows = buildTranscriptRows([msg('a1', 'assistant', [thinking('t1'), tool('w', 'Write')])], {
      blocks: [
        { idx: 0, kind: 'thinking', text: 'draft-th' },
        { idx: 1, kind: 'tool', text: '', name: 'Read', toolId: 'r', jsonBuf: '{"file_path":"/tmp/r"}' },
        { idx: 2, kind: 'text', text: '正文' },
      ],
    })
    expect(rows.map((r) => r.type)).toEqual(['activity', 'content'])
    const act = rows[0]
    if (act?.type !== 'activity') throw new Error('expected activity')
    expect(act.items).toHaveLength(4)
    expect(act.items[2]?.streaming).toBe(true)
    expect(act.items[3]?.block).toMatchObject({ kind: 'tool', name: 'Read', pending: true })
    const body = rows[1]
    if (body?.type !== 'content') throw new Error('expected content')
    expect(body.blocks[0]?.streaming).toBe(true)
  })

  test('draftBlockToBlock 容忍未闭合 JSON', () => {
    expect(draftBlockToBlock({ idx: 0, kind: 'tool', text: '', name: 'Write', jsonBuf: '{"file' })).toMatchObject({
      kind: 'tool',
      name: 'Write',
      pending: true,
      input: undefined,
    })
  })
})
