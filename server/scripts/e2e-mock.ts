// e2e-mock.ts —— mock CLI 全链路 e2e（唯一进 CI 的 e2e；其余 e2e-*.ts 需真实 claude/codex CLI）。
// 用法：bun run server/scripts/e2e-mock.ts（自启临时服务端，无需外部依赖，CI 双平台矩阵跑）
//
// 覆盖点（13.2 遗留：不需要真实模型调用的链路以 mock CLI 搬进 CI）：
// 1. WS 全链路：REST 建会话 → attach 懒启动 → user 消息 → init/assistant/result 流 + status 翻转
//    （顺带断言 capabilities 随 status 下发——13.3 的能力声明面）
// 2. 审批链路：can_use_tool → approval_request → WS 裁决 → approval_resolved + turn 收尾
// 3. /clear 三层重键：conversation_reset → moved 事件 → 新 key attach 复用同进程
// 4. 断线重连补发：fromSeq 游标 → 环内事件单播补放（只认 replay:true 副本）
// 5. 断线错过 resolved（research §6.4）：裁决时离线方的重连重放集不含已裁决审批
//    （服务端 pending 唯一权威；客户端 replace 对齐见 useSessionSocket 的 attach 清空）
//
// mock 注入方式：ANYPLANE_CLAUDE_PATH 指向平台 wrapper（.cmd / .sh，exec bun 跑同目录
// mock-claude.ts）；CLAUDE_CONFIG_DIR 指向临时目录（服务端读写与透传给 CLI 的 claude 侧
// 状态同目录隔离，不触碰真实 ~/.claude；childEnv 继承 process.env 自动透传）。

import { mkdtempSync, rmSync, writeFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { apiFetch, exitWithSummary, makeNote } from './e2e-lib'

const { note, results } = makeNote()

const PORT = 17500 + Math.floor(Math.random() * 400)
// e2e-lib 的 apiFetch/connect 运行时读 ANYPLANE_PORT/ANYPLANE_TOKEN——先对齐端口；
// ANYPLANE_TOKEN 若已在环境里，apiFetch 会带 Bearer（服务端子进程经 ...process.env 继承，
// 两侧同 token，鉴权链路一并覆盖）
process.env.ANYPLANE_PORT = String(PORT)
// tmpRoot 前缀刻意含空格：Windows 上 .cmd wrapper 经 cmd.exe /d /s /c 包装，
// 带空格路径是 wrapIfBatch 的回归覆盖（曾裸路径截断 spawn 失败）
const tmpRoot = mkdtempSync(join(tmpdir(), 'anyplane e2e mock-'))
const sessionCwd = mkdtempSync(join(tmpdir(), 'anyplane-mock-proj-'))
const mockScript = resolve(import.meta.dir, 'mock-claude.ts')
const serverEntry = resolve(import.meta.dir, '..', 'src', 'index.ts')

// ---------- 平台 wrapper ----------
const isWin = process.platform === 'win32'
const wrapperPath = join(tmpRoot, isWin ? 'mock-claude.cmd' : 'mock-claude.sh')
if (isWin) {
  writeFileSync(wrapperPath, `@echo off\r\nbun run "${mockScript}" %*\r\n`)
} else {
  writeFileSync(wrapperPath, `#!/bin/sh\nexec bun run "${mockScript}" "$@"\n`)
  chmodSync(wrapperPath, 0o755)
}

// ---------- 服务端子进程 ----------
const serverLog: string[] = []
const server = Bun.spawn(['bun', serverEntry], {
  cwd: tmpRoot,
  env: {
    ...process.env,
    ANYPLANE_PORT: String(PORT),
    ANYPLANE_CLAUDE_PATH: wrapperPath,
    CLAUDE_CONFIG_DIR: join(tmpRoot, '.claude'),
  },
  stdout: 'pipe',
  stderr: 'pipe',
})
void (async () => {
  const dec = new TextDecoder()
  for await (const c of server.stdout) serverLog.push(dec.decode(c))
})()
void (async () => {
  const dec = new TextDecoder()
  for await (const c of server.stderr) serverLog.push(dec.decode(c))
})()

function cleanup(): void {
  // Windows：先杀整棵进程树再删目录（mock CLI 是服务端的孙子进程，kill 父进程后
  // 立即 rm 会撞 EBUSY——孙进程还持有 cwd 句柄）
  if (isWin && server.pid) {
    Bun.spawnSync(['taskkill', '/PID', String(server.pid), '/T', '/F'], { stdout: 'ignore', stderr: 'ignore' })
  } else {
    try {
      server.kill()
    } catch {}
  }
  for (const dir of [tmpRoot, sessionCwd]) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {} // EBUSY 等残留不清不致命：临时目录由 OS 兜底清理
  }
}

async function waitServerUp(timeoutMs = 20_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const r = await apiFetch('/api/config')
      if (r.ok) return true
    } catch {}
    await Bun.sleep(200)
  }
  return false
}

/** 收集型 WS 客户端：事件全收进 log，waitFor 按谓词等待 */
function client(key: string) {
  const tokenQ = process.env.ANYPLANE_TOKEN ? `?token=${process.env.ANYPLANE_TOKEN}` : ''
  const ws = new WebSocket(`ws://localhost:${PORT}/ws/sessions/${encodeURIComponent(key)}${tokenQ}`)
  const log: Array<Record<string, unknown>> = []
  const waiters: Array<{ pred: (ev: Record<string, unknown>) => boolean; resolve: (ev: Record<string, unknown>) => void }> = []
  ws.onmessage = (e) => {
    const ev = JSON.parse(String(e.data)) as Record<string, unknown>
    log.push(ev)
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (waiters[i].pred(ev)) {
        const w = waiters.splice(i, 1)[0]
        w.resolve(ev)
      }
    }
  }
  return {
    ws,
    log,
    open: () => new Promise<void>((r) => { ws.onopen = () => r() }),
    send: (o: unknown) => ws.send(JSON.stringify(o)),
    waitFor: (pred: (ev: Record<string, unknown>) => boolean, timeoutMs = 15_000) =>
      new Promise<Record<string, unknown>>((resolveEv, reject) => {
        const hit = log.find(pred)
        if (hit) return resolveEv(hit)
        const timer = setTimeout(() => {
          // 超时诊断：dump 已收事件骨架（kind/subtype/busy/spawned），CI 失败时不用复现就能定位
          const skeleton = log
            .map((ev) => {
              const msg = ev.msg as { type?: string; subtype?: string } | undefined
              const st = ev.state as { busy?: boolean; spawned?: boolean } | undefined
              return `${ev.kind}${msg ? `:${msg.type}${msg.subtype ? `/${msg.subtype}` : ''}` : ''}${st ? `(busy=${st.busy},spawned=${st.spawned})` : ''}`
            })
            .join(' ')
          reject(new Error(`等待事件超时；已收 ${log.length} 条: ${skeleton.slice(0, 400)}`))
        }, timeoutMs)
        waiters.push({
          pred,
          resolve: (ev) => {
            clearTimeout(timer)
            resolveEv(ev)
          },
        })
      }),
  }
}

async function main(): Promise<void> {
  note(await waitServerUp(), '服务端就绪（临时目录配置注入 mock claudePath）', `port=${PORT}`)
  if (!results[0].startsWith('✓')) {
    console.error(serverLog.join('').slice(-2000))
    return
  }

  // 1. REST 建会话（顺带覆盖 POST /api/sessions 注册表分发）
  const createRes = await apiFetch('/api/sessions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ cwd: sessionCwd, backend: 'claude' }),
  })
  const created = (await createRes.json()) as { key?: string }
  note(createRes.ok && typeof created.key === 'string' && created.key.startsWith('n|'), 'POST /api/sessions 返回 n| key', created.key ?? '')
  const key = created.key!

  // 2. attach + 懒启动 + 首个 turn
  const c1 = client(key)
  await c1.open()
  c1.send({ kind: 'attach' })
  const st0 = await c1.waitFor((ev) => ev.kind === 'status')
  const caps = (st0.state as { capabilities?: { fileCheckpoint?: boolean } } | undefined)?.capabilities
  note(
    (st0.state as { spawned?: boolean })?.spawned === false && caps?.fileCheckpoint === true,
    'attach 首发 status：未 spawn + capabilities 下发（fileCheckpoint=true）',
  )
  c1.send({ kind: 'user', text: 'hello' })
  const initEv = await c1.waitFor((ev) => ev.kind === 'cli' && (ev.msg as { subtype?: string })?.subtype === 'init')
  note((initEv.msg as { session_id?: string })?.session_id === 'mock-sess-1', '首个 turn 收到 init（mock sessionId）')
  await c1.waitFor((ev) => ev.kind === 'cli' && (ev.msg as { type?: string })?.type === 'assistant')
  await c1.waitFor((ev) => ev.kind === 'cli' && (ev.msg as { type?: string })?.type === 'result')
  note(true, '首个 turn 完成：assistant + result 到达')
  const stBusy = c1.log.some(
    (ev) => ev.kind === 'status' && (ev.state as { busy?: boolean })?.busy === true,
  )
  const stIdleAfter = await c1.waitFor(
    (ev) => ev.kind === 'status' && (ev.state as { busy?: boolean })?.busy === false && (ev.state as { spawned?: boolean })?.spawned === true,
  )
  note(stBusy && !!stIdleAfter, 'status 翻转：turn 期间 busy=true，收尾回落 busy=false')

  // 3. 审批链路
  c1.send({ kind: 'user', text: 'MOCK_APPROVAL 请执行 ls' })
  const approval = await c1.waitFor((ev) => ev.kind === 'approval_request')
  const requestId = String(approval.requestId ?? '')
  note(approval.toolName === 'Bash' && requestId.length > 0, 'approval_request 到达（can_use_tool 外化）', `requestId=${requestId}`)
  c1.send({ kind: 'approval', requestId, decision: { behavior: 'allow', updatedInput: { command: 'ls' } } })
  await c1.waitFor((ev) => ev.kind === 'approval_resolved' && ev.requestId === requestId)
  await c1.waitFor((ev) => ev.kind === 'cli' && (ev.msg as { type?: string })?.type === 'result' && c1.log.indexOf(ev) > c1.log.indexOf(approval))
  note(true, '审批裁决后 approval_resolved + turn 收尾（mock 等到 control_response 才完成）')

  // 4. 断线重连补发（fromSeq 游标）：c1 断开期间的环内事件应由 c2 补放。
  // 断线期间没有新事件就无可补发——c2 先不 attach 直接发 user（事件入环），再带 fromSeq attach。
  const lastSeq = Math.max(0, ...c1.log.filter((ev) => ev.kind === 'cli').map((ev) => Number(ev.seq ?? 0)))
  c1.ws.close()
  await Bun.sleep(300) // 等服务端 wsClose 走完（Hub 因会话句柄存活而保留）
  const c2 = client(key)
  await c2.open()
  c2.send({ kind: 'user', text: 'replay-marker' })
  await Bun.sleep(500) // mock turn 同步完成：init/assistant/result 全入环
  c2.send({ kind: 'attach', fromSeq: lastSeq })
  await Bun.sleep(300)
  // 只认 replay:true 的补发副本——c2 在 wsOpen 时已入 hub.clients，live 广播的同款事件
  // 也会进 c2.log；不带 replay 标记的断言会被 live 副本喂成重言式（补发坏了也绿）
  const replayed = c2.log.filter((ev) => ev.kind === 'cli' && ev.replay === true && Number(ev.seq ?? 0) > lastSeq)
  const replayedResult = replayed.some((ev) => (ev.msg as { type?: string })?.type === 'result')
  note(replayed.length > 0 && replayedResult, '重连 fromSeq 补发：断线期间的环内事件单播补放（replay:true 含 result）', `补发 ${replayed.length} 条`)

  // 5. /clear 三层重键
  c2.send({ kind: 'user', text: '/clear' })
  const moved = await c2.waitFor((ev) => ev.kind === 'moved')
  const newKey = String(moved.targetKey ?? '')
  note(newKey.startsWith('s|') && newKey !== key, '/clear 触发 moved：重键到 s|<slug>|<newSid>', newKey)
  const c3 = client(newKey)
  await c3.open()
  c3.send({ kind: 'attach' })
  const st3 = await c3.waitFor((ev) => ev.kind === 'status')
  note(
    (st3.state as { spawned?: boolean })?.spawned === true &&
      (st3.state as { sessionId?: string })?.sessionId === moved.targetSessionId,
    '新 key attach 复用同进程（三层重键无 spawn 重复）',
  )
  c2.ws.close()
  c3.ws.close()

  // 6. 断线错过 resolved（research §6.4 点名用例）：裁决时离线的客户端，
  // 重连 attach 的重放集不含已裁决审批——服务端 pending 是唯一权威，
  // 客户端 replace 对齐（attach 时清空本地集）据此收敛
  const cOff = client(newKey)
  await cOff.open()
  cOff.send({ kind: 'attach' })
  await cOff.waitFor((ev) => ev.kind === 'status')
  cOff.send({ kind: 'user', text: 'MOCK_APPROVAL 断线场景' })
  const ap2 = await cOff.waitFor((ev) => ev.kind === 'approval_request')
  const req2 = String(ap2.requestId ?? '')
  note(req2.length > 0, '第二次审批挂起（断线场景准备）', req2)
  cOff.ws.close() // 裁决时离线的一方
  await Bun.sleep(300)
  const cJudge = client(newKey)
  await cJudge.open()
  cJudge.send({ kind: 'attach' })
  const replayToJudge = await cJudge.waitFor((ev) => ev.kind === 'approval_request')
  note(String(replayToJudge.requestId) === req2, '另一连接 attach：重放仍 pending 的审批')
  cJudge.send({ kind: 'approval', requestId: req2, decision: { behavior: 'allow', updatedInput: { command: 'ls' } } })
  await cJudge.waitFor((ev) => ev.kind === 'approval_resolved' && ev.requestId === req2)
  const cBack = client(newKey)
  await cBack.open()
  cBack.send({ kind: 'attach' })
  await Bun.sleep(400) // 负断言不能 waitFor（会超时）：等重放窗口过后查 log
  const staleReplay = cBack.log.filter((ev) => ev.kind === 'approval_request' && ev.requestId === req2)
  note(staleReplay.length === 0, '裁决后重连：重放集不含已裁决审批（replace 对齐的权威源）')
  cJudge.ws.close()
  cBack.ws.close()
}

const watchdog = setTimeout(() => {
  note(false, '整体超时（90s watchdog）')
  console.error(serverLog.join('').slice(-2000))
  cleanup()
  process.exit(1)
}, 90_000)

main()
  .catch((e) => {
    note(false, `异常中断: ${e instanceof Error ? e.message : e}`)
    console.error(serverLog.join('').slice(-2000))
  })
  .finally(() => {
    clearTimeout(watchdog)
    cleanup()
    exitWithSummary(results)
  })
