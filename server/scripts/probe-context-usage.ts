// probe-context-usage.ts — 探针：验证 claude CLI 的 get_context_usage 控制请求可用性与返回形状。
// 用法: bun run server/scripts/probe-context-usage.ts [模型档位或模型名]
// 目的：确认能否用官方权威值替代 AnyPlane 自建的窗口启发式（contextWindowOf）与 session-models 侧车。
// 实测反例（Kimi 网关配置）：k3-256k 启发式算 200k 实为 256k；k3[1M] 启发式算 1M，
// 但 CLAUDE_CODE_MAX_CONTEXT_TOKENS=256000 把它压到 256k——模型名两个方向都推不出窗口。
import { spawn } from 'node:child_process'

const CLAUDE = process.env.CLAUDE_BIN ?? 'claude'
const model = process.argv[2]

const child = spawn(
  CLAUDE,
  [
    '--print',
    '--verbose',
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    '--permission-prompt-tool', 'stdio',
    ...(model ? ['--model', model] : []),
  ],
  { cwd: process.cwd(), stdio: ['pipe', 'pipe', 'pipe'], shell: process.platform === 'win32' },
)

let buf = ''
let initSeen = false
const send = (m: unknown) => child.stdin!.write(JSON.stringify(m) + '\n')

const timer = setTimeout(() => {
  console.log('[probe] TIMEOUT — 未在 90s 内拿到 control_response')
  child.kill()
  process.exit(1)
}, 90_000)

child.stdout!.on('data', (d) => {
  buf += d.toString()
  let idx: number
  while ((idx = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, idx).trim()
    buf = buf.slice(idx + 1)
    if (!line) continue
    let msg: Record<string, any>
    try {
      msg = JSON.parse(line)
    } catch {
      continue
    }

    if (msg.type === 'system' && msg.subtype === 'init') {
      initSeen = true
      console.log(`[probe] init: model=${msg.model} session=${msg.session_id} version=${msg.claude_code_version}`)
      // init 之后才有真实上下文，此时发控制请求
      send({ type: 'control_request', request_id: 'probe-ctx-1', request: { subtype: 'get_context_usage' } })
    }

    if (msg.type === 'control_response') {
      clearTimeout(timer)
      const r = msg.response
      if (r?.subtype === 'error') {
        console.log(`[probe] ✗ get_context_usage 被拒绝: ${r.error}`)
        child.kill()
        process.exit(2)
      }
      const p = r?.response ?? {}
      console.log('[probe] ✓ get_context_usage 成功，关键字段：')
      console.log(JSON.stringify({
        model: p.model,
        totalTokens: p.totalTokens,
        maxTokens: p.maxTokens,
        rawMaxTokens: p.rawMaxTokens,
        percentage: p.percentage,
        autoCompactThreshold: p.autoCompactThreshold,
        isAutoCompactEnabled: p.isAutoCompactEnabled,
        categoryNames: Array.isArray(p.categories) ? p.categories.map((c: any) => c.name ?? c.categoryName) : undefined,
        hasGridRows: Array.isArray(p.gridRows),
        apiUsage: p.apiUsage,
      }, null, 2))
      console.log('[probe] 顶层字段全集:', Object.keys(p).join(', '))
      child.kill()
      process.exit(0)
    }
  }
})

child.stderr!.on('data', (d) => process.stderr.write(`[claude stderr] ${d}`))
child.on('exit', (code) => {
  clearTimeout(timer)
  if (!initSeen) console.log(`[probe] CLI 退出 code=${code}，未见 init`)
  process.exit(code ?? 0)
})

// init 是每个 query turn 的首条流消息，不是 spawn 时发出 —— 必须先发一条 user 消息触发
send({
  type: 'user',
  message: { role: 'user', content: [{ type: 'text', text: '只回复 ok' }] },
  parent_tool_use_id: null,
})
