// E2E：模拟浏览器 WS 客户端，走 attach → user → 收 assistant/result 全流程
// 用法：bun run server/scripts/e2e-ws.ts
const slug = 'D--Coder-Agents-cc-remote'
const sessionId = 'ee01d38e-b1f9-4c3d-8110-518aa465cdb0' // smoke 测试产生的会话
const key = `s|${slug}|${sessionId}`

const tokenQ = process.env.CC_REMOTE_TOKEN ? `?token=${process.env.CC_REMOTE_TOKEN}` : ''
const ws = new WebSocket(`ws://localhost:7480/ws/sessions/${encodeURIComponent(key)}${tokenQ}`)

const timeout = setTimeout(() => {
  console.error('TIMEOUT')
  process.exit(1)
}, 120_000)

ws.onopen = () => {
  console.log('>> open, attach')
  ws.send(JSON.stringify({ kind: 'attach' }))
  setTimeout(() => {
    console.log('>> 发送控制消息 set_model sonnet')
    ws.send(JSON.stringify({ kind: 'control', subtype: 'set_model', extra: { model: 'sonnet' } }))
  }, 2000)
  setTimeout(() => {
    console.log('>> 发送用户消息（考察接续：上一个问题是什么？）')
    ws.send(JSON.stringify({ kind: 'user', text: '用一句话回答：我上一个问题问的是什么？' }))
  }, 4000)
}

ws.onmessage = (e) => {
  const ev = JSON.parse(e.data)
  if (ev.kind === 'cli') {
    const m = ev.msg
    const brief =
      m.type === 'assistant'
        ? `assistant: ${JSON.stringify(m.message?.content)?.slice(0, 300)}`
        : `${m.type}${m.subtype ? '/' + m.subtype : ''}`
    console.log('<< cli', brief)
    if (m.type === 'control_request') console.log('   控制请求:', JSON.stringify(m.request)?.slice(0, 200))
    if (m.type === 'result') {
      console.log('✅ E2E 成功')
      clearTimeout(timeout)
      process.exit(0)
    }
  } else {
    console.log('<<', ev.kind, JSON.stringify(ev.state ?? ev.message ?? ev.requestId ?? ''))
  }
}
ws.onerror = (e) => console.error('ws error', e)
