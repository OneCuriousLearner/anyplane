import { describe, expect, test } from 'bun:test'
import {
  parseUserText,
  rewindPreview,
  shortTokens,
  stripAnsi,
  toolDetail,
  toolResultText,
  toolSummary,
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

describe('toolResultText / stripAnsi / shortTokens', () => {
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

  test('shortTokens 千位缩写', () => {
    expect(shortTokens(undefined)).toBe('?')
    expect(shortTokens(999)).toBe('999')
    expect(shortTokens(1000)).toBe('1k')
    expect(shortTokens(231952)).toBe('232k')
  })
})
