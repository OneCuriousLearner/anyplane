// NDJSON fixture 回放：把录制的真实 claude 流喂给 ClaudeSession 状态机，
// 不 spawn 真 CLI 就能回归 busy 语义 / 审批转发 / 内部消息过滤 / 用量累计。
// 用法：bun run server/scripts/replay-fixture.ts [fixture.jsonl]
//   默认 /data/workspace/handoff-lab/claude-turn1.jsonl（handoff 实验录制）

import { existsSync, readFileSync } from 'node:fs'
import { ClaudeSession } from '../src/backends/claude/processManager'
import type { CliMessage } from '../src/backends/claude/protocol'

const fixture =
  process.argv[2] ?? '/data/workspace/handoff-lab/claude-turn1.jsonl'
if (!existsSync(fixture)) {
  console.error(`找不到 fixture: ${fixture}`)
  process.exit(1)
}

const seen = {
  messages: 0,
  assistant: 0,
  result: 0,
  internalFiltered: 0, // 由 injectLine 前的预检查统计（isInternalUserMessage 在宿主层过滤）
  stateChanges: [] as string[],
  approvals: 0,
  usage: null as unknown,
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
    onApprovalRequest: () => seen.approvals++,
    onExit: (code) => console.log(`[replay] onExit code=${code}`),
    onStatusChange: () => {},
  },
)

let lines = 0
for (const raw of readFileSync(fixture, 'utf8').split('\n')) {
  const line = raw.trim()
  if (!line) continue
  lines++
  try {
    session.injectLine(line)
  } catch (e) {
    seen.errors++
    console.error(`[replay] 第 ${lines} 行注入异常:`, e)
  }
}

const st = session.sessionState
const usage = session.tokenUsage
console.log(`回放 ${lines} 行: messages=${seen.messages} assistant=${seen.assistant} result=${seen.result} approvals=${seen.approvals} errors=${seen.errors}`)
console.log(`终态: sessionState=${st} usage=${JSON.stringify(usage)}`)

let pass = true
const check = (name: string, ok: boolean) => {
  console.log(`${ok ? '✓' : '✗'} ${name}`)
  if (!ok) pass = false
}
check('无注入异常', seen.errors === 0)
check('至少 1 条 assistant', seen.assistant >= 1)
check('恰好 1 个 result', seen.result === 1)
check('result 后有 usage 累计', usage.outputTokens > 0)
check('结束后 idle', st === 'idle')

console.log(pass ? 'REPLAY PASS' : 'REPLAY FAIL')
process.exit(pass ? 0 : 1)
