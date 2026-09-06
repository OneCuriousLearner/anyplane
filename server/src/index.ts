// anyplane 服务端入口（装配层）：启动守卫 + createServer + bindServer + 启动日志 + shutdown。
// S2 拆分后的职责边界：
//   hub/    Hub 编排层（registry/broadcast/status/callbacks/lifecycle/messages/handoff/socket）
//   push/   推送扇出（fanout：显示名/摘要/确认页；inbox：/ws/inbox 频道与 InboxSink 实现）
//   routes/ REST 路由（api.ts 聚合 pushRoutes/sessions/misc）
//   backends/port.ts  后端能力契约（portFor 唯一分支点；适配器回调经下方 initBackendPorts 注入）

import { existsSync } from 'node:fs'
import { networkInterfaces } from 'node:os'
import { join, resolve } from 'node:path'
import { hostAllowed, isAuthorized, isLoopbackHost, jsonContentTypeRequired, originAllowed } from './auth'
import { processManager } from './backends/claude/processManager'
import { codexRuntime } from './backends/codex/runtime'
import { initBackendPorts } from './backends/port'
import { config } from './config'
import { startupVersionProbe } from './driftGuard'
import { broadcast, broadcastError } from './hub/broadcast'
import { sessionCallbacks } from './hub/callbacks'
import { rewindBusy } from './hub/lifecycle'
import { getHub } from './hub/registry'
import { wsClose, wsMessage, wsOpen } from './hub/socket'
import { pushStatus } from './hub/status'
import type { WSData } from './hub/types'
import { log } from './log'
import { isOwnServerProcess, takeoverStaleListeners } from './portTakeover'
import { sessionNameOf } from './push/fanout'
import { initInbox } from './push/inbox'
import { handleApi } from './routes/api'
import { json } from './routes/http'
import { errorMessage, hasWindowsSocketFix } from './util'

// ---------- sessionKey ----------
// 编码规则与解析见 backends/claude/backend.ts（s|slug|sid / n|cwd）

// ---------- 装配：适配器回调注入 + inbox sink 接线 ----------
// BackendPort 适配器禁止 import hub/push 编排模块，回调经 HubServices 一次性注入；
// inbox 事件经 hub/broadcast 的 InboxSink 出口流向 push/inbox 的真实实现（解 hub↔push 循环）。
initBackendPorts({
  broadcast,
  broadcastError,
  pushStatus,
  sessionCallbacks,
  getHub,
  sessionNameOf,
  rewindBusy,
})
initInbox()

function logWindowsPortState(stage: string, port: number): void {
  if (process.platform !== 'win32') return
  try {
    const result = Bun.spawnSync(['netstat.exe', '-ano', '-p', 'tcp'], {
      stdout: 'pipe',
      stderr: 'pipe',
      stdin: 'ignore',
    })
    const marker = `:${port}`
    const rows = result.stdout
      .toString()
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.includes(marker))
    log.info(
      `[port-diagnostic] stage=${stage} appPid=${process.pid} port=${port} rows=${rows.length}`,
    )
    for (const row of rows) log.info(`[port-diagnostic] ${row}`)
  } catch (e) {
    log.warn(`[port-diagnostic] stage=${stage} failed:`, e)
  }
}

const distDir = resolve(import.meta.dir, '../../web/dist')

if (!hasWindowsSocketFix() && process.env.ANYPLANE_ALLOW_UNSAFE_BUN !== '1') {
  log.error(
    `[anyplane] Bun ${Bun.version} on Windows has the inherited-listener bug oven-sh/bun#36936.`,
  )
  log.error('[anyplane] Run `bun upgrade` (need >= 1.4.0) and restart the terminal. Server startup refused.')
  process.exit(1)
}

// 绑定非回环地址却不配置 token = 把"任意目录起会话 + 任意命令执行"裸奔到网络上，拒绝启动
if (!isLoopbackHost(config.host) && !config.authToken) {
  log.error(`[anyplane] 拒绝启动：host=${config.host} 为非回环地址，但未配置 authToken。`)
  log.error('[anyplane] 请在 anyplane.config.json 设置 "authToken" 或设置环境变量 ANYPLANE_TOKEN。')
  process.exit(1)
}

let server: ReturnType<typeof Bun.serve<WSData>>

// 跨源防护的实现已移至 auth.ts（可单测）；此处仅保留启动守卫说明：
// WebSocket 不受同源策略约束、text/plain 简单请求不触发 preflight——
// 默认无 token 时恶意网页可经受害者浏览器直连回环服务（CSWSH/CSRF → RCE）。
// 浏览器在 WS 握手与跨源 POST 时必定携带 Origin；非浏览器客户端（e2e 脚本/curl）不带。
// 配置 authToken 后 token 即防线，这些检查不生效（行为与旧版完全一致）。

function createServer(): ReturnType<typeof Bun.serve<WSData>> {
  return Bun.serve<WSData>({
    port: config.port,
    hostname: config.host,
    async fetch(req, srv) {
      const url = new URL(req.url)

      // 数据面/控制面统一鉴权（静态壳不鉴权，JS 中无敏感数据）
      // /api/approval-action 与 /api/approval-page 例外：推送直接审批走能力 URL（per-subscription/webhook
      // secret），SW 回POST与微信/Bark 内打开确认页都没有页面登录态，秘密本身即凭据
      //（且仅对 pending 中的 requestId 有效）
      const guarded =
        (url.pathname.startsWith('/api/') || url.pathname.startsWith('/ws/')) &&
        url.pathname !== '/api/approval-action' &&
        url.pathname !== '/api/approval-page'
      if (guarded && !isAuthorized(req, url)) {
        return json({ error: 'unauthorized' }, { status: 401 })
      }

      // 跨源防护：仅在无 token 模式生效（此时唯一防线）。approval-action 走能力 URL，
      // SW 回 POST 无页面 Origin 语义，且其鉴权是 per-subscription secret，不在此约束。
      // hostAllowed 在最前：DNS rebinding 下 Origin 与 Host 同为攻击者域名，
      // Origin↔Host 一致性天然失效，Host 回环白名单才是不依赖攻击者行为的锚点。
      if (!config.authToken && guarded) {
        if (!hostAllowed(req)) {
          return json({ error: 'host not allowed' }, { status: 403 })
        }
        if (!originAllowed(req)) {
          return json({ error: 'origin not allowed' }, { status: 403 })
        }
        if (!jsonContentTypeRequired(req, url)) {
          return json({ error: 'content-type must be application/json' }, { status: 415 })
        }
      }

      const wsMatch = url.pathname.match(/^\/ws\/sessions\/(.+)$/)
      if (wsMatch) {
        let key: string
        try {
          key = decodeURIComponent(wsMatch[1])
        } catch {
          return json({ error: 'bad session key encoding' }, { status: 400 })
        }
        if (srv.upgrade(req, { data: { key } })) return undefined
        return new Response('WebSocket upgrade failed', { status: 400 })
      }

      // 全局收件箱频道：跨会话审批/完成/错误汇总
      if (url.pathname === '/ws/inbox') {
        if (srv.upgrade(req, { data: { inbox: true } })) return undefined
        return new Response('WebSocket upgrade failed', { status: 400 })
      }

      if (url.pathname.startsWith('/api/')) {
        const res = await handleApi(req, url)
        if (res) return res
        return json({ error: 'not found' }, { status: 404 })
      }

      // 静态托管 web/dist
      if (existsSync(distDir)) {
        const p = join(distDir, url.pathname === '/' ? 'index.html' : url.pathname)
        const f = Bun.file(p)
        if (await f.exists()) return new Response(f)
        const index = Bun.file(join(distDir, 'index.html')) // SPA 回退
        if (await index.exists()) return new Response(index)
      }
      return new Response('anyplane server (web 未构建，请用 vite dev 或 bun run build)', { status: 200 })
    },
    // websocket handlers 的实现见 hub/socket.ts（30s 下行 keepalive 的注释也在那里）
    websocket: {
      open: wsOpen,
      message: wsMessage,
      close: wsClose,
    },
  })
}

// EADDRINUSE 且占用者是本仓库残留 server → 接管后重试一次；外来进程占用则原样报错
async function bindServer(): Promise<ReturnType<typeof Bun.serve<WSData>>> {
  try {
    return createServer()
  } catch (e) {
    const msg = errorMessage(e)
    const addrInUse = msg.includes('EADDRINUSE') || (e as { code?: string }).code === 'EADDRINUSE'
    if (!addrInUse) throw e
    log.error(`[anyplane] :${config.port} 已被占用，尝试接管本仓库残留进程…`)
    if ((await takeoverStaleListeners(config.port, isOwnServerProcess)) !== 'freed') throw e
    log.info(`[anyplane] :${config.port} 残留已清理，重新绑定`)
    return createServer()
  }
}

try {
  server = await bindServer()
} catch (e) {
  const msg = errorMessage(e)
  log.error(
    `[anyplane] bind failed port=${config.port} pid=${process.pid} ppid=${process.ppid} bun=${Bun.version}: ${msg}`,
  )
  logWindowsPortState('bind-failed', config.port)
  if (process.platform === 'win32') {
    log.error(
      '[anyplane] 若 LISTENING PID 已不存在，通常是 Bun <=1.3.14 的 socket handle 继承问题；升级到 1.4.0+。已形成且找不到持有进程的绑定需重启 Windows 一次。',
    )
  }
  process.exit(1)
}

// 通配绑定（0.0.0.0/::）时二维码与日志要显示可路由的局域网地址
function lanAddress(): string {
  for (const addrs of Object.values(networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family === 'IPv4' && !a.internal) return a.address
    }
  }
  return 'localhost'
}
const displayHost = isLoopbackHost(config.host)
  ? 'localhost'
  : config.host === '0.0.0.0' || config.host === '::'
    ? lanAddress()
    : config.host
const accessUrl = `http://${displayHost}:${server.port}/${config.authToken ? `?token=${config.authToken}` : ''}`
log.info(
  `[anyplane] listening on ${accessUrl} pid=${process.pid} ppid=${process.ppid} bun=${Bun.version}`,
)
log.info(`[anyplane] permissionPolicy=${config.permissionPolicy} claudeConfigDir=${config.claudeConfigDir}`)
if (!config.authToken) {
  log.info('[anyplane] 未配置 authToken，仅监听回环地址。需要局域网访问时：配置 authToken 并设置 host。')
}

// 局域网模式：打印扫码即入的终端二维码（URL 已带 token）
if (!isLoopbackHost(config.host)) {
  try {
    const { default: QRCode } = await import('qrcode')
    log.info(await QRCode.toString(accessUrl, { type: 'terminal', small: true }))
  } catch (e) {
    log.warn('[anyplane] 二维码生成失败（不影响服务）:', e)
  }
}

// 协议漂移预警：CLI 版本前进而未跑过对应检查时提醒（不阻塞启动）
try {
  startupVersionProbe()
} catch (e) {
  log.warn('[drift] 版本探测失败（不影响服务）:', e)
}

// 审批规则引擎：加载即生效（坏规则在 config 加载时已 fail fast）
if (config.approvalRules?.length) {
  log.info(`[approval] 审批规则引擎已启用：${config.approvalRules.length} 条规则，按序首条命中`)
}

let shuttingDown = false
async function shutdown(reason: string): Promise<void> {
  if (shuttingDown) {
    log.warn(`[anyplane] shutdown already in progress; repeated=${reason}`)
    return
  }
  shuttingDown = true
  const started = performance.now()
  log.info(`[anyplane] shutdown begin reason=${reason} pid=${process.pid}`)

  // 先发起 listener/连接关闭，再清 Claude 子进程。Bun <=1.3.14（修复于 1.4.0）在 Windows
  // 会让这些子进程继承监听 handle；两边都完成前绝不能 process.exit()。
  let stopPromise: Promise<void>
  try {
    log.info('[anyplane] server.stop(true) begin')
    stopPromise = Promise.resolve(server.stop(true))
  } catch (e) {
    log.error('[anyplane] server.stop(true) invoke failed:', e)
    stopPromise = Promise.resolve()
  }

  try {
    processManager.disposeAll()
    codexRuntime.disposeAll()
  } catch (e) {
    log.error('[anyplane] disposeAll 失败:', e)
  }

  const timeout = new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 5_000))
  const stopped = stopPromise.then(
    () => 'stopped' as const,
    (e) => {
      log.error('[anyplane] server.stop(true) rejected:', e)
      return 'failed' as const
    },
  )
  const result = await Promise.race([stopped, timeout])
  log.info(
    `[anyplane] shutdown server=${result} elapsedMs=${Math.round(performance.now() - started)}`,
  )

  if (result === 'timeout') {
    // 到这里 listener 已调用 stop，强退只是最后兜底；正常路径不应触发。
    log.error('[anyplane] shutdown timed out after 5s; forcing exit')
    process.exit(1)
  }
  logWindowsPortState('after-stop', config.port)
  log.info(`[anyplane] shutdown complete elapsedMs=${Math.round(performance.now() - started)}`)
  process.exit(0)
}

process.on('SIGINT', () => void shutdown('SIGINT'))
process.on('SIGTERM', () => void shutdown('SIGTERM'))
process.on('exit', (code) => {
  log.info(`[anyplane] process exit pid=${process.pid} code=${code} shuttingDown=${shuttingDown}`)
})
