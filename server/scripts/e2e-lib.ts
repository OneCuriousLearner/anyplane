// e2e 脚本共享小工具：结果记录（note）、WS 连接封装（connect）、app-server 探针（spawnAppServer）。
// 各 e2e-*.ts 脚本是独立运行的手工验证入口，共享此处的样板以免逐字复制漂移。

import { pumpLines } from '../src/util'

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

/** REST 封装：ANYPLANE_TOKEN 走 Authorization 头（服务端配置 authToken 时裸 fetch 一律 401——
 *  connect() 的 WS 侧早已带 token，REST 侧曾各自拼 ?token= 或漏带；token 放 header 而非
 *  query，避免进服务端访问日志）。端口随 ANYPLANE_PORT（默认 7480）。 */
export function apiFetch(path: string, init?: RequestInit): Promise<Response> {
  const port = process.env.ANYPLANE_PORT ?? '7480'
  const token = process.env.ANYPLANE_TOKEN
  return fetch(`http://localhost:${port}${path}`, {
    ...init,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...init?.headers },
  })
}

/** WS 连接封装：handlers 数组 + send + open Promise。
 *  服务端配置 authToken 时需要 ANYPLANE_TOKEN 环境变量（否则握手 401）。
 *  端口随 ANYPLANE_PORT（默认 7480），与 e2e-handoff 的 REST BASE 口径一致。 */
export function connect(key: string) {
  const tokenQ = process.env.ANYPLANE_TOKEN ? `?token=${process.env.ANYPLANE_TOKEN}` : ''
  const port = process.env.ANYPLANE_PORT ?? '7480'
  const ws = new WebSocket(`ws://localhost:${port}/ws/sessions/${encodeURIComponent(key)}${tokenQ}`)
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

/** codex app-server stdio JSON-RPC 探针封装（e2e-codex / e2e-codex-delta 共用）：
 *  spawn + NDJSON 行泵 + request 应答路由 + 通知分发。
 *  服务端主动请求（审批等）统一 decline 并以 `serverRequest:<method>` 事件透出——
 *  探针不应答审批，拒绝避免悬挂（探针线程一律 approvalPolicy:'never'，正常不会触发）。 */
export function spawnAppServer(): {
  request: (method: string, params?: unknown) => Promise<unknown>
  notify: (method: string, params?: unknown) => void
  onEvent: (h: (msg: { method?: string; id?: number | string; params?: Record<string, unknown> }) => void) => void
  stderrText: Promise<string>
  kill: () => void
} {
  const proc = Bun.spawn(['codex', 'app-server', '--stdio'], {
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  })
  let reqId = 0
  const pending = new Map<number, { resolve: (r: unknown) => void; reject: (e: Error) => void }>()
  const handlers: Array<(msg: { method?: string; id?: number | string; params?: Record<string, unknown> }) => void> = []
  const send = (msg: Record<string, unknown>) => proc.stdin.write(JSON.stringify(msg) + '\n')

  void pumpLines(proc.stdout as ReadableStream<Uint8Array>, (line) => {
    let msg: {
      id?: number | string
      method?: string
      params?: Record<string, unknown>
      result?: unknown
      error?: { code: number; message: string }
    }
    try {
      msg = JSON.parse(line)
    } catch {
      return // 非 JSON 行（启动横幅等）
    }
    if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
      const p = pending.get(Number(msg.id))
      if (p) {
        pending.delete(Number(msg.id))
        if (msg.error) p.reject(new Error(`${msg.error.code}: ${msg.error.message}`))
        else p.resolve(msg.result)
      }
      return
    }
    if (msg.id !== undefined) {
      send({ id: msg.id, result: { decision: 'decline' } })
      for (const h of handlers) h({ method: `serverRequest:${msg.method}`, id: msg.id, params: msg.params })
      return
    }
    for (const h of handlers) h(msg)
  })

  return {
    request: (method, params) =>
      new Promise((resolve, reject) => {
        const id = ++reqId
        pending.set(id, { resolve, reject })
        send({ id, method, params })
      }),
    notify: (method, params) => send({ method, params }),
    onEvent: (h) => handlers.push(h),
    stderrText: new Response(proc.stderr as ReadableStream<Uint8Array>).text(),
    kill: () => proc.kill(),
  }
}
