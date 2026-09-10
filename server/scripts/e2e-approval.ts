// E2E-审批：验证 can_use_tool → approval_request → allow → 命令执行
// 用法：bun run server/scripts/e2e-approval.ts [cwd]
// 不传 cwd 则默认 process.cwd()，与 smoke.ts 一致。
import path from 'node:path'
import { connect } from './e2e-lib'

const cwd = process.argv[2] ?? process.cwd()
const marker = `${path.basename(cwd)}-approval-ok`
const key = `n|${encodeURIComponent(cwd)}`
const { ws, on, send, open } = connect(key)

const timeout = setTimeout(() => {
  console.error('TIMEOUT: 未收到 result')
  process.exit(1)
}, 180_000)

let approved = false
await open()
console.log('>> attach')
send({ kind: 'attach' })
setTimeout(() => {
  console.log('>> user: 写文件（触发审批）')
  send({ kind: 'user', text: `请立即用 Write 工具创建文件 ${path.join(cwd, 'approval-test.txt')}，内容写 ${marker}。只做这一件事。` })
}, 3000)

on((ev) => {
  if (ev.kind === 'approval_request') {
    console.log('<< approval_request:', ev.toolName, JSON.stringify(ev.input)?.slice(0, 200))
    if (!approved) {
      approved = true
      console.log('>> 允许')
      send({ kind: 'approval', requestId: ev.requestId, decision: { behavior: 'allow', updatedInput: ev.input } })
    }
    return
  }
  if (ev.kind === 'cli') {
    const m = ev.msg as Record<string, any>
    if (m.type === 'assistant') {
      const s = JSON.stringify(m.message?.content)
      if (s.includes('tool_use')) console.log('<< assistant 调用工具')
    }
    if (m.type === 'user') {
      const s = JSON.stringify(m.message?.content)
      if (s.includes('success') || s.includes(marker)) console.log('<< 工具执行回执')
    }
    if (m.type === 'result') {
      console.log('<< result', m.subtype)
      clearTimeout(timeout)
      process.exit(approved ? 0 : 1)
    }
  }
})
ws.onerror = (e) => console.error('ws error', e)
