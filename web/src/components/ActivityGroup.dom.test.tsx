import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import type { ActivityItem } from '../lib/blocks'
import { click, render, setupDom, thinkingButtons, unmountAll } from '../test/dom'
import { ActivityGroup } from './ActivityGroup'

const thinking = (text: string, streaming?: boolean): ActivityItem => ({
  key: `th:${text}`,
  block: { kind: 'thinking', text },
  streaming,
})

const tool = (id: string, extra?: { pending?: boolean; resultText?: string }): ActivityItem => ({
  key: `tool:${id}`,
  block: { kind: 'tool', id, name: 'Bash', input: { command: 'ls' }, ...extra },
})

const thinkingButton = (c: HTMLElement) => thinkingButtons(c)[0]!

describe('ActivityGroup（DOM）：思考随流式开合是唯一自动行为', () => {
  let teardown: () => void
  beforeAll(() => {
    teardown = setupDom()
  })
  afterAll(() => teardown())
  afterEach(() => unmountAll())

  test('流式中的思考强制展开：aria-expanded=true、正文可见、标「进行中…」', async () => {
    const r = await render(<ActivityGroup items={[thinking('正在推理', true)]} />)
    const btn = thinkingButton(r.container)!
    expect(btn.getAttribute('aria-expanded')).toBe('true')
    expect(r.container.textContent).toContain('正在推理')
    expect(r.container.textContent).toContain('进行中…')
  })

  test('streaming 结束自动收起：aria-expanded=false、正文消失', async () => {
    const r = await render(<ActivityGroup items={[thinking('想完了', true)]} />)
    expect(thinkingButton(r.container)!.getAttribute('aria-expanded')).toBe('true')
    await r.rerender(<ActivityGroup items={[thinking('想完了', false)]} />)
    expect(thinkingButton(r.container)!.getAttribute('aria-expanded')).toBe('false')
    expect(r.container.textContent).not.toContain('想完了')
  })

  test('流式中用户手动折叠后，同 streaming=true 的文本更新不顶回展开（effect 只认翻转）', async () => {
    // effect 依赖 [streaming]：流式期间 streaming 不变→effect 不重跑→用户折叠保留；
    // streaming 翻 false 时才强制收起。钉住这条交互链。
    const r = await render(<ActivityGroup items={[thinking('长思考', true)]} />)
    await click(thinkingButton(r.container)!)
    expect(thinkingButton(r.container)!.getAttribute('aria-expanded')).toBe('false')
    // 同 streaming=true 的文本更新（新 block 对象）不重置用户折叠
    await r.rerender(<ActivityGroup items={[{ key: 'th:长思考', block: { kind: 'thinking', text: '长思考+更多' }, streaming: true }]} />)
    expect(thinkingButton(r.container)!.getAttribute('aria-expanded')).toBe('false')
  })

  test('pending 且已有部分结果的工具卡仍默认折叠（Bug 1 DOM 级回归）', async () => {
    const r = await render(<ActivityGroup items={[tool('t1', { pending: true, resultText: 'tick-1\n' })]} />)
    expect(r.container.querySelector('pre')).toBeNull()
    expect(r.container.textContent).toContain('…')
  })

  test('用户展开工具卡后，流式部分结果更新（同 key 新对象）不顶掉展开态', async () => {
    const r = await render(<ActivityGroup items={[tool('t1', { pending: true, resultText: 'tick-1\n' })]} />)
    await click(r.container.querySelector('button')!)
    expect(r.container.textContent).toContain('tick-1')
    await r.rerender(<ActivityGroup items={[tool('t1', { pending: true, resultText: 'tick-1\ntick-2\n' })]} />)
    // 仍展开且新结果已流入
    expect(r.container.querySelectorAll('pre')).toHaveLength(2)
    expect(r.container.textContent).toContain('tick-2')
  })
})
