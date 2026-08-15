// E2E-回滚：rewind_both 先确认 rewind_files，再重生进程截断对话
const key = 's|D--Coder-Agents-cc-remote|ee01d38e-b1f9-4c3d-8110-518aa465cdb0'

// 从 REST 拿一条用户消息 uuid
const hist = await (await fetch(`http://localhost:7480/api/history/D--Coder-Agents-cc-remote/ee01d38e-b1f9-4c3d-8110-518aa465cdb0`)).json()
const target = hist.find((m) => m.role === 'user' && m.uuid && m.rewindable !== false)
if (!target) {
  console.error('没有可回滚的用户消息（可能都在 compact 边界之前）')
  process.exit(1)
}
console.log('回滚目标:', target.uuid, target.text.slice(0, 50))

const ws = new WebSocket(`ws://localhost:7480/ws/sessions/${encodeURIComponent(key)}`)
const timeout = setTimeout(() => {
  console.error('TIMEOUT')
  process.exit(1)
}, 180_000)

let phase = 0
let initCount = 0
ws.onopen = () => {
  ws.send(JSON.stringify({ kind: 'attach' }))
  setTimeout(() => {
    if (phase !== 0) return
    phase = 1
    console.log('>> rewind_both（先恢复文件，成功后回滚对话）')
    ws.send(JSON.stringify({ kind: 'rewind_both', userMessageId: target.uuid }))
  }, 3000)
}

ws.onmessage = (e) => {
  const ev = JSON.parse(e.data)
  if (ev.kind === 'cli') {
    const m = ev.msg
    if (m.type === 'control_response') {
      console.log('<< control_response:', JSON.stringify(m.response)?.slice(0, 300))
    }
    if (m.type === 'result') {
      console.log('<< result', m.subtype, '— init 次数:', initCount)
      console.log('✅ rewind E2E 成功')
      clearTimeout(timeout)
      process.exit(0)
    }
  } else if (ev.kind === 'rewound') {
    console.log('<< rewound 事件:', ev.scope)
    if (phase !== 1 || ev.scope !== 'both') return
    phase = 2
    // init 是惰性的（首条输入后才发），等待 respawn 后直接发问
    setTimeout(() => {
      if (phase !== 2) return
      phase = 3
      console.log('>> 回滚后发问')
      ws.send(JSON.stringify({ kind: 'user', text: '用两个字回答：2+2等于几？' }))
    }, 5000)
  } else if (ev.kind === 'error') {
    console.log('<< error:', ev.message)
  }
}
ws.onerror = (e) => console.error('ws error', e)
