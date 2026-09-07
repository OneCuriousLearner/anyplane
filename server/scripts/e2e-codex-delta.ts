// codex app-server delta 通知探针（方向五实测）：
//   Turn 1：渐变输出的 shell 命令 + 长文本回答 → 观察 agentMessage/reasoning/commandExecution 的 delta 通知
//   Turn 2：spawn_agent 子代理 → 统计非主线程事件（0.148 起子线程事件直接推到父连接，含嵌套与 resume 后）
// 用途：升级 codex 后回归验证 delta 通知清单与父子事件链是否仍然成立（协议漂移早期信号）。
// 用法：bun run server/scripts/e2e-codex-delta.ts [cwd]

const cwd = process.argv[2] ?? process.cwd()

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
  proc.stdin.write(JSON.stringify(msg) + '\n')
}

function request(method: string, params?: unknown): Promise<unknown> {
  const id = ++reqId
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    send({ id, method, params })
  })
}

const t0 = Date.now()
const ms = () => String(Date.now() - t0).padStart(6)
/** method → 次数（按线程分组打印用） */
const counts = new Map<string, number>()
const bump = (key: string) => counts.set(key, (counts.get(key) ?? 0) + 1)

let mainThreadId = ''
let childThreadId = ''
let turn1Done = false
let turn2Done = false

function brief(method: string, params: Record<string, unknown>): string {
  if (method === 'item/started' || method === 'item/completed') {
    const item = params.item as { type?: string; id?: string } | undefined
    return `type=${item?.type} id=${(item?.id ?? '').slice(0, 8)}`
  }
  if (method.endsWith('/delta') || method.includes('Delta') || method.endsWith('progress') || method.endsWith('terminalInteraction')) {
    const d = String(params.delta ?? params.message ?? params.stdin ?? '')
    return `itemId=${String(params.itemId ?? '').slice(0, 8)} len=${d.length} ${JSON.stringify(d.slice(0, 40))}`
  }
  if (method === 'turn/completed') {
    const turn = params.turn as { status?: string } | undefined
    return `status=${turn?.status}`
  }
  if (method === 'thread/status/changed') return JSON.stringify(params.status)
  return ''
}

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
      const method = msg.method ?? '?'
      const params = (msg.params ?? {}) as Record<string, unknown>
      if (msg.id !== undefined) {
        // server request（审批等）：本探针一律批准（命令无副作用）
        send({ id: msg.id, result: { decision: 'accept' } })
        continue
      }
      const tid = String(params.threadId ?? '')
      const tag = tid && tid === childThreadId ? 'CHILD' : tid === mainThreadId ? 'MAIN' : '?'
      bump(`${tag} ${method}`)
      if (method === 'turn/completed') {
        if (tid === mainThreadId && !turn1Done) turn1Done = true
        else if (tid === mainThreadId) turn2Done = true
      }
      // spawn End：记录首个子线程 id（仅用于日志归因；0.148 起子线程事件本身即推到父连接，
      // 无需 thread/resume 订阅——这正是方向五赖以转发的事实基础）
      if (method === 'item/completed' && tag === 'MAIN') {
        const item = params.item as { type?: string; tool?: string; receiverThreadIds?: string[] } | undefined
        if (item?.type === 'collabAgentToolCall' && item.receiverThreadIds?.length && !childThreadId) {
          childThreadId = item.receiverThreadIds[0]
          console.log(`[${ms()}] ★ 首个子线程 ${childThreadId}（其后续事件改标 CHILD）`)
        }
      }
      // 只打印非高频事件的全貌，delta 类打印摘要
      if (!method.includes('delta') && !method.includes('Delta') && !method.endsWith('progress')) {
        console.log(`[${ms()}] ← ${tag} ${method} ${brief(method, params)}`.slice(0, 220))
      } else if ((counts.get(`${tag} ${method}`) ?? 0) <= 3) {
        console.log(`[${ms()}] ← ${tag} ${method} ${brief(method, params)}`.slice(0, 220))
      }
    }
  }
}

void pump()
void new Response(proc.stderr as ReadableStream<Uint8Array>).text().then((t) => {
  if (t.trim()) console.error('[stderr]', t.slice(0, 500))
})

const waitFor = async (cond: () => boolean, timeoutMs: number, label: string) => {
  const deadline = Date.now() + timeoutMs
  while (!cond() && Date.now() < deadline) await Bun.sleep(200)
  console.log(cond() ? `[${ms()}] ✓ ${label}` : `[${ms()}] ✗ ${label} 超时`)
  return cond()
}

try {
  const init = (await request('initialize', {
    clientInfo: { name: 'anyplane-delta-probe', title: 'anyplane delta probe', version: '0.1.0' },
    capabilities: { experimentalApi: true },
  })) as Record<string, unknown>
  console.log('✓ initialize:', init.userAgent)
  send({ method: 'initialized', params: {} })

  const started = (await request('thread/start', {
    cwd,
    approvalPolicy: 'never',
    sandbox: 'workspace-write',
    serviceName: 'anyplane-delta-probe',
  })) as { thread: { id: string } }
  mainThreadId = started.thread.id
  console.log('✓ thread/start:', mainThreadId)

  // ---------- Turn 1：delta 全覆盖 ----------
  await request('turn/start', {
    threadId: mainThreadId,
    input: [
      {
        type: 'text',
        text: '依次执行两步：1) 运行 shell 命令 `for i in 1 2 3; do echo tick-$i; sleep 1; done`；2) 不调用任何工具，直接写一段约 150 字关于飞机的短文。',
      },
    ],
  })
  console.log(`[${ms()}] ✓ turn 1 已发送（命令渐进输出 + 长文本）`)
  await waitFor(() => turn1Done, 180_000, 'turn 1 完成')

  // ---------- Turn 2：collab 子线程订阅 ----------
  await request('turn/start', {
    threadId: mainThreadId,
    input: [
      {
        type: 'text',
        text: '使用 spawn_agent 工具派生一个子代理，任务是"从 1 数到 20，每个数字一行，直接输出不要调工具"。用 wait_agent 等待它完成，然后把它的输出原样贴出来。',
      },
    ],
  })
  console.log(`[${ms()}] ✓ turn 2 已发送（spawn_agent 子代理）`)
  await waitFor(() => turn2Done, 300_000, 'turn 2 完成')

  console.log('\n===== 通知计数 =====')
  for (const [k, v] of [...counts.entries()].sort()) console.log(`${String(v).padStart(5)}  ${k}`)
  // 子线程事件在捕获 id 之前到达的按 '?' 归因，这里汇总所有非 MAIN 线程的 item/turn 事件
  const nonMain = [...counts.entries()].filter(([k]) => k.startsWith('CHILD ') || k.startsWith('? item/') || k.startsWith('? turn/'))
  const nonMainTotal = nonMain.reduce((a, [, v]) => a + v, 0)
  console.log('\n非主线程 item/turn 事件数:', nonMainTotal, nonMainTotal > 0 ? '（父子事件链可达，demux 路由转发即可）' : '（未收到，需要其他订阅机制）')
  console.log('PROBE DONE')
  process.exit(0)
} catch (e) {
  console.error('PROBE FAIL:', e)
  process.exit(1)
} finally {
  proc.kill()
}
