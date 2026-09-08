// codex app-server 协议探针：initialize → thread/start → turn/start → 事件流 → interrupt → resume
// 用法：bun run server/scripts/e2e-codex.ts [cwd]
// 目标：验证本机 codex 的握手、事件序列与 usage 形状，为 backends/codex 实现定稿。
// stdio JSON-RPC 样板（spawn/行泵/应答路由）走 e2e-lib 的 spawnAppServer。

import { spawnAppServer } from './e2e-lib'

const cwd = process.argv[2] ?? process.cwd()

const app = spawnAppServer()

const events: string[] = []
let turnCompleted = false
let threadId = ''

app.onEvent((msg) => {
  const method = msg.method ?? '?'
  const params = (msg.params ?? {}) as Record<string, unknown>
  if (method.startsWith('serverRequest:')) {
    console.log(`← REQUEST ${method.slice('serverRequest:'.length)} id=${msg.id}`, JSON.stringify(msg.params).slice(0, 200))
    events.push(`request:${method.slice('serverRequest:'.length)}`)
    return
  }
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
})

void app.stderrText.then((t) => {
  if (t.trim()) console.error('[stderr]', t.slice(0, 800))
})

try {
  const init = (await app.request('initialize', {
    clientInfo: { name: 'anyplane-probe', title: 'anyplane probe', version: '0.1.0' },
    capabilities: { experimentalApi: true },
  })) as Record<string, unknown>
  console.log('✓ initialize:', init.userAgent, 'codexHome:', init.codexHome)
  app.notify('initialized', {})

  const started = (await app.request('thread/start', {
    cwd,
    approvalPolicy: 'never',
    sandbox: 'workspace-write',
    serviceName: 'anyplane-probe',
  })) as { thread: { id: string } }
  console.log('✓ thread/start:', started.thread.id)

  await app.request('turn/start', {
    threadId: started.thread.id,
    input: [{ type: 'text', text: '不要调用任何工具，直接回复两个字：探针成功。' }],
  })
  console.log('✓ turn/start sent')

  const deadline = Date.now() + 120_000
  while (!turnCompleted && Date.now() < deadline) await Bun.sleep(300)

  console.log(turnCompleted ? '✓ turn/completed' : '✗ turn/completed 超时')

  // resume 验证历史回放
  const resumed = (await app.request('thread/resume', { threadId: started.thread.id })) as {
    thread: { id: string; turns?: unknown[] }
  }
  console.log('✓ thread/resume turns:', resumed.thread.turns?.length ?? '(excludeTurns?)')

  // interrupt 空转（无活动 turn，预期报错或空响应，记录行为）
  try {
    await app.request('turn/interrupt', { threadId: started.thread.id, turnId: 'nonexistent' })
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
  app.kill()
}
