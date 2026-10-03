import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { buildTranscriptRows, type ChatMsg } from '../lib/blocks'
import {
  type ConsoleErrorSpy,
  click,
  isKeyWarning,
  render,
  restoreConsoleError,
  setupDom,
  thinkingButtons,
  toolButtons,
  unmountAll,
  watchConsoleError,
} from '../test/dom'
import { Transcript } from './Transcript'

const text = (t: string): ChatMsg['blocks'][number] => ({ kind: 'text', text: t })
const thinking = (t: string): ChatMsg['blocks'][number] => ({ kind: 'thinking', text: t })
const tool = (id: string, name: string, resultText: string): ChatMsg['blocks'][number] => ({
  kind: 'tool',
  id,
  name,
  input: { command: `run-${id}` },
  resultText,
})
const msg = (id: string, role: ChatMsg['role'], blocks: ChatMsg['blocks']): ChatMsg => ({ id, role, blocks })

/** Bug 2 实测序列（重进 codex 会话）：思考1 文本1 工具1 工具2 思考2 文本2 工具3 思考3 文本3 */
const reentryMessages = (): ChatMsg[] => [
  msg('u1', 'user', [text('跑一下验证')]),
  msg('a1', 'assistant', [thinking('思考1'), text('文本1')]),
  msg('a2', 'assistant', [tool('t1', 'Read', 'r1'), tool('t2', 'Bash', 'r2')]),
  msg('a3', 'assistant', [thinking('思考2'), text('文本2')]),
  msg('a4', 'assistant', [tool('t3', 'Bash', 'r3')]),
  msg('a5', 'assistant', [thinking('思考3'), text('文本3')]),
]

describe('Transcript（DOM 整链）：buildTranscriptRows → 渲染的不变量', () => {
  let teardown: () => void
  // 零 key 警告是每条渲染的通用不变量，afterEach 统一断言；
  // 只有「探测器有效性」反例用例经 allowKeyWarnings 显式豁免
  let errorSpy: ConsoleErrorSpy | undefined
  let allowKeyWarnings = false
  beforeAll(() => {
    teardown = setupDom()
  })
  afterAll(() => teardown())
  beforeEach(() => {
    errorSpy = watchConsoleError()
    allowKeyWarnings = false
  })
  afterEach(async () => {
    if (errorSpy) restoreConsoleError(errorSpy, { allowKeyWarnings })
    await unmountAll()
  })

  test('重进会话序列：思考/工具各按源数量渲染、全部默认折叠、零 React key 警告', async () => {
    // Bug 2 的 DOM 级回归网：上游（服务端去重）再退化时，这里会炸出双倍思考或 key 警告
    //（key 碰撞经 React dev 警告冒头，由 afterEach 统一断言——重复元素问题的通用探测器）
    const rows = buildTranscriptRows(reentryMessages())
    const r = await render(<Transcript rows={rows} />)
    const ths = thinkingButtons(r.container)
    expect(ths).toHaveLength(3)
    for (const b of ths) expect(b.getAttribute('aria-expanded')).toBe('false')
    expect(toolButtons(r.container)).toHaveLength(3)
    expect(r.container.querySelector('pre')).toBeNull()
    for (const t of ['文本1', '文本2', '文本3']) expect(r.container.textContent).toContain(t)
  })

  test('探测器有效性：重复 uuid 的消息序列必然触发 duplicate key 警告', async () => {
    // Bug 2 修复前服务端送出的形状（侧车与 inline 各一份同 uuid 思考）。
    // web 层的职责不是消化重复，而是让这类上游回归在测试里炸出来——本用例证明探测器不盲。
    allowKeyWarnings = true
    const dup: ChatMsg[] = [
      msg('r-dup1', 'assistant', [thinking('同一份思考')]),
      msg('r-dup1', 'assistant', [thinking('同一份思考')]),
    ]
    const r = await render(<Transcript rows={buildTranscriptRows(dup)} />)
    // 两份都会被渲染（web 如实呈现输入），但 React 必须警告 key 碰撞
    expect(thinkingButtons(r.container)).toHaveLength(2)
    expect(errorSpy!.mock.calls.filter(isKeyWarning).length).toBeGreaterThan(0)
  })

  test('流式草稿：草稿思考展开、草稿工具与已落地工具全部折叠（Bug 1 DOM 级回归）', async () => {
    const messages: ChatMsg[] = [
      msg('a1', 'assistant', [thinking('已完成的思考'), tool('t1', 'Bash', 'done')]),
    ]
    const draft = {
      blocks: [
        { idx: 0, kind: 'thinking' as const, text: '正在想' },
        { idx: 1, kind: 'tool' as const, text: '', name: 'Bash', toolId: 'td', jsonBuf: '{"command":"ls"}' },
      ],
    }
    const r = await render(<Transcript rows={buildTranscriptRows(messages, draft)} draft={draft} />)
    const ths = [...thinkingButtons(r.container)]
    expect(ths).toHaveLength(2)
    // 落地的思考折叠，草稿思考展开且标「进行中…」
    expect(ths.map((b) => b.getAttribute('aria-expanded'))).toEqual(['false', 'true'])
    expect(r.container.textContent).toContain('进行中…')
    // 工具卡（落地 + 草稿 pending）恒折叠
    expect(toolButtons(r.container)).toHaveLength(2)
    expect(r.container.querySelector('pre')).toBeNull()
    // 草稿无正文块 → 行尾独立光标
    expect(r.container.querySelector('.cc-cursor')).not.toBeNull()
  })

  test('草稿落地：思考随提交自动收起（重挂载），工具仍折叠', async () => {
    const base: ChatMsg[] = [msg('a1', 'assistant', [thinking('已完成的思考'), tool('t1', 'Bash', 'done')])]
    const draft = {
      blocks: [
        { idx: 0, kind: 'thinking' as const, text: '正在想' },
        { idx: 1, kind: 'tool' as const, text: '', name: 'Bash', toolId: 'td', jsonBuf: '{"command":"ls"}' },
      ],
    }
    const r = await render(<Transcript rows={buildTranscriptRows(base, draft)} draft={draft} />)
    expect([...thinkingButtons(r.container)].map((b) => b.getAttribute('aria-expanded'))).toEqual(['false', 'true'])
    // 提交：草稿清空，思考/工具以正式消息落地（uuid 派生 key 改变 → 重挂载 → 思考归折叠）
    const committed: ChatMsg[] = [
      ...base,
      msg('a2', 'assistant', [thinking('正在想'), tool('td', 'Bash', 'done')]),
    ]
    await r.rerender(<Transcript rows={buildTranscriptRows(committed)} />)
    expect([...thinkingButtons(r.container)].map((b) => b.getAttribute('aria-expanded'))).toEqual(['false', 'false'])
    expect(r.container.querySelector('pre')).toBeNull()
    expect(r.container.textContent).not.toContain('进行中…')
  })

  test('窗口平移行 key 稳定：向上 prepend 行后，已展开的工具卡不被 remount 重置', async () => {
    const messages: ChatMsg[] = [
      msg('u1', 'user', [text('最初的问题')]),
      msg('a1', 'assistant', [tool('t1', 'Bash', 'done')]),
    ]
    const rows = buildTranscriptRows(messages)
    // 模拟窗口化尾部切片：先只渲染最后一行（activity），向上滚后 prepend 完整 rows
    const r = await render(<Transcript rows={rows.slice(1)} />)
    await click(r.container.querySelector('button')!)
    expect(r.container.querySelectorAll('pre')).toHaveLength(2)
    await r.rerender(<Transcript rows={rows} />)
    // 行 key 内容派生 → prepend 不 remount → 用户展开态保留
    expect(r.container.querySelectorAll('pre')).toHaveLength(2)
    expect(r.container.textContent).toContain('最初的问题')
  })
})
