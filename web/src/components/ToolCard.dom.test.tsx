import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import type { ToolBlock } from '../lib/blocks'
import { click, render, setupDom, unmountAll } from '../test/dom'
import { ToolCard } from './ToolCard'

const tool = (extra?: Partial<ToolBlock>): ToolBlock => ({
  kind: 'tool',
  id: 't1',
  name: 'Bash',
  input: { command: 'ls -la' },
  ...extra,
})

describe('ToolCard（DOM）：恒默认折叠、开合全由用户（2026-10-02 决策）', () => {
  let teardown: () => void
  beforeAll(() => {
    teardown = setupDom()
  })
  afterAll(() => teardown())
  afterEach(() => unmountAll())

  test('完成态默认折叠：不渲染参数/结果区，行尾 ✓', async () => {
    const r = await render(<ToolCard tool={tool({ resultText: 'ok' })} />)
    // 摘要在折叠态就显示命令本身，折叠断言只能看详情 pre 不存在
    expect(r.container.querySelector('pre')).toBeNull()
    expect(r.container.textContent).toContain('✓')
    expect(r.container.textContent).toContain('▸')
  })

  test('点击展开参数与结果，再点折叠', async () => {
    const r = await render(<ToolCard tool={tool({ resultText: 'line1' })} />)
    await click(r.container.querySelector('button')!)
    // 展开 = 参数 pre + 结果 pre
    expect(r.container.querySelectorAll('pre')).toHaveLength(2)
    expect(r.container.textContent).toContain('line1')
    expect(r.container.textContent).toContain('▾')
    await click(r.container.querySelector('button')!)
    expect(r.container.querySelector('pre')).toBeNull()
  })

  test('props 更新（流式结果落地新对象）不顶掉用户已展开的状态', async () => {
    const t = tool({ resultText: 'line1' })
    const r = await render(<ToolCard tool={t} />)
    await click(r.container.querySelector('button')!)
    expect(r.container.textContent).toContain('line1')
    // 不可变更新纪律下内容变必换新对象——open 是用户状态，不随 props 重置
    await r.rerender(<ToolCard tool={{ ...t, resultText: 'line1\nline2' }} />)
    expect(r.container.textContent).toContain('line2')
    expect(r.container.querySelectorAll('pre')).toHaveLength(2)
  })

  test('pending 行尾 … 且无 ✓/✗，同样默认折叠', async () => {
    const r = await render(<ToolCard tool={tool({ pending: true, resultText: 'tick-1\n' })} />)
    expect(r.container.textContent).toContain('…')
    expect(r.container.textContent).not.toContain('✓')
    expect(r.container.textContent).not.toContain('✗')
    expect(r.container.querySelector('pre')).toBeNull()
  })

  test('错误结果行尾 ✗，默认仍折叠', async () => {
    const r = await render(<ToolCard tool={tool({ resultText: 'boom', resultError: true })} />)
    expect(r.container.textContent).toContain('✗')
    expect(r.container.querySelector('pre')).toBeNull()
  })
})
