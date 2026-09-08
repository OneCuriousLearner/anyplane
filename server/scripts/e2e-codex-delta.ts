// codex app-server delta 通知探针（方向五实测）：
//   Turn 1：渐变输出的 shell 命令 + 长文本回答 → 观察 agentMessage/reasoning/commandExecution 的 delta 通知
//   Turn 2：spawn_agent 子代理 → 统计非主线程事件（0.148 起子线程事件直接推到父连接，含嵌套与 resume 后）
// 用途：升级 codex 后回归验证 delta 通知清单与父子事件链是否仍然成立（协议漂移早期信号）。
// 用法：bun run server/scripts/e2e-codex-delta.ts [cwd]
// stdio JSON-RPC 样板（spawn/行泵/应答路由）走 e2e-lib 的 spawnAppServer。

import { spawnAppServer } from './e2e-lib'

const cwd = process.argv[2] ?? process.cwd()

const app = spawnAppServer()

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

app.onEvent((msg) => {
  const method = msg.method ?? '?'
  const params = (msg.params ?? {}) as Record<string, unknown>
  if (method.startsWith('serverRequest:')) {
    console.log(`[${ms()}] ← ${method}（已按探针策略拒绝）`, JSON.stringify(msg.params).slice(0, 160))
    return
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
  // 只打印非高频事件的全貌，delta 类打印前 3 条摘要
  if (!method.includes('delta') && !method.includes('Delta') && !method.endsWith('progress')) {
    console.log(`[${ms()}] ← ${tag} ${method} ${brief(method, params)}`.slice(0, 220))
  } else if ((counts.get(`${tag} ${method}`) ?? 0) <= 3) {
    console.log(`[${ms()}] ← ${tag} ${method} ${brief(method, params)}`.slice(0, 220))
  }
})

void app.stderrText.then((t) => {
  if (t.trim()) console.error('[stderr]', t.slice(0, 500))
})

const waitFor = async (cond: () => boolean, timeoutMs: number, label: string) => {
  const deadline = Date.now() + timeoutMs
  while (!cond() && Date.now() < deadline) await Bun.sleep(200)
  console.log(cond() ? `[${ms()}] ✓ ${label}` : `[${ms()}] ✗ ${label} 超时`)
  return cond()
}

try {
  const init = (await app.request('initialize', {
    clientInfo: { name: 'anyplane-delta-probe', title: 'anyplane delta probe', version: '0.1.0' },
    capabilities: { experimentalApi: true },
  })) as Record<string, unknown>
  console.log('✓ initialize:', init.userAgent)
  app.notify('initialized', {})

  const started = (await app.request('thread/start', {
    cwd,
    approvalPolicy: 'never',
    sandbox: 'workspace-write',
    serviceName: 'anyplane-delta-probe',
  })) as { thread: { id: string } }
  mainThreadId = started.thread.id
  console.log('✓ thread/start:', mainThreadId)

  // ---------- Turn 1：delta 全覆盖 ----------
  await app.request('turn/start', {
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
  await app.request('turn/start', {
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
  app.kill()
}
