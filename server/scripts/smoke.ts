// 冒烟测试：spawn 真实 claude CLI，走 stream-json 协议收发一轮
// 用法：bun run server/scripts/smoke.ts [cwd]
import { resolveClaudeCommand } from '../src/backends/claude/processManager'
import { controlRequest, userMessage } from '../src/backends/claude/protocol'

const cwd = process.argv[2] ?? process.cwd()
const { cmd, prefix } = resolveClaudeCommand()
console.log(`cmd=${cmd} prefix=${JSON.stringify(prefix)}`)

const proc = Bun.spawn(
  [
    cmd,
    ...prefix,
    '--print',
    '--verbose',
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    '--allow-dangerously-skip-permissions',
  ],
  { cwd, stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' },
)

let gotResult = false
let buf = ''
const decoder = new TextDecoder()
const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader()

const timeout = setTimeout(() => {
  console.error('TIMEOUT: 120s 内未收到 result')
  proc.kill()
  process.exit(1)
}, 120_000)

async function pump() {
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })
    let idx: number
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim()
      buf = buf.slice(idx + 1)
      if (!line) continue
      try {
        const msg = JSON.parse(line)
        const brief =
          msg.type === 'assistant'
            ? `assistant: ${JSON.stringify(msg.message?.content)?.slice(0, 200)}`
            : msg.type === 'system'
              ? `system/${msg.subtype} session=${msg.session_id}`
              : `${msg.type}${msg.subtype ? '/' + msg.subtype : ''}`
        console.log('<<', brief)
        if (msg.type === 'result') {
          gotResult = true
          clearTimeout(timeout)
          proc.kill()
          process.exit(0)
        }
      } catch {
        console.log('<< (non-json)', line.slice(0, 120))
      }
    }
  }
}
void pump()
void new Response(proc.stderr as ReadableStream<Uint8Array>).text().then((t) => {
  if (t.trim()) console.error('[stderr]', t.slice(0, 2000))
})

// 等 init 后发送
await new Promise((r) => setTimeout(r, 3000))
console.log('>> user: 用两个字回答：1+1等于几？')
proc.stdin.write(JSON.stringify(userMessage('用两个字回答：1+1等于几？')) + '\n')
