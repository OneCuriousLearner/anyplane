// lab-run.ts — spawn 真实 claude CLI，把 stdout NDJSON 逐行落盘 + stderr 单独落盘。
// 用法: bun run lab-run.ts <scenario名>   (从 D:/Coder/Agents/cc-remote/.tmp/lab 目录运行)
// scenario 定义在下方 SCENARIOS。
import { spawn } from 'node:child_process'
import { createWriteStream, mkdirSync } from 'node:fs'
import path from 'node:path'

const CLAUDE = process.env.CLAUDE_BIN ?? 'claude'
const OUT_DIR = path.resolve(process.cwd(), 'raw')
mkdirSync(OUT_DIR, { recursive: true })

type Step =
  | { wait_ms: number }
  | { send: Record<string, unknown> }
  | { wait_for: (msg: any) => boolean; timeout_ms?: number; then?: Record<string, unknown>[] }

const scenario = process.argv[2]
if (!scenario) {
  console.error('usage: bun run lab-run.ts <scenario>')
  process.exit(1)
}

let reqSeq = 0
const rid = () => `lab-${++reqSeq}`
const userMsg = (text: string) => ({
  type: 'user',
  message: { role: 'user', content: [{ type: 'text', text }] },
  parent_tool_use_id: null,
})
const ctrl = (subtype: string, extra: Record<string, unknown> = {}) => ({
  type: 'control_request',
  request_id: rid(),
  request: { subtype, ...extra },
})

const isResult = (m: any) => m.type === 'result'
const isInit = (m: any) => m.type === 'system' && m.subtype === 'init'

const SCENARIOS: Record<string, Step[]> = {
  // 1. 基线：简单问答，观察 init/stream_event/assistant/user/result 全套
  basic: [
    { send: userMsg('只回复一句话：北京是哪个国家的首都？') },
    { wait_for: isResult, timeout_ms: 120000 },
  ],
  // 2. thinking：先 set_max_thinking_tokens，再问需要推理的问题
  thinking: [
    { send: ctrl('set_max_thinking_tokens', { max_thinking_tokens: 4000 }) },
    { wait_ms: 500 },
    {
      send: userMsg(
        '请仔细推理：三个开关在楼下，对应楼上三盏灯。你只能上楼一次，如何确定每个开关对应哪盏灯？简要说明推理过程。',
      ),
    },
    { wait_for: isResult, timeout_ms: 180000 },
  ],
  // 3. 工具使用：让它读文件 + 跑 bash，观察 tool_use/tool_result 结构
  tools: [
    {
      send: userMsg(
        '请先用 Bash 工具运行 `echo hello-lab`，然后用 Glob 工具在当前目录找 *.txt 文件，最后简要报告结果。',
      ),
    },
    { wait_for: isResult, timeout_ms: 180000 },
  ],
  // 4. 斜杠命令 / 本地命令输出标签
  slash: [
    { send: userMsg('/context') },
    { wait_for: (m) => isResult(m) || (m.type === 'user' && typeof m.message?.content === 'string' && m.message.content.includes('local-command')), timeout_ms: 60000 },
    { wait_ms: 3000 },
  ],
  // 5. interrupt：发一个长任务，中途 interrupt
  interrupt: [
    { send: userMsg('从 1 数到 200，每个数字一行，不要省略。') },
    { wait_ms: 4000 },
    { send: ctrl('interrupt') },
    { wait_for: isResult, timeout_ms: 60000 },
  ],
  // 6. 工具报错：运行必然失败的命令，观察 is_error tool_result
  errtool: [
    { send: userMsg('请用 Bash 工具运行命令：ls /definitely-not-exist-xyz ，然后把报错原样告诉我。') },
    { wait_for: isResult, timeout_ms: 180000 },
  ],
  // 7. Task 子代理：观察 parent_tool_use_id 非空的 sidechain 消息
  task: [
    { send: userMsg('请用 Task 工具（subagent_type 用 general-purpose 或 Explore）让一个子代理回答"1+1等于几"，然后把子代理的答案告诉我。') },
    { wait_for: isResult, timeout_ms: 300000 },
  ],
}

const steps = SCENARIOS[scenario]
if (!steps) {
  console.error(`unknown scenario: ${scenario}. have: ${Object.keys(SCENARIOS).join(', ')}`)
  process.exit(1)
}

const outLog = createWriteStream(path.join(OUT_DIR, `${scenario}.stdout.ndjson`))
const errLog = createWriteStream(path.join(OUT_DIR, `${scenario}.stderr.log`))
const metaLog = createWriteStream(path.join(OUT_DIR, `${scenario}.meta.log`))

const child = spawn(
  CLAUDE,
  [
    '--print',
    '--verbose',
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    '--include-partial-messages',
    '--permission-prompt-tool', 'stdio',
    '--allow-dangerously-skip-permissions',
  ],
  { cwd: process.cwd(), stdio: ['pipe', 'pipe', 'pipe'] },
)

let buf = ''
const waiters: { pred: (m: any) => boolean; resolve: () => void; timer?: NodeJS.Timeout }[] = []

child.stdout!.on('data', (d) => {
  const s = d.toString()
  outLog.write(s)
  buf += s
  let idx
  while ((idx = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, idx).trim()
    buf = buf.slice(idx + 1)
    if (!line) continue
    let msg: any
    try {
      msg = JSON.parse(line)
    } catch {
      metaLog.write(`[non-json stdout line] ${line}\n`)
      continue
    }
    // 自动应答权限询问：一律 allow
    if (msg.type === 'control_request' && msg.request?.subtype === 'can_use_tool') {
      child.stdin!.write(
        JSON.stringify({
          type: 'control_response',
          response: { subtype: 'success', request_id: msg.request_id, response: { behavior: 'allow', updatedInput: msg.request.input } },
        }) + '\n',
      )
    }
    for (const w of [...waiters]) {
      if (w.pred(msg)) {
        if (w.timer) clearTimeout(w.timer)
        waiters.splice(waiters.indexOf(w), 1)
        w.resolve()
      }
    }
  }
})
child.stderr!.on('data', (d) => errLog.write(d.toString()))
child.on('exit', (code) => {
  metaLog.write(`[exit] code=${code}\n`)
  outLog.end(); errLog.end(); metaLog.end()
  process.exit(code ?? 0)
})

function sendMsg(m: Record<string, unknown>) {
  metaLog.write(`[send] ${JSON.stringify(m)}\n`)
  child.stdin!.write(JSON.stringify(m) + '\n')
}

async function run() {
  for (const step of steps) {
    if ('wait_ms' in step) {
      await new Promise((r) => setTimeout(r, step.wait_ms))
    } else if ('send' in step) {
      sendMsg(step.send)
    } else if ('wait_for' in step) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          metaLog.write('[wait_for timeout]\n')
          resolve()
        }, step.timeout_ms ?? 60000)
        waiters.push({ pred: step.wait_for, resolve, timer })
      })
      for (const extra of step.then ?? []) sendMsg(extra)
    }
  }
  // 等 result 后稍等收尾再退出
  await new Promise((r) => setTimeout(r, 1500))
  child.stdin!.end()
  setTimeout(() => child.kill(), 3000)
}

run()
