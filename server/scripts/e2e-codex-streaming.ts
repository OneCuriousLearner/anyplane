// E2E（方向五）：codex 实时流全链路——delta 翻译 / 工具部分结果 / 子代理桶实时转录。
// 需服务端已启动（bun run dev:server）。真实调用 codex app-server 与模型。
// 服务端配置 authToken 时需要 ANYPLANE_TOKEN 环境变量。
//
// 断言三组：
//  A) 正文/思考流式：stream_event 的 thinking_delta 与 text_delta 在 result 之前到达
//  B) 命令输出部分结果：partial:true 的 tool_result 先于终态 tool_result 到达，且终态文本完整
//  C) collab 子代理：task_started 之后、task_notification 之前，已收到 parent_tool_use_id 侧链消息
// 用法：bun run server/scripts/e2e-codex-streaming.ts [cwd]

import { connect, exitWithSummary, makeNote } from './e2e-lib'

const cwd = process.argv[2] ?? '/data/workspace/anyplane'
const key = `xn|${encodeURIComponent(cwd)}`
const { note, results } = makeNote()
const { ws, on, send, open } = connect(key)

interface Rec {
  i: number
  name: string
  detail?: string
}
const events: Rec[] = []
let seq = 0
const seen = (name: string, detail?: string) => events.push({ i: seq++, name, detail })
const firstIdx = (name: string) => events.find((e) => e.name === name)?.i ?? -1
const countOf = (prefix: string) => events.filter((e) => e.name.startsWith(prefix)).length

let phase: 'turn1' | 'turn2' = 'turn1'
let turn1Result = false
let turn2Result = false
let gotTaskStarted = false
let finished = false

const finish = (ok: boolean, label: string) => {
  if (finished) return
  finished = true
  note(ok, label)
  runAssertions()
  if (results.some((r) => r.startsWith('✗'))) {
    console.log('\n===== 事件轨迹（要点） =====')
    for (const e of events) console.log(`  ${String(e.i).padStart(4)} ${e.name}${e.detail ? `  ${e.detail}` : ''}`)
  }
  exitWithSummary(results)
}

setTimeout(() => finish(false, '总时限内未完成（模型挂起/服务停滞/WS 断开）'), 480_000)

on((ev) => {
  if (ev.kind === 'moved') {
    console.log('<< moved →', ev.targetKey)
    return
  }
  if (ev.kind !== 'cli') return
  const m = ev.msg as Record<string, any>

  if (m.type === 'stream_event') {
    const d = m.event?.delta
    if (d?.type === 'thinking_delta') {
      const name = phase === 'turn1' ? 'A:thinking_delta' : 'C:thinking_delta'
      if (firstIdx(name) < 0) seen(name, JSON.stringify(d.thinking ?? '').slice(0, 40))
    } else if (d?.type === 'text_delta') {
      const name = phase === 'turn1' ? 'A:text_delta' : 'C:text_delta'
      if (firstIdx(name) < 0) seen(name, JSON.stringify(d.text ?? '').slice(0, 40))
    }
    return
  }

  if (m.partial === true && m.type === 'user') {
    const text = String(m.message?.content?.[0]?.content ?? '')
    seen('B:partial_result', `${text.length}B${m.append === true ? ' append' : ''} ${JSON.stringify(text.slice(-30))}`)
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
        send({
          kind: 'user',
          text: '用 spawn_agent 工具派生一个子代理（任务：从 1 数到 5，每个数字一行，直接输出不要调工具），用 wait_agent 等它完成，然后回复它的输出。',
        })
      }, 500)
    } else {
      turn2Result = true
      seen('C:result', m.is_error ? 'error' : 'ok')
      setTimeout(() => finish(true, '两个 turn 均到达 result'), 300)
    }
  }
})

function runAssertions(): void {
  // A) 正文/思考流式（turn1）
  note(firstIdx('A:thinking_delta') >= 0, 'A1 思考增量（thinking_delta）到达')
  note(firstIdx('A:text_delta') >= 0, 'A2 正文增量（text_delta）到达')
  note(
    firstIdx('A:thinking_delta') >= 0 && firstIdx('A:text_delta') >= 0 && firstIdx('A:thinking_delta') < firstIdx('A:result') && firstIdx('A:text_delta') < firstIdx('A:result'),
    'A3 增量先于 result',
  )

  // B) 命令输出部分结果（turn1）
  const firstPartial = firstIdx('B:partial_result')
  const firstFinal = firstIdx('B:tool_result')
  note(firstPartial >= 0, 'B1 partial 工具结果到达', `${countOf('B:partial_result')} 条`)
  note(firstFinal >= 0, 'B2 终态工具结果到达')
  note(firstPartial >= 0 && firstFinal > firstPartial, 'B3 partial 先于终态结果')
  const finals = events.filter((e) => e.name === 'B:tool_result')
  note(
    finals.some((e) => (e.detail ?? '').includes('tick-3')),
    'B4 终态结果含完整输出（tick-3）',
  )
  // append 模式下每条 partial 只含增量：单条体积应远小于全量重发（tick 输出全文也只有几十字节，
  // 此断言主要锁 append 标记的存在——放大约束由 runtime 单测覆盖）
  note(events.some((e) => e.name === 'B:partial_result' && e.detail?.includes('append')), 'B5 partial 携带 append 增量标记')

  // C) 子代理实时转录（turn2）
  note(gotTaskStarted, 'C1 task_started 到达')
  const sidechainIdx = Math.min(
    ...[firstIdx('C:sidechain:assistant'), firstIdx('C:sidechain:user')].filter((i) => i >= 0),
    Number.MAX_SAFE_INTEGER,
  )
  const notifIdx = firstIdx('C:task_notification')
  note(sidechainIdx < Number.MAX_SAFE_INTEGER, 'C2 子代理侧链转录 live 到达')
  note(notifIdx >= 0, 'C3 task_notification 到达')
  note(sidechainIdx < Number.MAX_SAFE_INTEGER && notifIdx > sidechainIdx, 'C4 侧链转录先于终态通知（不再只靠终态拉取）')
  note(turn1Result && turn2Result, 'Z 两个 turn 均完成')
}

await open()
console.log('>> open, attach', key)
send({ kind: 'attach' })
setTimeout(() => {
  console.log('>> turn1：渐变输出命令 + 长文本')
  send({
    kind: 'user',
    text: '依次执行两步：1) 运行 shell 命令 `for i in 1 2 3; do echo tick-$i; sleep 1; done`（不要改动命令）；2) 写一段约 100 字关于飞机的短文。',
  })
}, 1500)

ws.onerror = (e) => console.error('ws error', e)
