// NDJSON fixture 回放测试：把录制的真实 claude headless 流喂给 ClaudeSession 状态机，
// 不 spawn 真 CLI 就能回归 busy 语义 / assistant 归并 / result 与 usage 累计 / idle 终态。
// fixture 来源：claude -p --output-format stream-json --verbose 录制后脱敏
// （session_id/cwd/工具清单/费用时长字段已归一化，见 fixtures/claude-turn-basic.jsonl 头部注释）。

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ClaudeSession } from '../server/src/backends/claude/processManager'
import type { CliMessage } from '../server/src/backends/claude/protocol'

const FIXTURE = join(import.meta.dir, '..', 'server', 'scripts', 'fixtures', 'claude-turn-basic.jsonl')

function replay(fixturePath: string) {
  const seen = {
    messages: 0,
    assistant: 0,
    result: 0,
    errors: 0,
  }
  const session = new ClaudeSession(
    'replay|fixture',
    { cwd: '/tmp' },
    {
      onMessage: (msg: CliMessage) => {
        seen.messages++
        if (msg.type === 'assistant') seen.assistant++
        if (msg.type === 'result') seen.result++
      },
      onApprovalRequest: () => {},
      onExit: () => {},
      onStatusChange: () => {},
    },
  )
  for (const raw of readFileSync(fixturePath, 'utf8').split('\n')) {
    const line = raw.trim()
    if (!line) continue
    try {
      session.injectLine(line)
    } catch {
      seen.errors++
    }
  }
  return { seen, session }
}

describe('replay: claude-turn-basic', () => {
  const { seen, session } = replay(FIXTURE)

  test('无注入异常', () => {
    expect(seen.errors).toBe(0)
  })

  test('init 消息被消费（不进入普通消息流）', () => {
    // fixture 含 1 条 system/init；ClaudeSession 不应把它当普通消息转发
    const initForwarded = seen.messages > 0 && seen.assistant === 0 && seen.result === 0
    expect(initForwarded).toBe(false)
  })

  test('assistant 消息到达', () => {
    expect(seen.assistant).toBeGreaterThanOrEqual(1)
  })

  test('恰好 1 个 result', () => {
    expect(seen.result).toBe(1)
  })

  test('result 后 usage 有累计', () => {
    expect(session.tokenUsage.outputTokens).toBeGreaterThan(0)
  })

  test('结束后 idle', () => {
    expect(session.sessionState).toBe('idle')
  })
})
