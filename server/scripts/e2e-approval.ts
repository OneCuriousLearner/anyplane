// E2E-审批：验证 can_use_tool → approval_request → allow → 命令执行
// 用法：bun run server/scripts/e2e-approval.ts
const key = `n|${encodeURIComponent('D:\\Coder\\Agents\\cc-remote')}`
const ws = new WebSocket(`ws://localhost:7480/ws/sessions/${encodeURIComponent(key)}`)

const timeout = setTimeout(() => {
  console.error('TIMEOUT: 未收到 result')
  process.exit(1)
}, 180_000)

let approved = false
ws.onopen = () => {
  console.log('>> attach')
  ws.send(JSON.stringify({ kind: 'attach' }))
  setTimeout(() => {
    console.log('>> user: 写文件（触发审批）')
    ws.send(JSON.stringify({ kind: 'user', text: '请立即用 Write 工具创建文件 D:\\Coder\\Agents\\cc-remote\\approval-test.txt，内容写 cc-remote-approval-ok。只做这一件事。' }))
  }, 3000)
}

ws.onmessage = (e) => {
  const ev = JSON.parse(e.data)
  if (ev.kind === 'approval_request') {
    console.log('<< approval_request:', ev.toolName, JSON.stringify(ev.input)?.slice(0, 200))
    if (!approved) {
      approved = true
      console.log('>> 允许')
      ws.send(JSON.stringify({ kind: 'approval', requestId: ev.requestId, decision: { behavior: 'allow', updatedInput: ev.input } }))
    }
    return
  }
  if (ev.kind === 'cli') {
    const m = ev.msg
    if (m.type === 'assistant') {
      const s = JSON.stringify(m.message?.content)
      if (s.includes('tool_use')) console.log('<< assistant 调用工具')
    }
    if (m.type === 'user') {
      const s = JSON.stringify(m.message?.content)
      if (s.includes('success') || s.includes('cc-remote-approval-ok')) console.log('<< 工具执行回执')
    }
    if (m.type === 'result') {
      console.log('<< result', m.subtype)
      clearTimeout(timeout)
      process.exit(approved ? 0 : 1)
    }
  }
}
ws.onerror = (e) => console.error('ws error', e)
