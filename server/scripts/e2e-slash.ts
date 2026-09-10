// E2E-斜杠命令：/compact 透传 + /btw 侧问
// 用法：bun run server/scripts/e2e-slash.ts [cwd] [sessionId]
import { sanitizePath } from '../src/util'
import { connect } from './e2e-lib'

const cwd = process.argv[2] ?? process.cwd()
const slug = sanitizePath(cwd)
const sessionId = process.argv[3] ?? 'ee01d38e-b1f9-4c3d-8110-518aa465cdb0'
const key = `s|${slug}|${sessionId}`
const { ws, on, send, open } = connect(key)

const timeout = setTimeout(() => {
  console.error('TIMEOUT')
  process.exit(1)
}, 180_000)

let compactDone = false
await open()
send({ kind: 'attach' })
setTimeout(() => {
  console.log('>> /compact')
  send({ kind: 'user', text: '/compact' })
}, 3000)
setTimeout(() => {
  console.log('>> /btw 当前会话聊了什么？')
  send({ kind: 'btw', question: '用一句话总结这个会话到目前为止聊了什么' })
}, 6000)

on((ev) => {
  if (ev.kind === 'cli') {
    const m = ev.msg as Record<string, any>
    if (m.type === 'system' && (m.subtype === 'compact_boundary' || String(m.subtype).includes('compact'))) {
      console.log('<< ✅ compact 事件:', m.subtype)
      compactDone = true
    }
    if (m.type === 'user' && JSON.stringify(m.message?.content).includes('Compacted')) {
      console.log('<< compact 输出回执')
    }
    if (m.type === 'result') console.log('<< result', m.subtype)
  } else if (ev.kind === 'btw_result') {
    console.log(`<< btw_result ok=${String(ev.ok)}:`, String(ev.text ?? '').slice(0, 300))
    clearTimeout(timeout)
    process.exit(compactDone ? 0 : 1)
  } else if (ev.kind === 'error') {
    console.log('<< error:', ev.message)
  }
})
ws.onerror = (e) => console.error('ws error', e)
