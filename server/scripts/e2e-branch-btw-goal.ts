// 验证链路：btw(side_question) → branch(懒分叉) → /goal 状态跟踪
// 用法：bun run server/scripts/e2e-branch-btw-goal.ts
const cwd = '/tmp'
const nKey = `n|${encodeURIComponent(cwd)}`
const results: string[] = []
function note(ok: boolean, label: string, detail = '') {
  results.push(`${ok ? '✓' : '✗'} ${label}${detail ? ` — ${detail}` : ''}`)
  console.log(results[results.length - 1])
}

function connect(key: string) {
  const ws = new WebSocket(`ws://localhost:7480/ws/sessions/${encodeURIComponent(key)}`)
  const handlers: Array<(ev: Record<string, unknown>) => void> = []
  ws.onmessage = (e) => {
    const ev = JSON.parse(e.data)
    for (const h of handlers) h(ev)
  }
  return {
    ws,
    on: (h: (ev: Record<string, unknown>) => void) => handlers.push(h),
    send: (o: unknown) => ws.send(JSON.stringify(o)),
    open: () => new Promise<void>((r) => { ws.onopen = () => r() }),
  }
}

const timeout = setTimeout(() => {
  console.error('TIMEOUT\n' + results.join('\n'))
  process.exit(1)
}, 240_000)

// ---------- 1. 新会话发消息建立上下文 ----------
const a = connect(nKey)
await a.open()
a.send({ kind: 'attach' })
let sessionId = ''
let turnDone = false
a.on((ev) => {
  if (ev.kind === 'status' && (ev.state as { sessionId?: string }).sessionId) {
    sessionId = (ev.state as { sessionId: string }).sessionId
  }
  if (ev.kind === 'cli' && (ev.msg as { type?: string }).type === 'result') turnDone = true
})
a.send({ kind: 'user', text: '记住暗号「星河战舰」，只回复「收到」两个字。' })
for (let i = 0; i < 120 && !turnDone; i++) await new Promise((r) => setTimeout(r, 1000))
note(turnDone && !!sessionId, '源会话建立上下文', `sessionId=${sessionId.slice(0, 8)}`)

// ---------- 2. btw：side_question 通道 ----------
let btwText = ''
let btwOk = false
let btwAt = 0
const btwStart = Date.now()
a.on((ev) => {
  if (ev.kind === 'btw_result') {
    btwOk = ev.ok === true
    btwText = String((ev as { text?: string }).text ?? '')
    btwAt = Date.now() - btwStart
  }
})
a.send({ kind: 'btw', question: '我刚才给你的暗号是什么？只回答暗号本身。' })
for (let i = 0; i < 90 && !btwText; i++) await new Promise((r) => setTimeout(r, 1000))
note(btwOk && btwText.includes('星河战舰'), 'btw 侧问（side_question）', `${btwAt}ms, 答=${btwText.slice(0, 30)}`)

// ---------- 3. branch：懒分叉 ----------
let branchKey = ''
a.on((ev) => {
  if (ev.kind === 'forked' && (ev as { branchOf?: string }).branchOf) {
    branchKey = String((ev as { targetKey?: string }).targetKey ?? '')
  }
})
a.send({ kind: 'branch' })
for (let i = 0; i < 10 && !branchKey; i++) await new Promise((r) => setTimeout(r, 500))
note(branchKey.startsWith('b|'), 'branch 创建 b| key', branchKey ? decodeURIComponent(branchKey.split('|')[1]) + '|…' : '无')

// 分支会话发消息：应触发 --fork-session spawn，且继承暗号上下文
const b = connect(branchKey)
await b.open()
b.send({ kind: 'attach' })
let bSessionId = ''
let bDone = false
let bAnswer = ''
b.on((ev) => {
  if (ev.kind === 'status' && (ev.state as { sessionId?: string }).sessionId) {
    bSessionId = (ev.state as { sessionId: string }).sessionId
  }
  if (ev.kind === 'cli') {
    const m = ev.msg as { type?: string; message?: { content?: Array<{ text?: string }> } }
    if (m.type === 'assistant') {
      for (const c of m.message?.content ?? []) if (c.text) bAnswer += c.text
    }
    if (m.type === 'result') bDone = true
  }
})
b.send({ kind: 'user', text: '源会话里我给的暗号是什么？只回答暗号。' })
for (let i = 0; i < 120 && !bDone; i++) await new Promise((r) => setTimeout(r, 1000))
const forkedNewId = bSessionId && bSessionId !== sessionId
note(bDone && forkedNewId && bAnswer.includes('星河战舰'), '分支 fork 启动且继承上下文', `新 sid=${bSessionId.slice(0, 8)} 答=${bAnswer.slice(-30)}`)

// ---------- 4. /goal 状态跟踪 ----------
let goalSeen = false
let goalCleared = false
a.on((ev) => {
  if (ev.kind === 'status') {
    const g = (ev.state as { goal?: { condition: string } | null }).goal
    if (g?.condition.includes('测试目标')) goalSeen = true
    if (goalSeen && g === null) goalCleared = true
  }
})
a.send({ kind: 'user', text: '/goal 测试目标：只回复一次「达成」即完成' })
for (let i = 0; i < 30 && !goalSeen; i++) await new Promise((r) => setTimeout(r, 500))
note(goalSeen, '/goal 状态进入 status.goal')
// goal 循环跑完（result 到达）后 chip 应清除
turnDone = false
for (let i = 0; i < 150 && !goalCleared; i++) await new Promise((r) => setTimeout(r, 1000))
note(goalCleared, 'goal 完成后 status.goal 清除')

clearTimeout(timeout)
console.log('\n—— 汇总 ——')
console.log(results.join('\n'))
const failed = results.filter((r) => r.startsWith('✗')).length
process.exit(failed ? 1 : 0)
