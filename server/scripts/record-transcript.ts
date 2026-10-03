// record-transcript.ts —— 真实会话转录录制器（transcript 回放 fixture 的生产工具）。
//
// 用法（需服务端已启动；ANYPLANE_PORT 默认 7480，配 token 时带 ANYPLANE_TOKEN）：
//   bun run server/scripts/record-transcript.ts --backend claude --cwd D:\tmp\ap-fx-claude \
//     --prompt "先读 notes.txt，再……" --scenario streaming-tools \
//     --out web/src/test/fixtures/claude-streaming-tools.json \
//     --history-out web/src/test/fixtures/claude-reentry.json
//
// 原理：录制器就是一个普通客户端——REST 建会话、WS attach、发 user 消息、把收到的
// 每个下行事件原样落盘；turn 收尾（result + 权威 idle）后经 describeKey 解析升键 key
// 拼 history REST 路径，把「重进会话时客户端会拿到的载荷」存成第二个 fixture。
// 零服务端改动：录的是客户端视角的真实流（AGENTS.md「非必要不 mock」）——web 侧
// 回放 harness（web/src/test/replay.tsx）消费的正是这两段。
//
// 纪律：
// - --cwd 用不含用户名的短路径（fixture 进仓库）；落盘前脚本把 cwd/用户目录字符串
//   替换为 <CWD>/<HOME>；
// - 审批自动 allow（无人值守录制；fixture meta.approvals 记次数）——prompt 别给
//   破坏性命令，scratch cwd 里折腾；
// - 落盘后人工过一遍再提交：尺寸、隐私、是否混进无关 turn。

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { describeKey } from '../src/backends/port'
import { sanitizePath } from '../src/util'
import { apiFetch, connect } from './e2e-lib'

interface Args {
  backend?: string
  cwd?: string
  prompt?: string
  scenario?: string
  out?: string
  historyOut?: string
  timeoutMs: number
}

function parseArgs(): Args {
  const a: Args = { timeoutMs: 300_000 }
  const argv = process.argv.slice(2)
  for (let i = 0; i < argv.length; i++) {
    const v = argv[++i]
    switch (argv[i - 1]) {
      case '--backend': a.backend = v; break
      case '--cwd': a.cwd = v; break
      case '--prompt': a.prompt = v; break
      case '--scenario': a.scenario = v; break
      case '--out': a.out = v; break
      case '--history-out': a.historyOut = v; break
      case '--timeout': a.timeoutMs = Number(v); break
    }
  }
  for (const k of ['backend', 'cwd', 'prompt', 'scenario', 'out'] as const) {
    if (!a[k]) {
      console.error(`缺 --${k}（--history-out/--timeout 可选）`)
      process.exit(2)
    }
  }
  if (a.backend !== 'claude' && a.backend !== 'codex') {
    console.error('--backend 只认 claude|codex')
    process.exit(2)
  }
  if (!Number.isFinite(a.timeoutMs) || a.timeoutMs <= 0) {
    console.error(`--timeout 必须是正数毫秒（收到：${a.timeoutMs}）`)
    process.exit(2)
  }
  return a
}

const args = parseArgs()

// ---------- 1. 建会话 ----------
const createRes = await apiFetch('/api/sessions', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ cwd: args.cwd, backend: args.backend }),
})
if (!createRes.ok) {
  console.error(`POST /api/sessions 失败：${createRes.status} ${await createRes.text()}`)
  process.exit(1)
}
const { key } = (await createRes.json()) as { key: string }
console.log(`[record] 会话 key=${key}`)

// ---------- 2. attach 并全程录制 ----------
const events: Record<string, unknown>[] = []
let finalKey = key
let resultSeen = false
let idleAfterResult = false
let approvals = 0

const c = connect(key)
c.on((ev) => {
  events.push(ev)
  if (ev.kind === 'moved' && typeof ev.targetKey === 'string') finalKey = ev.targetKey
  if (ev.kind === 'approval_request') {
    // 无人值守自动放行（codex approvalsReviewer:user 与 claude can_use_tool 同路）
    approvals++
    const input = (ev as { input?: unknown }).input
    c.send({ kind: 'approval', requestId: ev.requestId, decision: { behavior: 'allow', ...(input !== undefined ? { updatedInput: input } : {}) } })
    console.log(`[record] 审批自动 allow（第 ${approvals} 次）`)
  }
  if (ev.kind === 'cli' && (ev.msg as { type?: string })?.type === 'result') resultSeen = true
  if (ev.kind === 'status' && resultSeen) {
    const st = ev.state as { busy?: boolean } | undefined
    if (st && st.busy === false) idleAfterResult = true
  }
})
// connect().open() 已内建 onerror/onclose reject（e2e-lib），此处只加 15s 连接超时
await c.open(15_000)
c.send({ kind: 'attach' })

// 等 attach 首发 status（懒启动握手）
await new Promise<void>((resolve, reject) => {
  const t = setTimeout(() => reject(new Error('attach 首发 status 超时')), 30_000)
  c.on((ev) => {
    if (ev.kind === 'status') {
      clearTimeout(t)
      resolve()
    }
  })
})

// ---------- 3. 发 prompt，等到 result + 权威 idle ----------
console.log(`[record] 发送 prompt（${args.prompt!.length} 字）…`)
c.send({ kind: 'user', text: args.prompt })

const deadline = Date.now() + args.timeoutMs
while (!idleAfterResult && Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 250))
}
c.ws.close()
if (!idleAfterResult) {
  console.error(`[record] 超时（${args.timeoutMs}ms）：resultSeen=${resultSeen}。已录 ${events.length} 事件，仍写出供排查。`)
}

// ---------- 4. 落盘（cwd/HOME 脱敏） ----------
const home = process.env.USERPROFILE ?? process.env.HOME ?? ''
// 深遍历在 stringify 之前做——JSON 转义后的文本替换会漏掉 \\ 形态。
// 同一来源的全部形态都换：Windows 反斜杠 / POSIX / claude slug（sanitizePath，
// 与官方 CLI projects 目录规则同源）/ URI 编码（n| key 内嵌）。
const replacements: Array<[string, string]> = []
const pushForms = (raw: string, to: string) => {
  const posix = raw.replace(/\\/g, '/')
  replacements.push([raw, to], [posix, to], [sanitizePath(raw), to], [encodeURIComponent(raw), to], [encodeURIComponent(posix), to])
}
pushForms(args.cwd!, '<CWD>')
if (home) pushForms(home, '<HOME>')

const scrubDeep = (v: unknown): unknown => {
  if (typeof v === 'string') {
    let s = v
    for (const [from, to] of replacements) s = s.split(from).join(to)
    return s
  }
  if (Array.isArray(v)) return v.map(scrubDeep)
  if (v && typeof v === 'object') {
    return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, scrubDeep(x)]))
  }
  return v
}

const meta = {
  backend: args.backend,
  scenario: args.scenario,
  prompt: args.prompt,
  recordedAt: new Date().toISOString(),
  approvals,
  source: 'server/scripts/record-transcript.ts',
}
const writeFixture = (path: string, fixture: unknown) => {
  const p = resolve(path)
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, JSON.stringify(scrubDeep(fixture), null, 2) + '\n')
  console.log(`[record] 写出 ${p}`)
}

writeFixture(args.out!, { meta, history: null, events })
console.log(`[record] live 事件 ${events.length} 条（审批 ${approvals} 次）`)

// ---------- 5. 重进历史 fixture（可选） ----------
if (args.historyOut) {
  const d = describeKey(finalKey)
  const histPath =
    d?.kind === 'existing' && d.backend === 'claude'
      ? // ?limit= 覆盖默认 300 窗口（路由上限 10000）——长会话重录不得静默截断
        `/api/history/${d.slug}/${d.sessionId}?limit=10000`
      : d?.kind === 'existing' && d.backend === 'codex'
        ? `/api/codex/history/${d.sessionId}`
        : undefined
  if (!histPath) {
    console.error(`[record] 无法从 key 解析 history 路径：${finalKey}`)
    process.exit(1)
  }
  const res = await apiFetch(histPath)
  if (!res.ok) {
    console.error(`[record] GET ${histPath} 失败：${res.status}`)
    process.exit(1)
  }
  const history = (await res.json()) as { messages?: unknown[] }
  writeFixture(args.historyOut, {
    meta: { ...meta, scenario: `${args.scenario}-reentry` },
    history,
    events: [],
  })
  console.log(`[record] history 消息 ${history.messages?.length ?? '?'} 条（${histPath}）`)
}

process.exit(idleAfterResult ? 0 : 1)
