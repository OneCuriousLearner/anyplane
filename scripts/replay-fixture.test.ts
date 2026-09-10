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
    lines: 0,
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
    seen.lines++
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

  test('宽松透传：fixture 全部行（含 init/thinking_tokens）都进入消息流', () => {
    // session 层只做副作用提取（init 的 model/sessionId、usage 累计），不做抄本过滤——
    // isMeta/sidechain/system-reminder 的过滤在 Hub 与前端 ingest 层。
    // 仅两类不转发：被 sendControlAndWait 消费的应答、can_use_tool 审批请求（fixture 均无）。
    // 原断言（messages>0 && assistant===0 && result===0 → false）恒真：
    // fixture 必有 assistant/result，与 init 是否被转发无关，且与真实行为（全转发）相反。
    expect(seen.messages).toBe(seen.lines)
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
