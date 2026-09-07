// E2E（方向五）：codex 实时流全链路——delta 翻译 / 工具部分结果 / 子代理桶实时转录。
// 需服务端已启动（bun run dev:server）。真实调用 codex app-server 与模型。
//
// 断言三组：
//  A) 正文/思考流式：stream_event 的 thinking_delta 与 text_delta 在 result 之前到达
//  B) 命令输出部分结果：partial:true 的 tool_result 先于终态 tool_result 到达，且终态文本完整
//  C) collab 子代理：task_started 之后、task_notification 之前，已收到 parent_tool_use_id 侧链消息
// 用法：bun run server/scripts/e2e-codex-streaming.ts [cwd]

const cwd = process.argv[2] ?? '/data/workspace/anyplane'
const key = `xn|${encodeURIComponent(cwd)}`
const tokenQ = process.env.ANYPLANE_TOKEN ? `?token=${process.env.ANYPLANE_TOKEN}` : ''
const ws = new WebSocket(`ws://localhost:7480/ws/sessions/${encodeURIComponent(key)}${tokenQ}`)

interface Rec {
  i: number
  type?: string
  name: string
  detail?: string
}
const events: Rec[] = []
let seq = 0
const seen = (name: string, detail?: string) => events.push({ i: seq++, name, detail })
const firstIdx = (name: string) => events.find((e) => e.name === name)?.i ?? -1

const failures: string[] = []
const assert = (cond: boolean, label: string) => {
  console.log(cond ? `  ✓ ${label}` : `  ✗ ${label}`)
  if (!cond) failures.push(label)
}

let phase: 'turn1' | 'turn2' = 'turn1'
let turn1Result = false
let turn2Result = false
let gotTaskStarted = false

const overallTimeout = setTimeout(() => {
  console.error('TIMEOUT（总时限）')
  reportAndExit(1)
}, 480_000)

function reportAndExit(code: number): void {
  console.log('\n===== 事件轨迹（要点） =====')
  for (const e of events) console.log(`  ${String(e.i).padStart(4)} ${e.name}${e.detail ? `  ${e.detail}` : ''}`)
  console.log(failures.length === 0 ? '\nE2E-STREAMING PASS' : `\nE2E-STREAMING FAIL（${failures.length} 项）`)
  clearTimeout(overallTimeout)
  process.exit(failures.length === 0 ? 0 : code || 1)
}

ws.onopen = () => {
  console.log('>> open, attach', key)
  ws.send(JSON.stringify({ kind: 'attach' }))
  setTimeout(() => {
    console.log('>> turn1：渐变输出命令 + 长文本')
    ws.send(
      JSON.stringify({
        kind: 'user',
        text: '依次执行两步：1) 运行 shell 命令 `for i in 1 2 3; do echo tick-$i; sleep 1; done`（不要改动命令）；2) 写一段约 100 字关于飞机的短文。',
      }),
    )
  }, 1500)
}

ws.onmessage = (e) => {
  const ev = JSON.parse(e.data)
  if (ev.kind === 'moved') {
    console.log('<< moved →', ev.targetKey)
    return
  }
  if (ev.kind !== 'cli') return
  const m = ev.msg

  if (m.type === 'stream_event') {
    const d = m.event?.delta
    if (d?.type === 'thinking_delta') {
      if (firstIdx(phase === 'turn1' ? 'A:thinking_delta' : 'C:thinking_delta') < 0) {
        seen(`${phase === 'turn1' ? 'A' : 'C'}:thinking_delta`, JSON.stringify(d.thinking ?? '').slice(0, 40))
      }
    } else if (d?.type === 'text_delta') {
      if (firstIdx(phase === 'turn1' ? 'A:text_delta' : 'C:text_delta') < 0) {
        seen(`${phase === 'turn1' ? 'A' : 'C'}:text_delta`, JSON.stringify(d.text ?? '').slice(0, 40))
      }
    }
    return
  }

  if (m.partial === true && m.type === 'user') {
    const text = String(m.message?.content?.[0]?.content ?? '')
    seen('B:partial_result', `${text.length}B ${JSON.stringify(text.slice(-30))}`)
    return
  }

  // 子代理侧链转录（live 转发，parent_tool_use_id 在顶层）
  if (m.parent_tool_use_id && (m.type === 'assistant' || m.type === 'user')) {
    const kinds = (m.message?.content ?? []).map((c: { type?: string }) => c?.type).join('+')
    seen(`C:sidechain:${m.type}`, `${kinds} ptui=${String(m.parent_tool_use_id).slice(0, 8)}`)
    return
  }

  if (m.type === 'assistant') {
    for (const c of m.message?.content ?? []) {
      if (c?.type === 'tool_use') seen(`${phase === 'turn1' ? 'B' : 'C'}:tool_use:${c.name}`, String(c.id ?? '').slice(0, 12))
    }
    return
  }

  if (m.type === 'user') {
    for (const c of m.message?.content ?? []) {
      if (c?.type === 'tool_result') {
        seen(`${phase === 'turn1' ? 'B' : 'C'}:tool_result`, String(c.content ?? '').slice(0, 50).replace(/\n/g, '|'))
      }
    }
    return
  }
  if (m.type === 'system') {
    if (m.subtype === 'task_started') {
      gotTaskStarted = true
      seen('C:task_started', String(m.description ?? '').slice(0, 40))
    } else if (m.subtype === 'task_notification') {
      seen('C:task_notification', String(m.status ?? ''))
    }
    return
  }

  if (m.type === 'result') {
    if (phase === 'turn1') {
      turn1Result = true
      seen('A:result', m.is_error ? 'error' : 'ok')
      phase = 'turn2'
      setTimeout(() => {
        console.log('>> turn2：spawn_agent 子代理')
        ws.send(
          JSON.stringify({
            kind: 'user',
            text: '用 spawn_agent 工具派生一个子代理（任务：从 1 数到 5，每个数字一行，直接输出不要调工具），用 wait_agent 等它完成，然后回复它的输出。',
          }),
        )
      }, 500)
    } else {
      turn2Result = true
      seen('C:result', m.is_error ? 'error' : 'ok')
      setTimeout(runAssertions, 300)
    }
  }
}

// assistant/user 侧链（parent_tool_use_id 在顶层）已在主 onmessage 分支统一记录

function runAssertions(): void {
  console.log('\n===== 断言 =====')
  // A) 正文/思考流式（turn1）
  assert(firstIdx('A:thinking_delta') >= 0, 'A1 思考增量（thinking_delta）到达')
  assert(firstIdx('A:text_delta') >= 0, 'A2 正文增量（text_delta）到达')
  assert(firstIdx('A:thinking_delta') < firstIdx('A:result') && firstIdx('A:text_delta') < firstIdx('A:result'), 'A3 增量先于 result')

  // B) 命令输出部分结果（turn1）
  const firstPartial = firstIdx('B:partial_result')
  const firstFinal = firstIdx('B:tool_result')
  assert(firstPartial >= 0, 'B1 partial 工具结果到达')
  assert(firstFinal >= 0, 'B2 终态工具结果到达')
  assert(firstPartial >= 0 && firstFinal > firstPartial, 'B3 partial 先于终态结果')
  const finals = events.filter((e) => e.name === 'B:tool_result')
  assert(finals.some((e) => (e.detail ?? '').includes('tick-3')), 'B4 终态结果含完整输出（tick-3）')

  // C) 子代理实时转录（turn2）
  assert(gotTaskStarted, 'C1 task_started 到达')
  const sidechainIdx = Math.min(
    ...[firstIdx('C:sidechain:assistant'), firstIdx('C:sidechain:user')].filter((i) => i >= 0),
    Number.MAX_SAFE_INTEGER,
  )
  const notifIdx = firstIdx('C:task_notification')
  assert(sidechainIdx < Number.MAX_SAFE_INTEGER, 'C2 子代理侧链转录 live 到达')
  assert(notifIdx >= 0, 'C3 task_notification 到达')
  assert(sidechainIdx < Number.MAX_SAFE_INTEGER && notifIdx > sidechainIdx, 'C4 侧链转录先于终态通知（不再只靠终态拉取）')
  assert(turn1Result && turn2Result, 'Z 两个 turn 均完成')

  reportAndExit(failures.length === 0 ? 0 : 1)
}

ws.onerror = (e) => console.error('ws error', e)
