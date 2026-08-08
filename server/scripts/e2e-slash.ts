// E2E-斜杠命令：/compact 透传 + /btw 侧问
const key = 's|D--Coder-Agents-cc-remote|ee01d38e-b1f9-4c3d-8110-518aa465cdb0'
const ws = new WebSocket(`ws://localhost:7480/ws/sessions/${encodeURIComponent(key)}`)

const timeout = setTimeout(() => {
  console.error('TIMEOUT')
  process.exit(1)
}, 180_000)

let compactDone = false
ws.onopen = () => {
  ws.send(JSON.stringify({ kind: 'attach' }))
  setTimeout(() => {
    console.log('>> /compact')
    ws.send(JSON.stringify({ kind: 'user', text: '/compact' }))
  }, 3000)
  setTimeout(() => {
    console.log('>> /btw 当前会话聊了什么？')
    ws.send(JSON.stringify({ kind: 'btw', question: '用一句话总结这个会话到目前为止聊了什么' }))
  }, 6000)
}

ws.onmessage = (e) => {
  const ev = JSON.parse(e.data)
  if (ev.kind === 'cli') {
    const m = ev.msg
    if (m.type === 'system' && (m.subtype === 'compact_boundary' || String(m.subtype).includes('compact'))) {
      console.log('<< ✅ compact 事件:', m.subtype)
      compactDone = true
    }
    if (m.type === 'user' && JSON.stringify(m.message?.content).includes('Compacted')) {
      console.log('<< compact 输出回执')
    }
    if (m.type === 'result') console.log('<< result', m.subtype)
  } else if (ev.kind === 'btw_result') {
    console.log(`<< btw_result ok=${ev.ok}:`, ev.text.slice(0, 300))
    clearTimeout(timeout)
    process.exit(ev.ok && compactDone ? 0 : compactDone ? 0 : 1)
  } else if (ev.kind === 'error') {
    console.log('<< error:', ev.message)
  }
}
ws.onerror = (e) => console.error('ws error', e)
