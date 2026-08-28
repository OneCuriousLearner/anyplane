// codex app-server 协议探针：initialize → thread/start → turn/start → 事件流 → interrupt → resume
// 用法：bun run server/scripts/e2e-codex.ts [cwd]
// 目标：验证本机 codex 的握手、事件序列与 usage 形状，为 backends/codex 实现定稿。

const cwd = process.argv[2] ?? '/data/workspace/handoff-lab'

interface RpcMsg {
  id?: number | string
  method?: string
  params?: unknown
  result?: unknown
  error?: { code: number; message: string }
}

const proc = Bun.spawn(['codex', 'app-server', '--stdio'], {
  stdin: 'pipe',
  stdout: 'pipe',
  stderr: 'pipe',
})

let reqId = 0
const pending = new Map<number, { resolve: (r: unknown) => void; reject: (e: Error) => void }>()

function send(msg: RpcMsg): void {
  const line = JSON.stringify(msg)
  console.log('→', line.slice(0, 160))
  proc.stdin.write(line + '\n')
}

function request(method: string, params?: unknown): Promise<unknown> {
  const id = ++reqId
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    send({ id, method, params })
  })
}

const events: string[] = []
let turnCompleted = false
let threadId = ''

async function pump(): Promise<void> {
  const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader()
  const decoder = new TextDecoder()
  let buf = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })
    let idx: number
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim()
      buf = buf.slice(idx + 1)
      if (!line) continue
      let msg: RpcMsg
      try {
        msg = JSON.parse(line)
      } catch {
        console.log('!! 非 JSON 行:', line.slice(0, 120))
        continue
      }
      if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
        const p = pending.get(Number(msg.id))
        if (p) {
          pending.delete(Number(msg.id))
          if (msg.error) p.reject(new Error(`${msg.error.code}: ${msg.error.message}`))
          else p.resolve(msg.result)
        }
        continue
      }
      // notification 或 server 发起的 request
      const method = msg.method ?? '?'
      if (msg.id !== undefined) {
        console.log(`← REQUEST ${method} id=${msg.id}`, JSON.stringify(msg.params).slice(0, 200))
        events.push(`request:${method}`)
        // 探针不答审批（本 turn 不需要）；若出现则拒绝
        send({ id: msg.id, result: { decision: 'decline' } })
        continue
      }
      const params = msg.params as Record<string, unknown> | undefined
      let brief = ''
      if (method === 'thread/started') {
        threadId = (params?.thread as { id?: string })?.id ?? ''
        brief = `threadId=${threadId}`
      } else if (method === 'turn/completed') {
        turnCompleted = true
        const turn = params?.turn as { status?: string } | undefined
        brief = `status=${turn?.status} usage=${JSON.stringify(params?.usage ?? (params?.turn as { usage?: unknown })?.usage)}`
      } else if (method === 'item/started' || method === 'item/completed') {
        brief = `type=${(params?.item as { type?: string })?.type}`
      } else if (method === 'thread/status/changed') {
        brief = JSON.stringify(params?.status)
      }
      console.log(`← ${method} ${brief}`.slice(0, 200))
      events.push(method)
    }
  }
}

void pump()
void new Response(proc.stderr as ReadableStream<Uint8Array>).text().then((t) => {
  if (t.trim()) console.error('[stderr]', t.slice(0, 800))
})

try {
  const init = (await request('initialize', {
    clientInfo: { name: 'cc-remote-probe', title: 'cc-remote probe', version: '0.1.0' },
    capabilities: { experimentalApi: true },
  })) as Record<string, unknown>
  console.log('✓ initialize:', init.userAgent, 'codexHome:', init.codexHome)
  send({ method: 'initialized', params: {} })

  const started = (await request('thread/start', {
    cwd,
    approvalPolicy: 'never',
    sandbox: 'workspace-write',
    serviceName: 'cc-remote-probe',
  })) as { thread: { id: string } }
  console.log('✓ thread/start:', started.thread.id)

  await request('turn/start', {
    threadId: started.thread.id,
    input: [{ type: 'text', text: '不要调用任何工具，直接回复两个字：探针成功。' }],
  })
  console.log('✓ turn/start sent')

  const deadline = Date.now() + 120_000
  while (!turnCompleted && Date.now() < deadline) await Bun.sleep(300)

  console.log(turnCompleted ? '✓ turn/completed' : '✗ turn/completed 超时')

  // resume 验证历史回放
  const resumed = (await request('thread/resume', { threadId: started.thread.id })) as {
    thread: { id: string; turns?: unknown[] }
  }
  console.log('✓ thread/resume turns:', resumed.thread.turns?.length ?? '(excludeTurns?)')

  // interrupt 空转（无活动 turn，预期报错或空响应，记录行为）
  try {
    await request('turn/interrupt', { threadId: started.thread.id, turnId: 'nonexistent' })
    console.log('✓ interrupt(无活动 turn) 接受')
  } catch (e) {
    console.log('✓ interrupt(无活动 turn) 报错（预期之一）:', String(e).slice(0, 120))
  }

  const uniq = [...new Set(events)]
  console.log('\n事件序列去重:', uniq.join(', '))
  console.log('PROBE PASS')
  process.exit(0)
} catch (e) {
  console.error('PROBE FAIL:', e)
  process.exit(1)
} finally {
  proc.kill()
}
