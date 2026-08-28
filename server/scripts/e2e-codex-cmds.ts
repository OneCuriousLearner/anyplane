// E2E：codex /review（review/start）与 /rename（thread/name/set）
// 用法：bun run server/scripts/e2e-codex-cmds.ts（需服务端已启动）
// 注：claude /clear 的覆盖在 e2e-clear.ts（本文件的 claude 段曾因共享 n|/tmp key 被跨测试残留污染，已拆出重写）
const results: string[] = []
function note(ok: boolean, label: string, detail = '') {
  results.push(`${ok ? '✓' : '✗'} ${label}${detail ? ` — ${detail}` : ''}`)
  console.log(results[results.length - 1])
}

const timeout = setTimeout(() => {
  console.error('TIMEOUT\n' + results.join('\n'))
  process.exit(1)
}, 300_000)

// ---------- codex /review /rename ----------
{
  const key = `xn|${encodeURIComponent('/tmp')}`
  const ws = new WebSocket(`ws://localhost:7480/ws/sessions/${encodeURIComponent(key)}`)
  let threadId = ''
  let turnDone = false
  let errors: string[] = []
  ws.onmessage = (e) => {
    const ev = JSON.parse(e.data)
    if (ev.kind === 'status' && (ev.state as { sessionId?: string }).sessionId) {
      threadId = (ev.state as { sessionId: string }).sessionId
    }
    if (ev.kind === 'cli' && (ev.msg as { type?: string }).type === 'result') turnDone = true
    if (ev.kind === 'error') errors.push(String(ev.message))
  }
  await new Promise<void>((r) => (ws.onopen = () => r()))
  ws.send(JSON.stringify({ kind: 'attach' }))
  await Bun.sleep(400)
  ws.send(JSON.stringify({ kind: 'user', text: '只回复「就绪」两个字。' }))
  for (let i = 0; i < 120 && !turnDone; i++) await Bun.sleep(1000)
  note(turnDone && !!threadId, 'codex 线程就绪', threadId.slice(0, 8))

  // rename
  ws.send(JSON.stringify({ kind: 'control', subtype: 'rename', extra: { name: 'e2e-命令测试线程' } }))
  await Bun.sleep(2000)
  note(!errors.some((e) => e.includes('重命名')), 'codex /rename（thread/name/set）无报错')

  // review（custom 目标：/tmp 不是 git 仓库，uncommittedChanges 会报错）
  errors = []
  turnDone = false
  ws.send(JSON.stringify({ kind: 'control', subtype: 'review', extra: { instructions: '检查 /tmp/ccr-push-test.txt 是否存在并评价这个测试文件的用途（一句话）' } }))
  for (let i = 0; i < 150 && !turnDone; i++) await Bun.sleep(1000)
  note(turnDone && !errors.some((e) => e.includes('审查')), 'codex /review（review/start custom inline）完成一轮', errors[0]?.slice(0, 60) ?? '')
  ws.close()
}

clearTimeout(timeout)
console.log('\n—— 汇总 ——')
console.log(results.join('\n'))
process.exit(results.some((r) => r.startsWith('✗')) ? 1 : 0)
