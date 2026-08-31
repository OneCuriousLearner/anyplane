// E2E-回滚：串行覆盖三条路径 —— rewind_files 控制请求 → rewind_conversation → rewind_both
// 三条都打到同一个目标消息（幂等：空恢复快照 + 同一截断点），最后发问验证会话可用。
// 用法：bun run server/scripts/e2e-rewind.ts [cwd] [sessionId]
const sanitizePath = (p: string) => p.replace(/[^a-zA-Z0-9]/g, '-')
const cwd = process.argv[2] ?? process.cwd()
const slug = sanitizePath(cwd)
const sessionId = process.argv[3] ?? 'ee01d38e-b1f9-4c3d-8110-518aa465cdb0'
const key = `s|${slug}|${sessionId}`

const tokenQ = process.env.ANYPLANE_TOKEN ? `?token=${process.env.ANYPLANE_TOKEN}` : ''
// 从 REST 拿一条用户消息 uuid。取最后一条带文本的用户消息：
// 最早的消息通常早于文件检查点（无快照可恢复），最近的消息最可能有 checkpoint。
const hist = await (await fetch(`http://localhost:7480/api/history/${slug}/${sessionId}`)).json()
const candidates = hist.filter(
  (m) =>
    m.role === 'user' &&
    m.uuid &&
    m.rewindable !== false &&
    (m.blocks ?? []).some((b) => b.kind === 'text' && typeof b.text === 'string' && b.text.trim()),
)
const target = candidates[candidates.length - 1]
if (!target) {
  console.error('没有可回滚的用户消息（可能都在 compact 边界之前）')
  process.exit(1)
}
const preview = (target.blocks ?? [])
  .filter((b) => b.kind === 'text' && typeof b.text === 'string')
  .map((b) => b.text as string)
  .join(' ')
console.log('回滚目标:', target.uuid, (preview || '(非文本消息)').slice(0, 50))

const ws = new WebSocket(`ws://localhost:7480/ws/sessions/${encodeURIComponent(key)}${tokenQ}`)
const timeout = setTimeout(() => {
  console.error('TIMEOUT')
  process.exit(1)
}, 180_000)

const fail = (why: string): never => {
  console.error('❌', why)
  clearTimeout(timeout)
  process.exit(1)
}

// 0=等待 attach → 1=等待 rewind_files 应答 → 2=等待 rewound(conversation)
// → 3=等待 rewound(both) → 4=等待回滚后问答 result
let phase = 0

ws.onopen = () => {
  ws.send(JSON.stringify({ kind: 'attach' }))
  setTimeout(() => {
    if (phase !== 0) return
    phase = 1
    console.log('>> 路径1: rewind_files（通用 control 通道，透传语义）')
    ws.send(JSON.stringify({ kind: 'control', subtype: 'rewind_files', extra: { user_message_id: target.uuid } }))
  }, 3000)
}

ws.onmessage = (e) => {
  const ev = JSON.parse(e.data)
  if (ev.kind === 'cli') {
    const m = ev.msg
    if (m.type === 'control_response') {
      console.log('<< control_response:', JSON.stringify(m.response)?.slice(0, 300))
      if (phase !== 1) return
      if (m.response?.subtype !== 'success') fail(`rewind_files 被拒绝: ${m.response?.error}`)
      phase = 2
      console.log('>> 路径2: rewind_conversation（重生进程截断对话）')
      ws.send(JSON.stringify({ kind: 'rewind_conversation', userMessageId: target.uuid }))
      return
    }
    if (m.type === 'result') {
      if (phase < 4) return
      console.log('<< result', m.subtype)
      console.log('✅ rewind E2E 成功（三条路径全覆盖）')
      clearTimeout(timeout)
      process.exit(0)
    }
    return
  }
  if (ev.kind === 'rewound') {
    console.log('<< rewound 事件:', ev.scope)
    if (phase === 2 && ev.scope === 'conversation') {
      phase = 3
      // 等重生进程站稳再走组合路径
      setTimeout(() => {
        if (phase !== 3) return
        console.log('>> 路径3: rewind_both（先恢复文件，成功后回滚对话）')
        ws.send(JSON.stringify({ kind: 'rewind_both', userMessageId: target.uuid }))
      }, 3000)
      return
    }
    if (phase === 3 && ev.scope === 'both') {
      phase = 4
      // init 是惰性的（首条输入后才发），等待 respawn 后直接发问
      setTimeout(() => {
        if (phase !== 4) return
        console.log('>> 回滚后发问')
        ws.send(JSON.stringify({ kind: 'user', text: '用两个字回答：2+2等于几？' }))
      }, 5000)
      return
    }
    fail(`意外的 rewound: phase=${phase} scope=${ev.scope}`)
    return
  }
  if (ev.kind === 'error') {
    fail(ev.message)
  }
}
ws.onerror = (e) => console.error('ws error', e)
