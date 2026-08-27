// 对外 80/443 网关：本机 Vite(:5173) 与生产服务端(:7480) 仍只绑回环。
// 80/443 上做 TCP 协议分流（HTTP / TLS / SSH），HTTP 层再按域名或 Cookie 选后端。
//
// 用法：
//   bun run gateway [--insecure] [--no-replace]
//   浏览器 http://cc-remote.devcloud.woa.com/           生产（默认）
//          http://cc-remote.devcloud.woa.com/?mode=dev  开发
//          http://cc-remote.devcloud.woa.com/?mode=prod 生产（显式）
//          http://cc-remote-dev.devcloud.woa.com/       永远开发（需在 DevCloud 再挂一个域名）
//   https:// 同源分流（自签证书；平台若在边缘终结 TLS，则只会打到明文 80）

import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { detectProtocol, isOwnGatewayCmd, modeCookie, parseSsListenPids, pickMode, type Mode } from './gateway-lib'

type GatewayCfg = {
  httpPort: number
  httpsPort: number
  prodHost: string
  devHost: string
  prodTarget: string
  devTarget: string
  sshTarget: string
  muxSsh: boolean
  insecure: boolean
  replace: boolean
}

type WSProxyData = {
  dest: string
  /** 浏览器 upgrade 请求里的 Sec-WebSocket-Protocol，原样转发给后端（vite 无子协议不完成握手） */
  protocols?: string | string[]
  backend?: WebSocket
  queue: Array<string | ArrayBuffer | Uint8Array>
  /** 下行保活定时器（见 wsHandler 注释） */
  keepalive?: ReturnType<typeof setInterval>
}

const HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailers',
  'transfer-encoding',
  'upgrade',
])

function loadFileConfig(): { authToken?: string; gateway?: Record<string, unknown> } {
  const candidates = [
    join(process.cwd(), 'cc-remote.config.json'),
    join(import.meta.dir, '..', 'cc-remote.config.json'),
    join(homedir(), '.cc-remote', 'config.json'),
    join(homedir(), '.config', 'cc-remote', 'config.json'),
  ]
  for (const p of candidates) {
    if (!existsSync(p)) continue
    try {
      return JSON.parse(readFileSync(p, 'utf8')) as { authToken?: string; gateway?: Record<string, unknown> }
    } catch (e) {
      console.error(`[gateway] 解析 ${p} 失败:`, e)
    }
  }
  return {}
}

function num(v: unknown, fallback: number): number {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN
  return Number.isFinite(n) && n > 0 ? n : fallback
}

function str(v: unknown, fallback: string): string {
  return typeof v === 'string' && v.trim() ? v.trim() : fallback
}

function bool(v: unknown, fallback: boolean): boolean {
  if (typeof v === 'boolean') return v
  return fallback
}

function parseArgs(argv: string[]): { insecure: boolean; noReplace: boolean } {
  return { insecure: argv.includes('--insecure'), noReplace: argv.includes('--no-replace') }
}

function loadCfg(): GatewayCfg {
  const file = loadFileConfig()
  const g = file.gateway ?? {}
  const args = parseArgs(process.argv.slice(2))
  return {
    httpPort: num(process.env.CC_REMOTE_GATEWAY_HTTP_PORT ?? g.httpPort, 80),
    httpsPort: num(process.env.CC_REMOTE_GATEWAY_HTTPS_PORT ?? g.httpsPort, 443),
    prodHost: str(process.env.CC_REMOTE_PROD_HOST ?? g.prodHost, 'cc-remote.devcloud.woa.com'),
    devHost: str(process.env.CC_REMOTE_DEV_HOST ?? g.devHost, 'cc-remote-dev.devcloud.woa.com'),
    prodTarget: str(g.prodTarget, 'http://127.0.0.1:7480'),
    devTarget: str(g.devTarget, 'http://127.0.0.1:5173'),
    sshTarget: str(g.sshTarget, '127.0.0.1:36000'),
    muxSsh: bool(g.muxSsh, true),
    insecure: args.insecure || process.env.CC_REMOTE_GATEWAY_INSECURE === '1',
    replace: !args.noReplace,
  }
}

function htmlEscape(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c)
}

function certSan(cfg: GatewayCfg): string {
  const names = [cfg.prodHost, cfg.devHost, 'localhost']
    .map((h) => h.split(':')[0].toLowerCase())
    .filter(Boolean)
  const dns = new Set<string>()
  for (const h of names) {
    dns.add(`DNS:${h}`)
    const dot = h.indexOf('.')
    if (dot > 0) dns.add(`DNS:*.${h.slice(dot + 1)}`)
  }
  return [...dns, 'IP:127.0.0.1'].join(',')
}

async function ensureCerts(cfg: GatewayCfg): Promise<{ cert: string; key: string }> {
  const dir = join(homedir(), '.cc-remote', 'certs')
  mkdirSync(dir, { recursive: true })
  const certPath = join(dir, 'gateway.crt')
  const keyPath = join(dir, 'gateway.key')
  if (existsSync(certPath) && existsSync(keyPath)) {
    return { cert: readFileSync(certPath, 'utf8'), key: readFileSync(keyPath, 'utf8') }
  }
  const cn = cfg.prodHost.split(':')[0]
  const proc = Bun.spawn(
    [
      'openssl',
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-sha256',
      '-days',
      '825',
      '-nodes',
      '-keyout',
      keyPath,
      '-out',
      certPath,
      '-subj',
      `/CN=${cn}`,
      '-addext',
      `subjectAltName=${certSan(cfg)}`,
    ],
    { stdout: 'inherit', stderr: 'inherit' },
  )
  const code = await proc.exited
  if (code !== 0) throw new Error(`openssl 生成证书失败 code=${code}`)
  console.log(`[gateway] 已生成自签证书 ${certPath}`)
  return { cert: readFileSync(certPath, 'utf8'), key: readFileSync(keyPath, 'utf8') }
}

function targetOf(mode: Mode, cfg: GatewayCfg): string {
  return mode === 'dev' ? cfg.devTarget : cfg.prodTarget
}

function portOfTarget(url: string): number {
  return Number(new URL(url).port)
}

async function probe(target: string): Promise<boolean> {
  try {
    await fetch(new URL('/', target), { signal: AbortSignal.timeout(400), redirect: 'manual' })
    return true
  } catch {
    return false
  }
}

function htmlPage(title: string, body: string): Response {
  return new Response(
    `<!doctype html><meta charset="utf-8"><title>${htmlEscape(title)}</title>
<style>
  body{font:15px/1.5 ui-sans-serif,system-ui;max-width:40rem;margin:12vh auto;padding:0 1.5rem;color:#e7e5e4;background:#0c0a09}
  a{color:#93c5fd} code{background:#1c1917;padding:.1em .35em;border-radius:4px}
  .ok{color:#86efac} .bad{color:#fca5a5}
</style>
<h1>${htmlEscape(title)}</h1>${body}`,
    { headers: { 'content-type': 'text/html; charset=utf-8' } },
  )
}

function filterReqHeaders(req: Request, proto: string): Headers {
  const out = new Headers()
  req.headers.forEach((v, k) => {
    if (HOP.has(k.toLowerCase())) return
    out.set(k, v)
  })
  const host = req.headers.get('host')
  if (host) out.set('x-forwarded-host', host)
  out.set('x-forwarded-proto', proto)
  out.set('x-cc-remote-gateway', '1')
  return out
}

function filterResHeaders(res: Headers): Headers {
  const out = new Headers()
  res.forEach((v, k) => {
    if (HOP.has(k.toLowerCase())) return
    out.set(k, v)
  })
  return out
}

async function proxyHttp(req: Request, target: string, proto: string, mode: Mode): Promise<Response> {
  const url = new URL(req.url)
  const dest = new URL(url.pathname + url.search, target)
  const init: RequestInit = {
    method: req.method,
    headers: filterReqHeaders(req, proto),
    redirect: 'manual',
  }
  if (req.method !== 'GET' && req.method !== 'HEAD' && req.body) {
    init.body = req.body
    ;(init as RequestInit & { duplex: 'half' }).duplex = 'half'
  }
  try {
    const upstream = await fetch(dest, init)
    const headers = filterResHeaders(upstream.headers)
    headers.set('x-cc-remote-mode', mode)
    return new Response(upstream.body, { status: upstream.status, statusText: upstream.statusText, headers })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    const isDev = mode === 'dev'
    return htmlPage(
      '502 后端未就绪',
      `<p>${isDev ? '开发模式（Vite :5173）' : '生产模式（server :7480）'}连不上：<code>${htmlEscape(msg)}</code></p>
<p>请在本机运行 <code>${isDev ? 'bun run dev' : 'bun run start'}</code>，然后刷新。</p>
<p><a href="/__gateway">网关状态</a> · <a href="/?mode=dev">开发</a> · <a href="/?mode=prod">生产</a></p>`,
    )
  }
}

function makeFetch(cfg: GatewayCfg): (req: Request, srv: { upgrade: (req: Request, opts: { data: WSProxyData }) => boolean }) => Promise<Response | undefined> {
  return async (req, srv) => {
    const url = new URL(req.url)
    const proto = url.protocol === 'https:' ? 'https' : 'http'
    const host = req.headers.get('host') ?? ''
    const secure = proto === 'https'

    if (url.pathname === '/__gateway') {
      const mode = pickMode(host, req.headers.get('cookie'), cfg.devHost, url.searchParams.get('mode'))
      const [devUp, prodUp] = await Promise.all([probe(cfg.devTarget), probe(cfg.prodTarget)])
      return htmlPage(
        'cc-remote gateway',
        `<p>当前模式：<strong>${mode === 'dev' ? '开发 Vite :5173' : '生产 server :7480'}</strong></p>
<p>Vite ${devUp ? '<span class="ok">在线</span>' : '<span class="bad">离线</span>'} ·
server ${prodUp ? '<span class="ok">在线</span>' : '<span class="bad">离线</span>'}</p>
<p>切换：<a href="/?mode=dev">开发</a> · <a href="/?mode=prod">生产</a></p>
<p>第二域名（永远开发）：<code>${htmlEscape(cfg.devHost)}</code></p>
<p>生产域名：<code>${htmlEscape(cfg.prodHost)}</code></p>
<p>本机仍可直接用 <code>http://127.0.0.1:5173</code> / <code>http://127.0.0.1:7480</code>。</p>`,
      )
    }

    const queryMode = url.searchParams.get('mode')
    const mode = pickMode(host, req.headers.get('cookie'), cfg.devHost, queryMode)
    const target = targetOf(mode, cfg)

    if (req.headers.get('upgrade')?.toLowerCase() === 'websocket') {
      const dest = `${target.replace(/^http/, 'ws')}${url.pathname}${url.search}`
      // 子协议必须随 data 带进 open()：Vite 6 的 HMR 只认 vite-hmr / vite-ping 子协议，
      // 缺了它后端握手永远挂起，Bun WS 客户端 120s 超时断连 → 前端整页刷新（本 bug 根因）。
      const protocols = req.headers.get('sec-websocket-protocol') ?? undefined
      if (srv.upgrade(req, { data: { dest, protocols, queue: [] } })) return undefined
      return new Response('WebSocket upgrade failed', { status: 400 })
    }

    const res = await proxyHttp(req, target, proto, mode)
    const sticky = queryMode === 'dev' || queryMode === 'prod' ? queryMode : undefined
    if (sticky) {
      const headers = new Headers(res.headers)
      headers.append('Set-Cookie', modeCookie(sticky, secure))
      return new Response(res.body, { status: res.status, statusText: res.statusText, headers })
    }
    return res
  }
}

const wsHandler: import('bun').WebSocketHandler<WSProxyData> = {
  // 30s 协议层下行 ping：对应用透明的死连接探测，并在链路上持续制造下行流量，
  // 压住按"下行静默"掐连接的中间代理（nginx proxy_read_timeout 类）。
  open(ws) {
    ws.data.keepalive = setInterval(() => {
      try {
        ws.ping()
      } catch {}
    }, 30_000)
    const backend = new WebSocket(ws.data.dest, ws.data.protocols)
    ws.data.backend = backend
    backend.binaryType = 'arraybuffer'
    backend.addEventListener('open', () => {
      for (const m of ws.data.queue) backend.send(m)
      ws.data.queue = []
    })
    backend.addEventListener('message', (ev) => {
      try {
        ws.send(ev.data as string | ArrayBuffer)
      } catch {}
    })
    backend.addEventListener('close', (ev) => {
      try {
        ws.close(ev.code, ev.reason)
      } catch {}
    })
    backend.addEventListener('error', () => {
      try {
        ws.close()
      } catch {}
    })
  },
  message(ws, raw) {
    const payload = typeof raw === 'string' ? raw : raw
    const b = ws.data.backend
    if (!b || b.readyState !== WebSocket.OPEN) {
      ws.data.queue.push(payload)
      return
    }
    b.send(payload)
  },
  close(ws) {
    if (ws.data.keepalive) clearInterval(ws.data.keepalive)
    try {
      ws.data.backend?.close()
    } catch {}
  },
}

type PipeData = { peer?: import('bun').Socket; buf: Uint8Array; phase: 'peek' | 'connecting' | 'proxy' }

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const o = new Uint8Array(a.length + b.length)
  o.set(a)
  o.set(b, a.length)
  return o
}

function parseHostPort(s: string): { hostname: string; port: number } {
  const i = s.lastIndexOf(':')
  return { hostname: s.slice(0, i), port: Number(s.slice(i + 1)) }
}

function attachPeer(a: import('bun').Socket<PipeData>, b: import('bun').Socket<PipeData>) {
  a.data.peer = b
  b.data.peer = a
  a.data.phase = 'proxy'
  b.data.phase = 'proxy'
}

async function pipeTo(
  client: import('bun').Socket<PipeData>,
  hostname: string,
  port: number,
  first: Uint8Array,
): Promise<void> {
  try {
    const upstream = await Bun.connect<PipeData>({
      hostname,
      port,
      data: { buf: new Uint8Array(0), phase: 'proxy' },
      socket: {
        data(socket, data) {
          try {
            socket.data.peer?.write(data)
          } catch {
            socket.end()
          }
        },
        open() {},
        close(socket) {
          try {
            socket.data.peer?.end()
          } catch {}
        },
        error(socket) {
          try {
            socket.end()
            socket.data.peer?.end()
          } catch {}
        },
      },
    })
    attachPeer(client, upstream)
    if (first.length) upstream.write(first)
    if (client.data.buf.length) {
      upstream.write(client.data.buf)
      client.data.buf = new Uint8Array(0)
    }
  } catch (e) {
    console.error(`[gateway] 后端 ${hostname}:${port} 连接失败:`, e instanceof Error ? e.message : e)
    try {
      client.end()
    } catch {}
  }
}

function cmdlineOf(pid: number): string {
  try {
    return readFileSync(`/proc/${pid}/cmdline`, 'utf8')
  } catch {
    return ''
  }
}

async function listenPids(port: number): Promise<number[]> {
  const proc = Bun.spawn(['ss', '-tlnp'], { stdout: 'pipe', stderr: 'pipe' })
  const out = await new Response(proc.stdout).text()
  await proc.exited
  return parseSsListenPids(out, port)
}

/** 只结束上一份 scripts/gateway.ts；nginx/sshd 等外来进程拒绝覆盖。 */
async function replaceStaleGateway(ports: number[]): Promise<void> {
  const seen = new Set<number>()
  const own: number[] = []
  const foreign: Array<{ pid: number; cmd: string; port: number }> = []
  for (const port of ports) {
    for (const pid of await listenPids(port)) {
      if (pid === process.pid || seen.has(pid)) continue
      seen.add(pid)
      const cmd = cmdlineOf(pid)
      if (isOwnGatewayCmd(cmd)) own.push(pid)
      else foreign.push({ pid, cmd: cmd.replace(/\0/g, ' ').trim() || '(unknown)', port })
    }
  }
  if (foreign.length) {
    for (const f of foreign) {
      console.error(`[gateway] :${f.port} 被 pid=${f.pid} 占用，不是本网关：${f.cmd}`)
    }
    console.error('[gateway] 拒绝覆盖。确认后手动结束该进程，或改 gateway.httpPort。')
    process.exit(1)
  }
  for (const pid of own) {
    console.warn(`[gateway] 结束上一份网关 pid=${pid}`)
    try {
      process.kill(pid, 'SIGTERM')
    } catch {}
  }
  if (!own.length) return
  const deadline = Date.now() + 2000
  while (Date.now() < deadline) {
    let leftover = false
    for (const port of ports) {
      for (const pid of await listenPids(port)) {
        if (own.includes(pid)) leftover = true
      }
    }
    if (!leftover) return
    await Bun.sleep(50)
  }
  for (const pid of own) {
    try {
      process.kill(pid, 'SIGKILL')
      console.warn(`[gateway] pid=${pid} 未退出，已 SIGKILL`)
    } catch {}
  }
  await Bun.sleep(50)
}

function startMux(
  publicPort: number,
  cfg: GatewayCfg,
  httpPort: number,
  tlsPort: number,
): void {
  try {
    Bun.listen<PipeData>({
      hostname: '0.0.0.0',
      port: publicPort,
    socket: {
      open(socket) {
        socket.data = { buf: new Uint8Array(0), phase: 'peek' }
      },
      data(socket, data) {
        if (socket.data.phase === 'proxy') {
          try {
            socket.data.peer?.write(data)
          } catch {
            socket.end()
          }
          return
        }
        socket.data.buf = concat(socket.data.buf, new Uint8Array(data))
        if (socket.data.phase === 'connecting') return
        const kind = detectProtocol(socket.data.buf)
        if (kind === 'wait') return
        socket.data.phase = 'connecting'
        const first = socket.data.buf
        socket.data.buf = new Uint8Array(0)
        if (kind === 'ssh') {
          if (!cfg.muxSsh) {
            socket.end()
            return
          }
          const ssh = parseHostPort(cfg.sshTarget)
          void pipeTo(socket, ssh.hostname, ssh.port, first)
          return
        }
        if (kind === 'tls') {
          void pipeTo(socket, '127.0.0.1', tlsPort, first)
          return
        }
        void pipeTo(socket, '127.0.0.1', httpPort, first)
      },
      close(socket) {
        try {
          socket.data.peer?.end()
        } catch {}
      },
      error(socket) {
        try {
          socket.end()
          socket.data.peer?.end()
        } catch {}
      },
    },
  })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    console.error(`[gateway] 监听 0.0.0.0:${publicPort} 失败：${msg}`)
    if (msg.includes('EADDRINUSE') || msg.includes('Failed to listen')) {
      console.error('[gateway] 端口仍被占用。默认会替换上一份 scripts/gateway.ts；其它进程请用 --no-replace 查看后手动处理。')
    }
    process.exit(1)
  }
}

const fileCfg = loadFileConfig()
const cfg = loadCfg()
const token = process.env.CC_REMOTE_TOKEN || fileCfg.authToken

if (!token && !cfg.insecure) {
  console.error('[gateway] 拒绝启动：把 :5173/:7480 暴露到 80/443 等于把本机 CLI 会话暴露到网络。')
  console.error('[gateway] 请在 cc-remote.config.json 配置 authToken，或显式传入 --insecure / CC_REMOTE_GATEWAY_INSECURE=1。')
  process.exit(1)
}
if (!token && cfg.insecure) {
  console.warn('[gateway] 警告：--insecure，80/443 上的 cc-remote 无鉴权。仅限授信内网。')
}

const tls = await ensureCerts(cfg)
const fetchHandler = makeFetch(cfg)

const internalHttp = Bun.serve<WSProxyData>({
  hostname: '127.0.0.1',
  port: 0,
  fetch: fetchHandler,
  websocket: wsHandler,
})
const internalTls = Bun.serve<WSProxyData>({
  hostname: '127.0.0.1',
  port: 0,
  tls: { cert: tls.cert, key: tls.key },
  fetch: fetchHandler,
  websocket: wsHandler,
})

if (cfg.replace) await replaceStaleGateway([cfg.httpPort, cfg.httpsPort])

startMux(cfg.httpPort, cfg, internalHttp.port, internalTls.port)
startMux(cfg.httpsPort, cfg, internalHttp.port, internalTls.port)

console.log(`[gateway] 对外 :${cfg.httpPort} (HTTP/TLS/SSH 分流) 与 :${cfg.httpsPort} (同上)`)
console.log(`[gateway] 内部 HTTP :${internalHttp.port}  TLS :${internalTls.port}`)
console.log(`[gateway] 生产 ${cfg.prodHost} → ${cfg.prodTarget}  (默认，Cookie 可切)`)
console.log(`[gateway] 开发 ${cfg.devHost} → ${cfg.devTarget}  (域名永远开发)`)
console.log(`[gateway] 切换  http://${cfg.prodHost}/?mode=dev  或  /?mode=prod  ；状态 /__gateway`)
if (cfg.muxSsh) console.log(`[gateway] SSH 连 :${cfg.httpPort} 会转到 ${cfg.sshTarget}`)
console.log(`[gateway] 本机直连不受影响：http://127.0.0.1:${portOfTarget(cfg.devTarget)} 与 :${portOfTarget(cfg.prodTarget)}`)
