// e2e 脚本共享小工具：结果记录（note）与 WS 连接封装（connect）。
// 各 e2e-*.ts 脚本是独立运行的手工验证入口，只共享这两段逐字重复的样板。

/** 结果汇总：note() 记录并打印一行，results 供超时/结尾汇总 */
export function makeNote(): { note: (ok: boolean, label: string, detail?: string) => void; results: string[] } {
  const results: string[] = []
  const note = (ok: boolean, label: string, detail = '') => {
    results.push(`${ok ? '✓' : '✗'} ${label}${detail ? ` — ${detail}` : ''}`)
    console.log(results[results.length - 1])
  }
  return { note, results }
}

/** 打印汇总并按是否有 ✗ 退出 */
export function exitWithSummary(results: string[]): never {
  console.log('\n—— 汇总 ——')
  console.log(results.join('\n'))
  process.exit(results.some((r) => r.startsWith('✗')) ? 1 : 0)
}

/** WS 连接封装：handlers 数组 + send + open Promise */
export function connect(key: string) {
  const ws = new WebSocket(`ws://localhost:7480/ws/sessions/${encodeURIComponent(key)}`)
  const handlers: Array<(ev: Record<string, unknown>) => void> = []
  ws.onmessage = (e) => {
    const ev = JSON.parse(e.data)
    for (const h of handlers) h(ev)
  }
  return {
    ws,
    on: (h: (ev: Record<string, unknown>) => void) => handlers.push(h),
    send: (o: unknown) => ws.send(JSON.stringify(o)),
    open: () => new Promise<void>((r) => { ws.onopen = () => r() }),
  }
}
