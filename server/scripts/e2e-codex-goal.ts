// codex goal 链路验证：新线程 → thread/goal/set → status.goal → clear
const key = `xn|${encodeURIComponent('/tmp')}`
const results: string[] = []
function note(ok: boolean, label: string, detail = '') {
  results.push(`${ok ? '✓' : '✗'} ${label}${detail ? ` — ${detail}` : ''}`)
  console.log(results[results.length - 1])
}

const ws = new WebSocket(`ws://localhost:7480/ws/sessions/${encodeURIComponent(key)}`)
const handlers: Array<(ev: Record<string, unknown>) => void> = []
ws.onmessage = (e) => {
  const ev = JSON.parse(e.data)
  for (const h of handlers) h(ev)
}
const send = (o: unknown) => ws.send(JSON.stringify(o))
await new Promise<void>((r) => { ws.onopen = () => r() })

const timeout = setTimeout(() => { console.error('TIMEOUT\n' + results.join('\n')); process.exit(1) }, 180_000)

let threadId = ''
let turnDone = false
let goalSeen = ''
let goalCleared = false
send({ kind: 'attach' })
handlers.push((ev) => {
  if (ev.kind === 'status') {
    const st = ev.state as { sessionId?: string; goal?: { condition: string } | null }
    if (st.sessionId) threadId = st.sessionId
    if (st.goal?.condition) goalSeen = st.goal.condition
    if (goalSeen && st.goal === null) goalCleared = true
  }
  if (ev.kind === 'cli' && (ev.msg as { type?: string }).type === 'result') turnDone = true
})

send({ kind: 'user', text: '只回复「就绪」两个字。' })
for (let i = 0; i < 120 && !turnDone; i++) await Bun.sleep(1000)
note(turnDone && !!threadId, 'codex 线程就绪', threadId.slice(0, 8))

send({ kind: 'control', subtype: 'set_goal', extra: { objective: '验证目标：回复一次「好」即达成' } })
for (let i = 0; i < 40 && !goalSeen; i++) await Bun.sleep(500)
note(goalSeen.includes('验证目标'), 'thread/goal/set → status.goal', goalSeen.slice(0, 20))

send({ kind: 'control', subtype: 'clear_goal' })
for (let i = 0; i < 40 && !goalCleared; i++) await Bun.sleep(500)
note(goalCleared, 'thread/goal/clear → status.goal 清除')

clearTimeout(timeout)
console.log('\n' + results.join('\n'))
process.exit(results.some((r) => r.startsWith('✗')) ? 1 : 0)
