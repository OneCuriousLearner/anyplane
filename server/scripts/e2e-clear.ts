// E2E：claude /clear 对话重置——干净目录，无跨测试残留
// 验证：moved 重键事件、旧连接路由跟随、新会话无旧上下文
// 用法：bun run server/scripts/e2e-clear.ts（需服务端已启动）
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const results: string[] = []
function note(ok: boolean, label: string, detail = '') {
  results.push(`${ok ? '✓' : '✗'} ${label}${detail ? ` — ${detail}` : ''}`)
  console.log(results[results.length - 1])
}

const dir = mkdtempSync(join(tmpdir(), 'ccr-clear-'))
const key = `n|${encodeURIComponent(dir)}`
console.log('>> 测试目录:', dir)

const timeout = setTimeout(() => {
  console.error('TIMEOUT\n' + results.join('\n'))
  process.exit(1)
}, 300_000)

const ws = new WebSocket(`ws://localhost:7480/ws/sessions/${encodeURIComponent(key)}`)
const events: Array<{ at: number; kind: string; brief: string }> = []
let movedKey = ''
let answerAfterClear = ''
ws.onmessage = (e) => {
  const ev = JSON.parse(e.data)
  if (ev.kind === 'moved') {
    movedKey = String(ev.targetKey ?? '')
    events.push({ at: Date.now(), kind: 'moved', brief: movedKey })
    return
  }
  if (ev.kind !== 'cli') return
  const m = ev.msg as { type?: string; subtype?: string; message?: { content?: Array<{ type?: string; text?: string }> }; result?: string }
  if (m.type === 'result') events.push({ at: Date.now(), kind: 'result', brief: String(m.result ?? '').slice(0, 40) })
  if (m.type === 'assistant') {
    for (const c of m.message?.content ?? []) {
      if (c.type === 'text' && c.text) {
        events.push({ at: Date.now(), kind: 'text', brief: c.text.slice(0, 40) })
        if (movedKey) answerAfterClear += c.text
      }
    }
  }
}
await new Promise<void>((r) => (ws.onopen = () => r()))
ws.send(JSON.stringify({ kind: 'attach' }))
await new Promise((r) => setTimeout(r, 400))

// 等 result 的稳健助手
async function awaitResult(fromIndex: number, ms: number): Promise<boolean> {
  for (let i = 0; i < ms / 500; i++) {
    if (events.slice(fromIndex).some((e) => e.kind === 'result')) return true
    await new Promise((r) => setTimeout(r, 500))
  }
  return false
}

// 1. 建立上下文
let idx = events.length
ws.send(JSON.stringify({ kind: 'user', text: '记住暗号「蓝莓蛋糕」，只回复「收到」两个字。' }))
note(await awaitResult(idx, 150_000), 'clear 前：上下文建立')

// 2. /clear
idx = events.length
ws.send(JSON.stringify({ kind: 'user', text: '/clear' }))
for (let i = 0; i < 60 && !movedKey; i++) await new Promise((r) => setTimeout(r, 500))
note(movedKey.startsWith('s|'), 'clear 触发 moved（Hub 重键）', movedKey.split('|').pop()?.slice(0, 8))
// clear 自身的 result（空回合）收掉
await awaitResult(idx, 30_000)

// 3. 旧连接上发新问题（路由应跟随重键后的 Hub；新会话应无暗号）
idx = events.length
ws.send(JSON.stringify({ kind: 'user', text: '我之前给你的暗号是什么？不知道就回答「不知道」。' }))
const got = await awaitResult(idx, 150_000)
note(got, '重键后旧连接消息路由正常（无黑洞）')
const clean = answerAfterClear.includes('不知道') && !answerAfterClear.includes('蓝莓蛋糕')
note(clean, '新会话无旧上下文（clear 语义正确）', answerAfterClear.slice(0, 50))

console.log('\n>> 事件流:')
for (const e of events) console.log(`  ${((e.at - events[0].at) / 1000).toFixed(1)}s ${e.kind} ${e.brief}`)

ws.close()
rmSync(dir, { recursive: true, force: true })
clearTimeout(timeout)
console.log('\n—— 汇总 ——')
console.log(results.join('\n'))
process.exit(results.some((r) => r.startsWith('✗')) ? 1 : 0)
