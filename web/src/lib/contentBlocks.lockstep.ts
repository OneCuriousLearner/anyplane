// web / server `cliContentToHistoryBlocks` 的共享夹具。两边测试各跑一遍，再互相对拍。
// 新增块类型或收紧守卫时先改这里。

import type { HistoryBlock } from '@anyplane/protocol'

export type LockstepCase = {
  name: string
  content: unknown
  onImage?: (c: Record<string, unknown>) => HistoryBlock | undefined
  expected: HistoryBlock[]
}

const persistImage = (c: Record<string, unknown>): HistoryBlock | undefined => {
  const source = c.source as { type?: string; data?: string } | undefined
  if (source?.type !== 'base64' || typeof source.data !== 'string') return undefined
  return { kind: 'image', src: `/api/uploads/fixture-${source.data.slice(0, 4)}` }
}

export const LOCKSTEP_CASES: LockstepCase[] = [
  { name: '字符串 content → text', content: '你好', expected: [{ kind: 'text', text: '你好' }] },
  { name: '空白字符串 → 空', content: '   ', expected: [] },
  { name: '非数组非字符串 → 空', content: { type: 'text', text: 'x' }, expected: [] },
  { name: 'undefined → 空', content: undefined, expected: [] },
  {
    name: 'text/thinking/tool_use/tool_result',
    content: [
      { type: 'thinking', thinking: '想一想' },
      { type: 'text', text: '答' },
      { type: 'tool_use', name: 'Bash', id: 'tu1', input: { command: 'ls' } },
      { type: 'tool_result', tool_use_id: 'tu1', content: [{ type: 'text', text: 'ok' }], is_error: false },
      { type: 'text', text: '   ' },
    ],
    expected: [
      { kind: 'thinking', text: '想一想' },
      { kind: 'text', text: '答' },
      { kind: 'tool_use', name: 'Bash', id: 'tu1', input: { command: 'ls' } },
      { kind: 'tool_result', id: 'tu1', text: 'ok', isError: false },
    ],
  },
  {
    name: '非字符串 text/thinking 丢掉（typeof 守卫）',
    content: [
      { type: 'text', text: 42 },
      { type: 'thinking', thinking: { n: 1 } },
      { type: 'text', text: '留下' },
    ],
    expected: [{ kind: 'text', text: '留下' }],
  },
  {
    name: 'image + onImage 落块',
    content: [{ type: 'image', source: { type: 'base64', data: 'abcd' } }],
    onImage: persistImage,
    expected: [{ kind: 'image', src: '/api/uploads/fixture-abcd' }],
  },
  {
    name: 'image 无 onImage → 空（前端 live sidechain）',
    content: [{ type: 'image', source: { type: 'base64', data: 'abcd' } }],
    expected: [],
  },
  {
    name: 'image 非法 source → onImage 返回 undefined → 空',
    content: [{ type: 'image', source: { type: 'url', url: 'https://x' } }],
    onImage: persistImage,
    expected: [],
  },
  {
    name: 'tool_result 字符串 content',
    content: [{ type: 'tool_result', tool_use_id: 't', content: 'plain', is_error: true }],
    expected: [{ kind: 'tool_result', id: 't', text: 'plain', isError: true }],
  },
]
