// E2E：模拟浏览器 WS 客户端，走 attach → user → 收 assistant/result 全流程
// 用法：bun run server/scripts/e2e-ws.ts [cwd] [sessionId]
// cwd 默认 process.cwd()，slug 由 cwd 按 discovery sanitizePath 推导；sessionId 默认 smoke 会话。
import { sanitizePath } from '../src/util'
import { connect } from './e2e-lib'

const cwd = process.argv[2] ?? process.cwd()
const slug = sanitizePath(cwd)
const sessionId = process.argv[3] ?? 'ee01d38e-b1f9-4c3d-8110-518aa465cdb0' // smoke 测试产生的会话
const key = `s|${slug}|${sessionId}`
const { ws, on, send, open } = connect(key)

const timeout = setTimeout(() => {
  console.error('TIMEOUT')
  process.exit(1)
}, 120_000)

await open()
console.log('>> open, attach')
send({ kind: 'attach' })
setTimeout(() => {
  console.log('>> 发送控制消息 set_model sonnet')
  send({ kind: 'control', subtype: 'set_model', extra: { model: 'sonnet' } })
}, 2000)
setTimeout(() => {
  console.log('>> 发送用户消息（考察接续：上一个问题是什么？）')
  send({ kind: 'user', text: '用一句话回答：我上一个问题问的是什么？' })
}, 4000)

on((ev) => {
  if (ev.kind === 'cli') {
    const m = ev.msg as Record<string, any>
    const brief =
      m.type === 'assistant'
        ? `assistant: ${JSON.stringify(m.message?.content)?.slice(0, 300)}`
        : `${String(m.type)}${m.subtype ? '/' + String(m.subtype) : ''}`
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
})
ws.onerror = (e) => console.error('ws error', e)
