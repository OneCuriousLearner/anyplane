// JSON-RPC 2.0 over stdio（NDJSON）客户端：codex app-server 传输层。
// 与 claude 后端的 pumpStdout 同构：逐行解析、宽松透传、未知字段不校验。

import { spawn, type Subprocess } from 'bun'
import { pumpLines } from '../../util'

export interface RpcNotification {
  method: string
  params?: unknown
}

export interface RpcServerRequest {
  id: number | string
  method: string
  params?: unknown
}

export class RpcError extends Error {
  constructor(
    public code: number,
    message: string,
  ) {
    super(`${code}: ${message}`)
    this.name = 'RpcError'
  }
}

/** app-server 背压：请求入口饱和时以 -32001 拒绝，客户端应指数退避重试 */
const OVERLOADED_CODE = -32001

interface PendingEntry {
  resolve: (r: unknown) => void
  reject: (e: Error) => void
  method: string
  retries: number
  params: unknown
  timer?: Timer
}

export class RpcClient {
  private nextId = 0
  private pending = new Map<number, PendingEntry>()
  private dead = false

  onNotification?: (n: RpcNotification) => void
  onServerRequest?: (r: RpcServerRequest) => void
  onExit?: (code: number) => void

  private constructor(private proc: Subprocess) {
    void this.pumpStdout()
    void this.pumpStderr()
    void proc.exited.then((code) => {
      this.dead = true
      const err = new Error(`codex app-server 已退出 (code=${code})`)
      for (const p of this.pending.values()) {
        if (p.timer) clearTimeout(p.timer)
        p.reject(err)
      }
      this.pending.clear()
      this.onExit?.(code)
    })
  }

  static spawn(argv: string[], opts: { cwd?: string; env?: Record<string, string | undefined> } = {}): RpcClient {
    const proc = spawn(argv, {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env } as Record<string, string>,
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
    })
    return new RpcClient(proc)
  }

  get exited(): boolean {
    return this.dead
  }

  private write(msg: unknown): void {
    if (this.dead) throw new Error('codex app-server 未运行')
    const stdin = this.proc.stdin
    if (typeof stdin === 'number' || !stdin) throw new Error('stdin 不可用')
    stdin.write(JSON.stringify(msg) + '\n')
  }

  /** 发送通知（无 id，无应答） */
  notify(method: string, params?: unknown): void {
    this.write({ method, params })
  }

  /** 回应 server 发起的 request（审批等） */
  respond(id: number | string, result: unknown): void {
    this.write({ id, result })
  }

  /** 发送请求并等待应答；-32001 过载时指数退避重试 */
  request(method: string, params?: unknown, opts: { timeoutMs?: number; maxRetries?: number } = {}): Promise<unknown> {
    const id = ++this.nextId
    const timeoutMs = opts.timeoutMs ?? 30_000
    const maxRetries = opts.maxRetries ?? 4
    return new Promise((resolve, reject) => {
      const entry: PendingEntry = { resolve, reject, method, retries: 0, params }
      const arm = () => {
        entry.timer = setTimeout(() => {
          this.pending.delete(id)
          reject(new Error(`codex 请求 ${method} 超时`))
        }, timeoutMs)
      }
      entry.resolve = (r) => {
        if (entry.timer) clearTimeout(entry.timer)
        resolve(r)
      }
      entry.reject = (e) => {
        if (entry.timer) clearTimeout(entry.timer)
        if (e instanceof RpcError && e.code === OVERLOADED_CODE && entry.retries < maxRetries) {
          entry.retries++
          const delay = Math.min(200 * 2 ** entry.retries + Math.random() * 100, 3000)
          setTimeout(() => {
            // 进程已死时必须 reject：entry 此刻不在 pending 里，exited 的清理扫不到它
            if (this.dead) {
              reject(new Error('codex app-server 已退出'))
              return
            }
            try {
              this.write({ id, method, params: entry.params })
            } catch (err) {
              reject(err instanceof Error ? err : new Error(String(err)))
              return
            }
            // 重试发送成功后必须重新注册 + 重新武装超时——handleLine 的应答路径按 id
            // 查 pending（首次应答时已 delete），缺席会把重试应答静默丢弃、Promise 永久悬挂
            this.pending.set(id, entry)
            arm()
          }, delay)
          return
        }
        reject(e)
      }
      this.pending.set(id, entry)
      try {
        this.write({ id, method, params })
      } catch (e) {
        this.pending.delete(id)
        reject(e instanceof Error ? e : new Error(String(e)))
        return
      }
      arm()
    })
  }

  kill(): void {
    try {
      this.proc.kill()
    } catch {}
  }

  private async pumpStdout(): Promise<void> {
    await pumpLines(
      this.proc.stdout as ReadableStream<Uint8Array>,
      (line) => this.handleLine(line),
      (e) => console.error('[codex-rpc] stdout 读取异常:', e),
    )
  }

  private async pumpStderr(): Promise<void> {
    const text = await new Response(this.proc.stderr as ReadableStream<Uint8Array>).text()
    if (text.trim()) console.error('[codex-rpc] stderr:', text.slice(0, 2000))
  }

  private handleLine(line: string): void {
    let msg: { id?: number | string; method?: string; params?: unknown; result?: unknown; error?: { code: number; message: string } }
    try {
      msg = JSON.parse(line)
    } catch {
      console.error('[codex-rpc] 非 JSON 行:', line.slice(0, 200))
      return
    }
    // 应答：有 id 且带 result/error，且无 method
    if (msg.id !== undefined && msg.method === undefined) {
      const p = this.pending.get(Number(msg.id))
      if (p) {
        this.pending.delete(Number(msg.id))
        if (msg.error) p.reject(new RpcError(msg.error.code, msg.error.message))
        else p.resolve(msg.result)
      }
      return
    }
    // server 发起的 request（审批/elicitation 等）：有 id 且有 method
    if (msg.id !== undefined && msg.method) {
      this.onServerRequest?.({ id: msg.id, method: msg.method, params: msg.params })
      return
    }
    // notification
    if (msg.method) {
      this.onNotification?.({ method: msg.method, params: msg.params })
    }
  }
}
