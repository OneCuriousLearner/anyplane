// reasoning 侧车：codex rollout 不持久化 reasoning，anyplane 自行落盘 ~/.anyplane/reasoning/<threadId>.jsonl。
// 测试用随机 threadId 隔离真实数据，结束后清理。
import { afterAll, describe, expect, test } from 'bun:test'
import { appendFileSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { appendReasoning, readReasoning } from './reasoningStore'

const THREAD = `test-${crypto.randomUUID()}`
const file = () => join(homedir(), '.anyplane', 'reasoning', `${THREAD}.jsonl`)

afterAll(() => {
  rmSync(file(), { force: true })
})

describe('reasoningStore', () => {
  test('未落盘的线程读出空数组', () => {
    expect(readReasoning(`missing-${crypto.randomUUID()}`)).toEqual([])
  })

  test('append → read 往返，按行追加', () => {
    appendReasoning(THREAD, { ts: 1000, turnId: 't1', text: '先想一下' })
    appendReasoning(THREAD, { ts: 2000, turnId: null, text: '再想一下' })
    expect(readReasoning(THREAD)).toEqual([
      { ts: 1000, turnId: 't1', text: '先想一下' },
      { ts: 2000, turnId: null, text: '再想一下' },
    ])
  })

  test('坏行/缺字段/空文本被容忍跳过，不影响其余行', () => {
    appendFileSync(file(), 'not json at all\n')
    appendFileSync(file(), '{"broken":\n')
    appendFileSync(file(), JSON.stringify({ ts: 'oops', turnId: null, text: 'ts 不是数字' }) + '\n')
    appendFileSync(file(), JSON.stringify({ ts: 3000, turnId: null, text: '   ' }) + '\n')
    appendReasoning(THREAD, { ts: 4000, turnId: 't2', text: '有效条目' })
    expect(readReasoning(THREAD)).toEqual([
      { ts: 1000, turnId: 't1', text: '先想一下' },
      { ts: 2000, turnId: null, text: '再想一下' },
      { ts: 4000, turnId: 't2', text: '有效条目' },
    ])
  })
})
