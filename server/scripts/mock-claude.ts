// mock claude CLI：headless stream-json 协议的最小模拟，仅供 e2e-mock.ts 经
// anyplane.config.json 的 claudePath 注入（真实 CLI 不参与，CI 可跑）。
//
// 协议面（与服务端 processManager 的消费面逐条对应）：
// - stdin NDJSON：control_request(initialize) → 应答 commands；user 消息 → 触发 turn；
//   control_response（审批裁决回执）→ 放行挂起的 can_use_tool
// - stdout NDJSON：每 turn 首条 system/init（含 session_id）→ session_state_changed
//   running → assistant → session_state_changed idle → result
//
// 触发词（user 文本）：
// - "MOCK_APPROVAL" → running 后先出 can_use_tool 控制请求，等 control_response 再收尾
// - "/clear" → conversation_reset + 新 sessionId 的 init（驱动服务端三层重键 + moved）
//
// 纪律：调试输出一律走 stderr——stdout 是 NDJSON 协议面，任何杂行都会被服务端记为
// 「非 JSON 行」并透传给客户端抄本。

let sessionId = 'mock-sess-1'
let turnCount = 0
/** 挂起的审批：等 control_response 匹配 request_id 后 resume */
let pendingApproval: { requestId: string; resume: () => void } | undefined

function out(msg: Record<string, unknown>): void {
  process.stdout.write(JSON.stringify(msg) + '\n')
}

function stateChanged(state: 'idle' | 'running' | 'requires_action'): void {
  out({ type: 'system', subtype: 'session_state_changed', state, session_id: sessionId })
}

function init(): void {
  out({
    type: 'system',
    subtype: 'init',
    session_id: sessionId,
    model: 'mock-model',
    tools: [],
    mcp_servers: [],
    cwd: process.cwd(),
  })
}

function assistant(text: string): void {
  out({
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text }] },
    session_id: sessionId,
  })
}

function resultOk(): void {
  out({ type: 'result', subtype: 'success', is_error: false, session_id: sessionId, num_turns: 1, total_cost_usd: 0 })
}

function finishTurn(reply: string): void {
  assistant(reply)
  stateChanged('idle')
  resultOk()
}

/** 从 user 输入消息提取纯文本（content 为 string 或 content blocks） */
function textOf(msg: Record<string, unknown>): string {
  const content = (msg.message as { content?: unknown } | undefined)?.content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .filter((b): b is { type: string; text?: string } => typeof b === 'object' && b !== null)
      .map((b) => (b.type === 'text' ? (b.text ?? '') : ''))
      .join('\n')
  }
  return ''
}

function runUserTurn(text: string): void {
  turnCount++
  if (text.trim() === '/clear') {
    // /clear：CLI 换 sessionId 续跑——conversation_reset 后以新 session_id 发 init
    out({ type: 'conversation_reset' })
    sessionId = `mock-sess-${turnCount + 1}`
    init()
    stateChanged('running')
    finishTurn('mock：已清空上下文')
    return
  }
  init()
  stateChanged('running')
  if (text.includes('MOCK_APPROVAL')) {
    const requestId = `mock-req-${turnCount}`
    // 审批等待期间权威状态是 requires_action（与真实 CLI 一致）
    stateChanged('requires_action')
    out({
      type: 'control_request',
      request_id: requestId,
      request: { subtype: 'can_use_tool', tool_name: 'Bash', tool_use_id: `tu-${turnCount}`, input: { command: 'ls' } },
    })
    pendingApproval = {
      requestId,
      resume: () => {
        stateChanged('running')
        finishTurn('mock：审批已裁决，继续执行')
      },
    }
    return
  }
  finishTurn(`mock 应答：${text}`)
}

function handleLine(line: string): void {
  let msg: Record<string, unknown>
  try {
    msg = JSON.parse(line) as Record<string, unknown>
  } catch {
    console.error(`[mock-claude] 非 JSON 行: ${line.slice(0, 120)}`)
    return
  }
  if (msg.type === 'control_request') {
    const req = msg.request as { subtype?: string } | undefined
    if (req?.subtype === 'initialize') {
      out({
        type: 'control_response',
        response: {
          subtype: 'success',
          request_id: msg.request_id,
          response: {
            commands: [
              { name: 'clear', description: '清空对话' },
              { name: 'goal', description: '设定目标' },
            ],
          },
        },
      })
    }
    return
  }
  if (msg.type === 'control_response') {
    const resp = msg.response as { request_id?: string } | undefined
    if (pendingApproval && resp?.request_id === pendingApproval.requestId) {
      const resume = pendingApproval.resume
      pendingApproval = undefined
      resume()
    }
    return
  }
  if (msg.type === 'user') {
    runUserTurn(textOf(msg))
    return
  }
  // update_environment_variables 等其余写入忽略（mock 无环境面）
}

const decoder = new TextDecoder()
let buf = ''
for await (const chunk of Bun.stdin.stream()) {
  buf += decoder.decode(chunk, { stream: true })
  let idx = buf.indexOf('\n')
  while (idx >= 0) {
    const line = buf.slice(0, idx).trim()
    buf = buf.slice(idx + 1)
    if (line) handleLine(line)
    idx = buf.indexOf('\n')
  }
}
