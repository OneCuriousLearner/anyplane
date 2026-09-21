// 对外 80/443 网关：本机 Vite(:5173) 与生产服务端(:7480) 仍只绑回环。
// 80/443 上做 TCP 协议分流（HTTP / TLS / SSH），HTTP 层再按域名或 Cookie 选后端。
//
// 用法：
//   bun run gateway [--insecure] [--no-replace]
//   浏览器 http://anyplane.example.com/           生产（默认）
//          http://anyplane.example.com/?mode=dev  开发
//          http://anyplane.example.com/?mode=prod 生产（显式）
//          http://anyplane-dev.example.com/       永远开发（需再挂一个域名，见 gateway.devHost）
//   https:// 同源分流（自签证书；平台若在边缘终结 TLS，则只会打到明文 80）

import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { detectProtocol, isOwnGatewayCmd, modeCookie, parseRequestUrl, pickMode, type Mode } from './gateway-lib'
import { loadAnyplaneConfigFile } from '../server/src/config'
import { describePid, listListenPids, terminatePids } from '../server/src/portTakeover'
import { ensurePrivateDir, escapeHtml as htmlEscape } from '../server/src/util'

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

type FileCfg = { authToken?: string; gateway?: Record<string, unknown> }

function num(v: unknown, fallback: number): number {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN
  return Number.isFinite(n) && n > 0 ? n : fallback
}

function str(v: unknown, fallback: string): string {
  const s = typeof v === 'string' ? v.trim() : ''
  return s || fallback
}

function bool(v: unknown, fallback: boolean): boolean {
  if (typeof v === 'boolean') return v
  return fallback
}

function parseArgs(argv: string[]): { insecure: boolean; noReplace: boolean } {
  return { insecure: argv.includes('--insecure'), noReplace: argv.includes('--no-replace') }
}

function loadCfg(file: FileCfg): GatewayCfg {
  const g = file.gateway ?? {}
  const args = parseArgs(process.argv.slice(2))
  return {
    httpPort: num(process.env.ANYPLANE_GATEWAY_HTTP_PORT ?? g.httpPort, 80),
    httpsPort: num(process.env.ANYPLANE_GATEWAY_HTTPS_PORT ?? g.httpsPort, 443),
    prodHost: str(process.env.ANYPLANE_PROD_HOST ?? g.prodHost, 'anyplane.example.com'),
    devHost: str(process.env.ANYPLANE_DEV_HOST ?? g.devHost, 'anyplane-dev.example.com'),
    prodTarget: str(g.prodTarget, 'http://127.0.0.1:7480'),
    devTarget: str(g.devTarget, 'http://127.0.0.1:5173'),
    sshTarget: str(g.sshTarget, '127.0.0.1:36000'),
    muxSsh: bool(g.muxSsh, true),
    insecure: args.insecure || process.env.ANYPLANE_GATEWAY_INSECURE === '1',
    replace: !args.noReplace,
  }
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
  // TLS 私钥落 ~/.anyplane/certs：目录收紧 700（ensurePrivateDir）
  const dir = ensurePrivateDir(join(homedir(), '.anyplane', 'certs'))
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

function htmlPage(title: string, body: string, status = 200): Response {
  return new Response(
    `<!doctype html><meta charset="utf-8"><title>${htmlEscape(title)}</title>
<style>
  body{font:15px/1.5 ui-sans-serif,system-ui;max-width:40rem;margin:12vh auto;padding:0 1.5rem;color:#e7e5e4;background:#0c0a09}
  a{color:#93c5fd} code{background:#1c1917;padding:.1em .35em;border-radius:4px}
  .ok{color:#86efac} .bad{color:#fca5a5}
</style>
<h1>${htmlEscape(title)}</h1>${body}`,
    { status, headers: { 'content-type': 'text/html; charset=utf-8' } },
  )
}

/** 拷贝 headers（剔除 hop-by-hop 头）；请求/响应转发共用 */
function copyHeaders(src: Headers): Headers {
  const out = new Headers()
  src.forEach((v, k) => {
    if (HOP.has(k.toLowerCase())) return
    out.set(k, v)
  })
  return out
}

function filterReqHeaders(req: Request, proto: string, target: string): Headers {
  const out = copyHeaders(req.headers)
  const host = req.headers.get('host')
  if (host) out.set('x-forwarded-host', host)
  out.set('x-forwarded-proto', proto)
  out.set('x-anyplane-gateway', '1')
  // 上游无 token 模式要求 Host 为回环（DNS rebinding 防线）：反代统一改写为上游 authority，
  // 并剥除浏览器 Origin（公网域名会被上游判成跨源）——网关即信任边界，剥除不削弱防线：
  // token 模式不查 Origin/Host；无 token 时网关本身需 --insecure 才起得来（已是有意的全暴露）。
  out.set('host', new URL(target).host)
  out.delete('origin')
  return out
}

async function proxyHttp(req: Request, url: URL, target: string, proto: string, mode: Mode): Promise<Response> {
  const dest = new URL(url.pathname + url.search, target)
  const init: RequestInit = {
    method: req.method,
    headers: filterReqHeaders(req, proto, target),
    redirect: 'manual',
  }
  if (req.method !== 'GET' && req.method !== 'HEAD' && req.body) {
    init.body = req.body
    ;(init as RequestInit & { duplex: 'half' }).duplex = 'half'
  }
  try {
    const upstream = await fetch(dest, init)
    const headers = copyHeaders(upstream.headers)
    headers.set('x-anyplane-mode', mode)
    return new Response(upstream.body, { status: upstream.status, statusText: upstream.statusText, headers })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    const isDev = mode === 'dev'
    // 友好提示页必须带真 502：状态码 200 会让浏览器缓存/监控/搜索引擎把
    // "后端未就绪"当成正常页面，排障方向完全反掉。
    return htmlPage(
      '502 后端未就绪',
      `<p>${isDev ? '开发模式（Vite :5173）' : '生产模式（server :7480）'}连不上：<code>${htmlEscape(msg)}</code></p>
<p>请在本机运行 <code>${isDev ? 'bun run dev' : 'bun run start'}</code>，然后刷新。</p>
<p><a href="/__gateway">网关状态</a> · <a href="/?mode=dev">开发</a> · <a href="/?mode=prod">生产</a></p>`,
      502,
    )
  }
}

function makeFetch(
  cfg: GatewayCfg,
  fallbackOrigin: string,
): (req: Request, srv: { upgrade: (req: Request, opts: { data: WSProxyData }) => boolean }) => Promise<Response | undefined> {
  return async (req, srv) => {
    try {
      const url = parseRequestUrl(req.url, req.headers.get('host'), fallbackOrigin)
      if (!url) return new Response('Bad Request', { status: 400 })
      const proto = url.protocol === 'https:' ? 'https' : 'http'
      const host = req.headers.get('host') ?? ''
      const secure = proto === 'https'

      if (url.pathname === '/__gateway') {
        const mode = pickMode(host, req.headers.get('cookie'), cfg.devHost, url.searchParams.get('mode'))
        const [devUp, prodUp] = await Promise.all([probe(cfg.devTarget), probe(cfg.prodTarget)])
        return htmlPage(
          'anyplane gateway',
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
      // 多个子协议按 RFC 以逗号分隔，必须拆成数组后传，否则会被视为一个组合协议名而握手失败。
      const rawProtocols = req.headers.get('sec-websocket-protocol')
      const protocols = rawProtocols
        ? rawProtocols
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean)
        : undefined
      if (srv.upgrade(req, { data: { dest, protocols, queue: [] } })) return undefined
      return new Response('WebSocket upgrade failed', { status: 400 })
    }

    const res = await proxyHttp(req, url, target, proto, mode)
    const sticky = queryMode === 'dev' || queryMode === 'prod' ? queryMode : undefined
    if (sticky) {
      const headers = new Headers(res.headers)
      headers.append('Set-Cookie', modeCookie(sticky, secure))
      return new Response(res.body, { status: res.status, statusText: res.statusText, headers })
    }
    return res
    } catch (e) {
      // 400 只给请求本身有问题（parseRequestUrl 返回 null，见上）；能走到这里的
      // 都是网关自身未预期的异常，按 HTTP 语义报 500。
      const msg = e instanceof Error ? e.message : String(e)
      console.error(`[gateway] 请求处理失败 ${JSON.stringify(req.url)}: ${msg}`)
      return new Response('Internal Server Error', { status: 500 })
    }
  }
}

/** 后端 WS 握手窗口内的上行帧排队上限（超出即断开，客户端重连恢复） */
const WS_QUEUE_CAP = 256

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
      // 连接失败时排队消息无任何补偿——客户端会重连，此后从权威历史/状态恢复
      ws.data.queue = []
      try {
        ws.close(ev.code, ev.reason)
      } catch {}
    })
    backend.addEventListener('error', () => {
      ws.data.queue = []
      try {
        ws.close()
      } catch {}
    })
    // 握手超时兜底：目标黑洞化时 Bun 客户端默认 120s 才放弃——排队内存无界增长前先断
    const handshakeTimer = setTimeout(() => {
      if (backend.readyState !== WebSocket.OPEN) {
        ws.data.queue = []
        try {
          ws.close(1011, 'backend handshake timeout')
          backend.close()
        } catch {}
      }
    }, 30_000)
    backend.addEventListener('open', () => clearTimeout(handshakeTimer), { once: true })
    backend.addEventListener('close', () => clearTimeout(handshakeTimer), { once: true })
  },
  message(ws, raw) {
    const b = ws.data.backend
    if (!b || b.readyState !== WebSocket.OPEN) {
      // 握手窗口内的上行帧暂存待 flush。上限防黑洞主机拖住握手期间的内存无界增长
      if (ws.data.queue.length >= WS_QUEUE_CAP) {
        console.warn(`[gateway] WS 排队超限（后端 ${ws.data.dest} 未就绪），断开连接`)
        ws.data.queue = []
        try {
          ws.close(1013, 'queue overflow')
        } catch {}
        return
      }
      ws.data.queue.push(raw)
      return
    }
    b.send(raw)
  },
  close(ws) {
    if (ws.data.keepalive) clearInterval(ws.data.keepalive)
    ws.data.queue = []
    try {
      ws.data.backend?.close()
    } catch {}
  },
}

type PipeData = { peer?: import('bun').Socket<PipeData>; buf: Uint8Array; phase: 'peek' | 'connecting' | 'proxy' }

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const o = new Uint8Array(a.length + b.length)
  o.set(a)
  o.set(b, a.length)
  return o
}

function parseHostPort(s: string): { hostname: string; port: number } {
  // IPv6 字面量带方括号（[::1]:36000）：剥括号按整段主机名解析
  if (s.startsWith('[')) {
    const close = s.indexOf(']')
    if (close > 0) {
      const portPart = s.slice(close + 1)
      if (!portPart) return { hostname: s.slice(1, close), port: 22 }
      if (!portPart.startsWith(':')) throw new Error(`sshTarget 非法: ${s}`)
      const port = Number(portPart.slice(1))
      if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new Error(`sshTarget 端口非法: ${s}`)
      return { hostname: s.slice(1, close), port }
    }
  }
  const i = s.lastIndexOf(':')
  // 无端口时默认 22（ssh 标准端口）——slice(0, -1) 会截掉主机名末字符并给出 NaN 端口
  if (i <= 0) return { hostname: s, port: 22 }
  const port = Number(s.slice(i + 1))
  // 畸形端口 fail fast：静默回退 22 会把 SSH 流量悄悄转去目标机的 sshd，
  // 连上的不是预期后端且无任何告警（配置打错的典型迷惑形态）
  if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new Error(`sshTarget 端口非法: ${s}`)
  return { hostname: s.slice(0, i), port }
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

/** 只结束上一份 scripts/gateway.ts；nginx/sshd 等外来进程拒绝覆盖。
 *  所有权校验只有 cmdline 一条（无稳定子目录 cwd 可查，与 portTakeover 的双校验分歧是有意的）；
 *  杀进程流（SIGTERM/轮询/SIGKILL 节奏）共用 portTakeover.terminatePids 一份实现。 */
async function replaceStaleGateway(ports: number[]): Promise<void> {
  const seen = new Set<number>()
  const own: number[] = []
  const foreign: Array<{ pid: number; cmd: string; port: number }> = []
  for (const port of ports) {
    const pids = await listListenPids(port)
    if (pids === null) {
      console.warn('[gateway] 当前平台不支持自动列监听进程，跳过 --replace（端口被占时启动会报错）')
      return
    }
    for (const pid of pids) {
      if (pid === process.pid || seen.has(pid)) continue
      seen.add(pid)
      const cmd = (await describePid(pid))?.cmdline ?? ''
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
  if (!own.length) return
  const cleared = await terminatePids(
    own,
    // 清场 = own pid 不再监听任何网关端口（按 pid 判，端口可能被无关新进程抢占）
    async () => {
      for (const port of ports) {
        const pids = await listListenPids(port)
        if (pids === null || pids.some((p) => own.includes(p))) return false
      }
      return true
    },
    (pid, signal) => {
      if (signal === 'SIGTERM') console.warn(`[gateway] 结束上一份网关 pid=${pid}`)
      else console.warn(`[gateway] pid=${pid} 未退出，已 SIGKILL`)
    },
  )
  if (!cleared) console.error('[gateway] SIGKILL 后端口仍被占用，启动可能失败')
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

const fileCfg = loadAnyplaneConfigFile() as FileCfg
const cfg = loadCfg(fileCfg)
const token = process.env.ANYPLANE_TOKEN || fileCfg.authToken

/** 上游鉴权生效探测：token「存在」于本进程 env/配置 ≠ 上游 server 进程在强制它
 * （配置漂移：token 后补进配置/env 时，仍在运行的旧 server 进程按启动时的无 token 配置放行一切，
 * 而本网关剥 Origin/改 Host，上游无 token 时的 Origin/Host 防线在网关之后整体失效）。
 * 探测 prodTarget 即覆盖两种模式：vite dev(:5173) 的 /api 经 proxy 同样落 7480。 */
async function probeUpstreamAuth(target: string): Promise<'enforced' | 'open' | 'unreachable'> {
  try {
    // 无凭据 GET /api/sessions：token 模式 isAuthorized 一票否决 → 401；
    // 无 token 回环模式 originAllowed 缺失放行（脚本 fetch 无 Origin）→ 200。
    const r = await fetch(`${target}/api/sessions`, { signal: AbortSignal.timeout(1500), redirect: 'manual' })
    return r.status === 401 ? 'enforced' : 'open'
  } catch {
    return 'unreachable'
  }
}

if (!token && !cfg.insecure) {
  console.error('[gateway] 拒绝启动：把 :5173/:7480 暴露到 80/443 等于把本机 CLI 会话暴露到网络。')
  console.error('[gateway] 请在 anyplane.config.json 配置 authToken，或显式传入 --insecure / ANYPLANE_GATEWAY_INSECURE=1。')
  process.exit(1)
}
if (!token && cfg.insecure) {
  console.warn('[gateway] 警告：--insecure，80/443 上的 anyplane 无鉴权。仅限授信内网。')
}
if (token && !cfg.insecure) {
  const probe = await probeUpstreamAuth(cfg.prodTarget)
  if (probe === 'open') {
    console.error(`[gateway] 拒绝启动：上游 ${cfg.prodTarget} 未在强制 authToken（无凭据 GET /api/sessions 未返回 401）。`)
    console.error('[gateway] 常见原因：token 是后补进配置/env 的，server 进程仍按旧配置运行。请重启服务端后重试，或显式 --insecure。')
    process.exit(1)
  }
  if (probe === 'unreachable') {
    // 上游后启是既有宽容语义（502 提示页）：只警告不拒绝，但鉴权未经验证这一事实必须留痕
    console.warn(`[gateway] 警告：上游 ${cfg.prodTarget} 暂不可达，鉴权是否生效未经验证；若服务端以无 token 配置运行，本网关将无鉴权转发。`)
  }
}

const tls = await ensureCerts(cfg)
const fetchHttp = makeFetch(cfg, 'http://127.0.0.1')
const fetchTls = makeFetch(cfg, 'https://127.0.0.1')

const internalHttp = Bun.serve<WSProxyData>({
  hostname: '127.0.0.1',
  port: 0,
  fetch: fetchHttp,
  websocket: wsHandler,
})
const internalTls = Bun.serve<WSProxyData>({
  hostname: '127.0.0.1',
  port: 0,
  tls: { cert: tls.cert, key: tls.key },
  fetch: fetchTls,
  websocket: wsHandler,
})

// Bun 类型里 Server.port 可空；port:0 由系统分配，取不到等于启动失败
const internalHttpPort = internalHttp.port
const internalTlsPort = internalTls.port
if (!internalHttpPort || !internalTlsPort) throw new Error('[gateway] 内部代理端口分配失败')

// sshTarget 在首个 SSH 连接到达前就先校验好：畸形配置在启动期 fail fast，
// 而不是等 data 回调里抛 uncaughtException（进程直接退出且无线索）
if (cfg.muxSsh) parseHostPort(cfg.sshTarget)

if (cfg.replace) await replaceStaleGateway([cfg.httpPort, cfg.httpsPort])

startMux(cfg.httpPort, cfg, internalHttpPort, internalTlsPort)
startMux(cfg.httpsPort, cfg, internalHttpPort, internalTlsPort)

console.log(`[gateway] 对外 :${cfg.httpPort} (HTTP/TLS/SSH 分流) 与 :${cfg.httpsPort} (同上)`)
console.log(`[gateway] 内部 HTTP :${internalHttpPort}  TLS :${internalTlsPort}`)
console.log(`[gateway] 生产 ${cfg.prodHost} → ${cfg.prodTarget}  (默认，Cookie 可切)`)
console.log(`[gateway] 开发 ${cfg.devHost} → ${cfg.devTarget}  (域名永远开发)`)
console.log(`[gateway] 切换  http://${cfg.prodHost}/?mode=dev  或  /?mode=prod  ；状态 /__gateway`)
if (cfg.muxSsh) console.log(`[gateway] SSH 连 :${cfg.httpPort} 会转到 ${cfg.sshTarget}`)
console.log(`[gateway] 本机直连不受影响：http://127.0.0.1:${portOfTarget(cfg.devTarget)} 与 :${portOfTarget(cfg.prodTarget)}`)
