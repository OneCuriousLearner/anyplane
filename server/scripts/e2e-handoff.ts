// E2E-接力：复刻 handoff-lab 实验的产品路径（API → fork 简报 → 播种 → 血缘 → 目标启动）
// 双向：claude → codex、codex → claude。需服务端已启动（默认 :7480，CC_REMOTE_PORT 覆盖）。
// 用法：bun run server/scripts/e2e-handoff.ts [claudeSessionKey] [codexThreadKey]

const PORT = process.env.CC_REMOTE_PORT ?? '7480'
const BASE = `http://localhost:${PORT}`
const tokenQ = process.env.CC_REMOTE_TOKEN ? `?token=${process.env.CC_REMOTE_TOKEN}` : ''

const CLAUDE_KEY = process.argv[2] ?? 's|-data-workspace-handoff-lab|c347a3fa-6b3f-4672-ad12-11d801e3c73a'
const CODEX_KEY = process.argv[3] ?? 'x|01a00fae-9231-79e1-8827-ad1000a03031'

interface HandoffOutcome {
  targetKey?: string
  targetSessionId?: string
  brief?: string
  error?: string
}

/** 连源会话 WS（触发 hub 存在），发 POST /api/handoff，等待 handoff_done/error */
function handoff(fromKey: string, toBackend: 'claude' | 'codex', label: string): Promise<HandoffOutcome> {
  return new Promise(async (resolve) => {
    const ws = new WebSocket(`ws://localhost:${PORT}/ws/sessions/${encodeURIComponent(fromKey)}${tokenQ}`)
    const timeout = setTimeout(() => resolve({ error: 'TIMEOUT 等待 handoff_done' }), 420_000)
    ws.onopen = async () => {
      ws.send(JSON.stringify({ kind: 'attach' }))
      const r = await fetch(`${BASE}/api/handoff`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ fromKey, toBackend, detail: 'standard' }),
      })
      const body = (await r.json().catch(() => ({}))) as { error?: string }
      if (!r.ok) {
        clearTimeout(timeout)
        resolve({ error: `POST /api/handoff ${r.status}: ${body.error ?? ''}` })
      } else {
        console.log(`[${label}] 接力已发起，等待简报与播种…`)
      }
    }
    ws.onmessage = (e) => {
      const ev = JSON.parse(String(e.data))
      if (ev.kind === 'handoff_pending') console.log(`[${label}] 简报生成中…`)
      if (ev.kind === 'handoff_done') {
        console.log(`[${label}] handoff_done target=${ev.targetKey.slice(0, 60)} sid=${String(ev.targetSessionId ?? '').slice(0, 8)}`)
        clearTimeout(timeout)
        ws.close()
        resolve({ targetKey: ev.targetKey as string, targetSessionId: ev.targetSessionId as string | undefined, brief: ev.brief as string })
      }
      if (ev.kind === 'handoff_error') {
        clearTimeout(timeout)
        ws.close()
        resolve({ error: ev.message as string })
      }
    }
  })
}

/** 等目标会话首轮工作收尾（轮询其历史出现 assistant 消息），并抽样验证简报质量 */
async function waitTargetFirstTurn(targetKey: string, targetSessionId: string | undefined, label: string): Promise<boolean> {
  const isCodex = targetKey.startsWith('x')
  if (!isCodex) {
    console.log(`[${label}] claude 目标仅验证 handoff_done 与血缘（行为已在 handoff-lab 实验验证）`)
    return true
  }
  if (!targetSessionId) {
    console.log(`[${label}] FAIL: handoff_done 未携带 codex threadId`)
    return false
  }
  const deadline = Date.now() + 300_000
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${BASE}/api/codex/history/${targetSessionId}`)
      const data = (await r.json()) as { messages?: Array<{ role: string; blocks: Array<{ kind: string; text?: string }> }> }
      const assistant = (data.messages ?? []).filter((m) => m.role === 'assistant')
      const text = assistant.flatMap((m) => m.blocks.map((b) => b.text ?? '')).join('\n')
      if (text.length > 200) {
        const sceneConfirmed = /git|commit|notebox|简报|确认|现场|45c7c29|f0b5913|233594b|5cc5c7e/i.test(text)
        console.log(`[${label}] 目标首轮产出 ${text.length} 字，现场确认=${sceneConfirmed}`)
        return sceneConfirmed
      }
    } catch {}
    await Bun.sleep(5000)
  }
  console.log(`[${label}] 目标首轮等待超时`)
  return false
}

let pass = true

/** 简报质量探针：实验项目的关键词应出现在简报里（两个方向共用） */
const PROJECT_KEYWORDS = /notebox|搜索|export|简报/i

// 方向 1：claude → codex
{
  const r = await handoff(CLAUDE_KEY, 'codex', 'cc→cx')
  if (r.error) {
    console.log(`[cc→cx] FAIL: ${r.error}`)
    pass = false
  } else {
    const hasKeywords = PROJECT_KEYWORDS.test(r.brief!)
    console.log(`[cc→cx] 简报 ${r.brief!.length} 字，含项目关键词=${hasKeywords}`)
    if (!hasKeywords) pass = false
    if (!(await waitTargetFirstTurn(r.targetKey!, r.targetSessionId, 'cc→cx'))) pass = false
  }
}

// 方向 2：codex → claude
{
  const r = await handoff(CODEX_KEY, 'claude', 'cx→cc')
  if (r.error) {
    console.log(`[cx→cc] FAIL: ${r.error}`)
    pass = false
  } else {
    const hasKeywords = PROJECT_KEYWORDS.test(r.brief!)
    console.log(`[cx→cc] 简报 ${r.brief!.length} 字，含项目关键词=${hasKeywords}`)
    if (!hasKeywords) pass = false
  }
}

// 血缘验证
{
  const r = await fetch(`${BASE}/api/lineage?key=${encodeURIComponent(CLAUDE_KEY)}`)
  const { records } = (await r.json()) as { records: Array<{ fromKey: string; toKey: string }> }
  console.log(`血缘记录（claude 源）: ${records.length} 条`)
  if (records.length === 0) pass = false
}

console.log(pass ? 'HANDOFF E2E PASS' : 'HANDOFF E2E FAIL')
process.exit(pass ? 0 : 1)
