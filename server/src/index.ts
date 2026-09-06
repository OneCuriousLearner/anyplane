// anyplane 服务端入口：REST + WebSocket + 静态托管
// S2 拆分后的职责边界：Hub 编排层在 hub/（registry/broadcast/status/callbacks/lifecycle/messages/handoff/socket），
// 推送扇出在 push/（fanout/inbox）；本文件保留 REST 路由（handleApi）与进程装配（启动守卫/createServer/shutdown）。

import { existsSync } from 'node:fs'
import { networkInterfaces } from 'node:os'
import { join, resolve } from 'node:path'
import { listTrash } from './archive'
import { hostAllowed, isAuthorized, isLoopbackHost, jsonContentTypeRequired, originAllowed } from './auth'
import { keyFor, keyForNew } from './backends/claude/backend'
import { listSessions, readHistory, sanitizePath, type SessionInfo } from './backends/claude/discovery'
import { resolveTierModelNames } from './backends/claude/modelNames'
import { processManager } from './backends/claude/processManager'
import {
  keyForNew as codexKeyForNew,
  listSessions as listCodexSessions,
  readHistory as readCodexHistory,
} from './backends/codex/backend'
import { codexRuntime } from './backends/codex/runtime'
import { initBackendPorts, portFor } from './backends/port'
import { config } from './config'
import { startupVersionProbe } from './driftGuard'
import { FsBrowseError, listDirectories, readGitBranch } from './fsbrowse'
import { lineageFor, type HandoffDetail } from './handoff'
import { broadcast, broadcastError } from './hub/broadcast'
import { sessionCallbacks } from './hub/callbacks'
import { runHandoff } from './hub/handoff'
import { resolveApproval, rewindBusy } from './hub/lifecycle'
import { getHub, hubs } from './hub/registry'
import { wsClose, wsMessage, wsOpen } from './hub/socket'
import { pushStatus, statusOf } from './hub/status'
import type { WSData } from './hub/types'
import { log } from './log'
import { isOwnServerProcess, takeoverStaleListeners } from './portTakeover'
import {
  addSubscription,
  pushToAll,
  pushWebhooksToAll,
  removeSubscription,
  subscriptionCount,
  vapidPublicKey,
  validSecret,
  webhookCount,
  type PushPayload,
} from './push'
import { approvalPageHtml, sessionNameOf } from './push/fanout'
import { initInbox } from './push/inbox'
import { resolveUpload } from './uploads'
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

// ---------- HTTP ----------

function json(data: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  })
}

/** POST JSON body：解析失败按 {} 处理（各 handler 自行做字段校验） */
async function readJsonBody<T>(req: Request): Promise<T> {
  return (await req.json().catch(() => ({}))) as T
}

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

// ---------- /api/sessions 的 git 分支缓存 ----------
// 列表被前端轮询，每个 cwd 的分支读取是 2-3 次同步文件 IO；分支变化不需要秒级新鲜度，30s TTL。
const BRANCH_CACHE_TTL_MS = 30_000
const branchCache = new Map<string, { branch: string | undefined; at: number }>()

function branchOfCached(cwd?: string): string | undefined {
  if (!cwd) return undefined
  const hit = branchCache.get(cwd)
  if (hit && Date.now() - hit.at < BRANCH_CACHE_TTL_MS) return hit.branch
  const branch = readGitBranch(cwd) // 普通仓库与 worktree 都支持
  branchCache.set(cwd, { branch, at: Date.now() })
  return branch
}

async function handleApi(req: Request, url: URL): Promise<Response | undefined> {
  // ---------- Web Push 订阅管理 ----------
  if (url.pathname === '/api/push/public-key' && req.method === 'GET') {
    return json({ publicKey: vapidPublicKey(), subscriptions: subscriptionCount(), webhooks: webhookCount() })
  }
  if (url.pathname === '/api/push/subscriptions' && req.method === 'POST') {
    const body = await readJsonBody<{ endpoint?: string; keys?: { p256dh: string; auth: string } }>(req)
    if (!body.endpoint || !body.keys?.p256dh || !body.keys?.auth) {
      return json({ error: 'endpoint 与 keys.p256dh/auth 必填' }, { status: 400 })
    }
    let secret: string
    try {
      secret = addSubscription(
        { endpoint: body.endpoint, keys: body.keys },
        req.headers.get('user-agent') ?? undefined,
      ).secret
    } catch (e) {
      return json({ error: errorMessage(e) }, { status: 400 })
    }
    log.info(`[push] 新订阅（共 ${subscriptionCount()}）：${body.endpoint.slice(0, 60)}…`)
    return json({ ok: true, secret })
  }
  if (url.pathname === '/api/push/subscriptions' && req.method === 'DELETE') {
    const body = await readJsonBody<{ endpoint?: string }>(req)
    return json({ ok: body.endpoint ? removeSubscription(body.endpoint) : false })
  }
  // 推送通道自检：向全部订阅与 webhook 通道 fanout 一条测试通知（不带审批能力，点击落应用首页）
  if (url.pathname === '/api/push/test' && req.method === 'POST') {
    const payload: PushPayload = {
      type: 'done',
      title: '测试通知 · AnyPlane',
      body: '推送链路可达：全部订阅与 webhook 通道会同时收到这一条。',
      key: '',
      session: 'anyplane',
      tag: 'ccr-test',
    }
    const [push, hooks] = await Promise.all([pushToAll(payload), pushWebhooksToAll(payload)])
    return json({
      ok: true,
      subscriptions: subscriptionCount(),
      webhooks: webhookCount(),
      sent: push.sent + hooks.sent,
      pruned: push.pruned,
    })
  }
  // 推送直接审批（能力 URL：secret 鉴权，不走 authToken——该 URL 只经加密推送投递到订阅设备）
  if (url.pathname === '/api/approval-action' && req.method === 'POST') {
    const key = url.searchParams.get('k') ?? ''
    const requestId = url.searchParams.get('r') ?? ''
    const decision = url.searchParams.get('d') ?? ''
    const secret = url.searchParams.get('s') ?? ''
    if (!validSecret(secret)) return json({ ok: false, error: '无效的能力密钥' }, { status: 403 })
    if (decision !== 'allow' && decision !== 'deny') {
      return json({ ok: false, error: 'd 只接受 allow/deny' }, { status: 400 })
    }
    const hub = hubs.get(key)
    if (!hub || !hub.pendingApprovals.has(requestId)) {
      return json({ ok: false, error: '该审批已处理或不存在' }, { status: 409 })
    }
    const pending = hub.pendingApprovals.get(requestId)!
    const ok = resolveApproval(
      hub,
      requestId,
      decision === 'allow'
        ? { behavior: 'allow', updatedInput: pending.input }
        : { behavior: 'deny', message: '用户在推送通知上拒绝了该操作' },
    )
    log.info(`[push] 通知直接审批 ${decision}：${sessionNameOf(key)} · ${pending.toolName}`)
    return json({ ok })
  }
  // webhook 通知的审批确认页（Bark/Server酱 无原生按钮：点链接进此页，按钮再 POST 到 approval-action）。
  // GET 只渲染不执行——通知链接被预览/抓取也不会误触审批。能力 URL 模型同 approval-action。
  if (url.pathname === '/api/approval-page' && req.method === 'GET') {
    const key = url.searchParams.get('k') ?? ''
    const requestId = url.searchParams.get('r') ?? ''
    const secret = url.searchParams.get('s') ?? ''
    if (!validSecret(secret)) return new Response('无效的能力密钥', { status: 403 })
    const pending = hubs.get(key)?.pendingApprovals.get(requestId)
    return new Response(approvalPageHtml(key, pending), {
      headers: { 'content-type': 'text/html; charset=utf-8' },
    })
  }
  if (url.pathname === '/api/sessions' && req.method === 'GET') {
    const sessions = listSessions()
    const claudeRows = sessions.map((s: SessionInfo) => ({
      ...s,
      backend: 'claude' as const,
      gitBranch: branchOfCached(s.cwd),
      key: keyFor(s.slug, s.sessionId),
      // listSessions 已扫过 pid 文件，复用其结果，不为每行再扫一次（null = 已知不在线）
      managed: statusOf(
        keyFor(s.slug, s.sessionId),
        s.live ? { status: s.status, pid: s.live.pid } : null,
      ),
    }))
    // codex 线程：app-server 未安装/未登录时静默降级为空列表，不拖垮 claude 列表
    let codexRows: Record<string, unknown>[] = []
    try {
      const threads = await listCodexSessions()
      codexRows = threads.map((t) => ({
        sessionId: t.id,
        cwd: t.cwd,
        slug: 'codex',
        title: t.title,
        lastPrompt: t.lastPrompt,
        mtime: t.mtime,
        sizeBytes: 0,
        status: t.status,
        backend: 'codex' as const,
        gitBranch: branchOfCached(t.cwd),
        key: t.key,
        managed: statusOf(t.key),
      }))
    } catch (e) {
      log.warn('[api] codex thread/list 失败（仅返回 claude 会话）:', e instanceof Error ? e.message : e)
    }
    return json([...codexRows, ...claudeRows])
  }
  if (url.pathname === '/api/sessions' && req.method === 'POST') {
    const body = await readJsonBody<{ cwd?: string; backend?: string }>(req)
    if (!body.cwd) return json({ error: '缺少 cwd' }, { status: 400 })
    if (body.backend === 'codex') {
      return json({ key: codexKeyForNew(body.cwd), slug: 'codex', backend: 'codex' })
    }
    return json({ key: keyForNew(body.cwd), slug: sanitizePath(body.cwd), backend: 'claude' })
  }
  if (url.pathname === '/api/fs/list' && req.method === 'GET') {
    // searchParams.get 已完成 URL 解码，禁止再 decodeURIComponent（含 % 的路径会被二次解码破坏）
    const target = url.searchParams.get('path') ?? ''
    try {
      return json(listDirectories(target))
    } catch (e) {
      if (e instanceof FsBrowseError) return json({ error: e.message }, { status: e.status })
      return json({ error: errorMessage(e) }, { status: 500 })
    }
  }
  if (url.pathname === '/api/sessions/archive' && req.method === 'POST') {
    const body = await readJsonBody<{ key?: string }>(req)
    if (!body.key) return json({ error: '缺少 key' }, { status: 400 })
    const r = await portFor(body.key).archive(body.key)
    return r.ok ? json({ ok: true }) : json({ error: r.error }, { status: r.status })
  }
  if (url.pathname === '/api/sessions/restore' && req.method === 'POST') {
    const body = await readJsonBody<{ key?: string }>(req)
    if (!body.key) return json({ error: '缺少 key' }, { status: 400 })
    const r = await portFor(body.key).restore(body.key)
    return r.ok ? json({ ok: true }) : json({ error: r.error }, { status: r.status })
  }
  // 归档/回收站列表：codex archived + claude trash 合并
  if (url.pathname === '/api/sessions/archived' && req.method === 'GET') {
    const claudeTrash = listTrash().map((t) => ({
      key: t.key,
      sessionId: t.sessionId,
      slug: t.slug,
      backend: 'claude' as const,
      trashedAt: t.trashedAt,
      sizeBytes: t.sizeBytes,
    }))
    let codexArchived: Record<string, unknown>[] = []
    try {
      const res = (await codexRuntime.rpcRequest('thread/list', { archived: true, limit: 100 })) as {
        data?: Array<Record<string, unknown>>
      }
      codexArchived = (res.data ?? []).map((t) => ({
        key: `x|${String(t.id)}`,
        sessionId: String(t.id),
        slug: 'codex',
        backend: 'codex' as const,
        title: typeof t.name === 'string' ? t.name : undefined,
        lastPrompt: typeof t.preview === 'string' ? t.preview : undefined,
        cwd: typeof t.cwd === 'string' ? t.cwd : undefined,
        mtime: Number(t.updatedAt ?? t.createdAt ?? 0) * 1000,
      }))
    } catch (e) {
      log.warn('[api] codex archived 列表失败:', e instanceof Error ? e.message : e)
    }
    return json({ entries: [...codexArchived, ...claudeTrash] })
  }
  if (url.pathname === '/api/sessions/rename' && req.method === 'POST') {
    const body = await readJsonBody<{ key?: string; title?: string }>(req)
    const title = body.title?.trim()
    if (!body.key || !title) return json({ error: '缺少 key 或 title' }, { status: 400 })
    // codex 走官方 thread/name/set；claude 仅离线会话（transcript 追加 custom-title），
    // 两路实现见各自适配器
    const r = await portFor(body.key).rename(body.key, title)
    return r.ok ? json({ ok: true }) : json({ error: r.error }, { status: r.status })
  }
  if (url.pathname === '/api/handoff' && req.method === 'POST') {
    const body = await readJsonBody<{ fromKey?: string; toBackend?: string; detail?: HandoffDetail }>(req)
    if (!body.fromKey) return json({ error: '缺少 fromKey' }, { status: 400 })
    if (body.toBackend !== 'claude' && body.toBackend !== 'codex') {
      return json({ error: 'toBackend 必须是 claude 或 codex' }, { status: 400 })
    }
    const detail: HandoffDetail =
      body.detail === 'brief' || body.detail === 'detailed' ? body.detail : 'standard'
    const error = runHandoff(body.fromKey, body.toBackend, detail)
    if (error) return json({ error }, { status: 400 })
    return json({ ok: true })
  }
  if (url.pathname === '/api/lineage' && req.method === 'GET') {
    const key = url.searchParams.get('key') ?? ''
    const records = lineageFor(key)
    // 为链上每个 key 附带导航所需的节点元数据（前端接力链渲染用）
    const nodes: Record<string, Record<string, unknown>> = {}
    for (const r of records) {
      for (const k of [r.fromKey, r.toKey, r.fromResolvedKey, r.toResolvedKey]) {
        if (!k || nodes[k]) continue
        const parts = k.split('|')
        if (parts[0] === 's' && parts.length === 3) {
          nodes[k] = { key: k, backend: 'claude', slug: parts[1], sessionId: parts[2], cwd: r.cwd }
        } else if (parts[0] === 'x' && parts.length === 2) {
          nodes[k] = { key: k, backend: 'codex', slug: 'codex', sessionId: parts[1], cwd: r.cwd }
        } else if (parts[0] === 'n' || parts[0] === 'xn') {
          nodes[k] = {
            key: k,
            backend: parts[0] === 'xn' ? 'codex' : 'claude',
            slug: parts[0] === 'xn' ? 'codex' : sanitizePath(decodeURIComponent(parts[1] ?? '')),
            sessionId: 'new',
            cwd: r.cwd,
          }
        } else if (parts[0] === 'b' && parts.length === 3) {
          // 懒分叉源（分叉后从未 spawn 或被回收，fromResolvedKey 缺省时记录里仍是 b| key）：
          // 缺节点会让前端接力链按钮 disabled（死按钮）；sessionId 内嵌的是分叉源 id
          nodes[k] = {
            key: k,
            backend: 'claude',
            slug: sanitizePath(decodeURIComponent(parts[1] ?? '')),
            sessionId: parts[2],
            cwd: r.cwd,
          }
        }
      }
    }
    return json({ records, nodes })
  }
  // 上传图片：仅 ~/.anyplane/uploads/ 内的 hash 命名文件（resolveUpload 边界校验）
  const uploadMatch = url.pathname.match(/^\/api\/uploads\/([^/]+)$/)
  if (uploadMatch && req.method === 'GET') {
    const path = resolveUpload(uploadMatch[1])
    if (!path) return json({ error: 'not found' }, { status: 404 })
    const ext = path.split('.').pop() ?? ''
    const mime =
      ({ jpg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp' })[ext] ??
      'application/octet-stream'
    return new Response(Bun.file(path), {
      headers: { 'content-type': mime, 'cache-control': 'public, max-age=31536000, immutable' },
    })
  }
  const histMatch = url.pathname.match(/^\/api\/history\/([^/]+)\/([^/]+)$/)
  if (histMatch && req.method === 'GET') {
    const [, slug, sessionId] = histMatch
    // fileBytes = 本次实际读取的字节数，前端拿它作为 tailer 的起始偏移
    return json(readHistory(slug, sessionId))
  }
  // codex 历史：thread/read includeTurns（只读），无 tailer 偏移概念
  const codexHistMatch = url.pathname.match(/^\/api\/codex\/history\/([^/]+)$/)
  if (codexHistMatch && req.method === 'GET') {
    try {
      const messages = await readCodexHistory(codexHistMatch[1])
      return json({ messages, fileBytes: 0 })
    } catch (e) {
      return json({ error: errorMessage(e) }, { status: 500 })
    }
  }
  // codex 模型目录（model/list）：模型 id/显示名/effort 列表/默认 effort
  if (url.pathname === '/api/codex/models' && req.method === 'GET') {
    try {
      const models = await codexRuntime.listModels()
      return json({ models })
    } catch (e) {
      return json({ error: errorMessage(e) }, { status: 500 })
    }
  }
  if (url.pathname === '/api/config' && req.method === 'GET') {
    return json({
      permissionPolicy: config.permissionPolicy,
      permissionModes: ['default', 'acceptEdits', 'auto', 'plan', 'bypassPermissions'],
      effortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
      models: ['haiku', 'sonnet', 'opus', 'fable'],
      authRequired: !!config.authToken,
    })
  }
  // 各档实际配置的模型名（StatusPill 透传显示；每次调用实时读盘，配置改动即见）
  if (url.pathname === '/api/claude/model-names' && req.method === 'GET') {
    return json({ models: resolveTierModelNames(url.searchParams.get('cwd') ?? undefined) })
  }
  return undefined
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
    // websocket handlers 的实现见 hub/socket.ts（keepalive 注释也在那里）
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
