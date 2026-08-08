// cc-remote 服务端入口：REST + WebSocket + 静态托管

import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { config } from './config'
import { listSessions, readHistory, sanitizePath, type SessionInfo } from './discovery'
import { processManager, type ApprovalDecision, type SpawnOptions } from './processManager'
import type { CliMessage } from './protocol'

// ---------- sessionKey ----------
// 已存在会话：`s|<slug>|<sessionId>`；新会话：`n|<encodeURIComponent(cwd)>`

export function keyFor(slug: string, sessionId: string): string {
  return `s|${slug}|${sessionId}`
}

function parseKey(key: string): { cwd: string; resumeSessionId?: string; slug?: string } | null {
  const parts = key.split('|')
  if (parts[0] === 's' && parts.length === 3) {
    const [, slug, sessionId] = parts
    const info = listSessions().find((s) => s.slug === slug && s.sessionId === sessionId)
    if (!info?.cwd) return null
    return { cwd: info.cwd, resumeSessionId: sessionId, slug }
  }
  if (parts[0] === 'n' && parts.length === 2) {
    return { cwd: decodeURIComponent(parts[1]) }
  }
  return null
}

// ---------- WS 枢纽 ----------

interface PendingApproval {
  requestId: string
  toolName: string
  input: unknown
}

interface WSData {
  key: string
}

interface Hub {
  key: string
  clients: Set<import('bun').ServerWebSocket<WSData>>
  pendingApprovals: Map<string, PendingApproval>
  spawnOpts?: SpawnOptions
}

const hubs = new Map<string, Hub>()

function getHub(key: string): Hub {
  let h = hubs.get(key)
  if (!h) {
    h = { key, clients: new Set(), pendingApprovals: new Map() }
    hubs.set(key, h)
  }
  return h
}

function broadcast(hub: Hub, payload: unknown): void {
  const text = JSON.stringify(payload)
  for (const ws of hub.clients) {
    try {
      ws.send(text)
    } catch {}
  }
}

function statusOf(key: string): Record<string, unknown> {
  const s = processManager.get(key)
  const hub = hubs.get(key)
  const pending = hub?.pendingApprovals.size ?? 0
  const waiting = (s?.waiting ?? false) || pending > 0
  // 审批等待也算 busy，防止误回收
  const busy = (s?.busy ?? false) || waiting
  return {
    spawned: !!s && !s.exited,
    busy,
    waiting,
    sessionState: s?.sessionState ?? 'idle',
    sessionId: s?.sessionId,
    clients: s?.connectedClients ?? hub?.clients.size ?? 0,
  }
}

function pushStatus(hub: Hub, extra?: Record<string, unknown>): void {
  broadcast(hub, { kind: 'status', state: { ...statusOf(hub.key), ...extra } })
}

function ensureSpawned(hub: Hub, opts?: Partial<SpawnOptions>): void {
  const parsed = parseKey(hub.key)
  if (!parsed) {
    broadcast(hub, { kind: 'error', message: '无法解析会话（项目目录不存在？）' })
    return
  }
  const spawnOpts: SpawnOptions = {
    cwd: parsed.cwd,
    resumeSessionId: parsed.resumeSessionId,
    permissionMode: config.permissionPolicy === 'bypass' ? 'bypassPermissions' : undefined,
    ...hub.spawnOpts,
    ...opts,
  }
  hub.spawnOpts = spawnOpts
  try {
    const s = processManager.ensure(hub.key, spawnOpts, {
      onMessage: (msg: CliMessage) => {
        broadcast(hub, { kind: 'cli', msg })
      },
      onApprovalRequest: (req) => {
        hub.pendingApprovals.set(req.requestId, req)
        broadcast(hub, {
          kind: 'approval_request',
          requestId: req.requestId,
          toolName: req.toolName,
          input: req.input,
        })
        pushStatus(hub)
        processManager.get(hub.key)?.notifyExternalGate()
      },
      onStatusChange: () => pushStatus(hub),
      onExit: (code) => {
        pushStatus(hub, { exited: true, exitCode: code, spawned: false, busy: false, waiting: false })
      },
    })
    // 懒 spawn：WS 可能在进程创建前已 open，对齐客户端引用计数
    s.syncClients(hub.clients.size)
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    console.error(`[session ${hub.key}] spawn 失败:`, message)
    broadcast(hub, { kind: 'error', message })
    pushStatus(hub)
    return
  }
  pushStatus(hub)
}

function handleClientMessage(hub: Hub, raw: string): void {
  let data: Record<string, unknown>
  try {
    data = JSON.parse(raw)
  } catch {
    return
  }
  const session = () => processManager.get(hub.key)
  switch (data.kind) {
    case 'attach': {
      // 浏览历史只握手，不 spawn。发消息 / 切 model·mode·effort / rewind / btw 时再启动 CLI。
      // 若客户端显式传 warm:true，则预热 resume（用于主动续聊）。
      if (data.warm === true || data.opts) {
        ensureSpawned(hub, data.opts as Partial<SpawnOptions> | undefined)
      } else {
        pushStatus(hub)
      }
      for (const a of hub.pendingApprovals.values()) {
        broadcast(hub, { kind: 'approval_request', ...a })
      }
      break
    }
    case 'user': {
      let s = session()
      if (!s || s.exited) {
        ensureSpawned(hub)
        s = session()
      }
      if (!s || s.exited) {
        // ensureSpawned 已广播具体错误
        return
      }
      try {
        s.sendUserText(String(data.text ?? ''))
        pushStatus(hub)
      } catch (e) {
        broadcast(hub, { kind: 'error', message: `发送失败: ${e}` })
        pushStatus(hub)
      }
      break
    }
    case 'control': {
      const subtype = String(data.subtype)
      const extra = (data.extra as Record<string, unknown>) ?? {}
      // 中断：未启动则无需操作
      if (subtype === 'interrupt') {
        const s = session()
        if (s && !s.exited) {
          try {
            s.sendControl(subtype, extra)
          } catch (e) {
            broadcast(hub, { kind: 'error', message: `中断失败: ${e}` })
          }
          pushStatus(hub)
        }
        return
      }
      // 切换 model/mode 等同于续聊意图：未启动则先 spawn
      let s = session()
      if (!s || s.exited) {
        const opts: Partial<SpawnOptions> = {}
        if (subtype === 'set_model' && extra.model) opts.model = String(extra.model)
        if (subtype === 'set_permission_mode' && extra.mode) opts.permissionMode = String(extra.mode)
        ensureSpawned(hub, opts)
        s = session()
      }
      if (!s || s.exited) return
      try {
        s.sendControl(subtype, extra)
        pushStatus(hub)
      } catch (e) {
        broadcast(hub, { kind: 'error', message: `控制请求失败: ${e}` })
        pushStatus(hub)
      }
      break
    }
    case 'update_env': {
      // 切换 effort 等同于续聊意图：未启动则先 spawn
      const variables = (data.variables as Record<string, string>) ?? {}
      let s = session()
      if (!s || s.exited) {
        const opts: Partial<SpawnOptions> = {}
        if (variables.CLAUDE_CODE_EFFORT_LEVEL) opts.effort = variables.CLAUDE_CODE_EFFORT_LEVEL
        ensureSpawned(hub, opts)
        s = session()
      }
      if (!s || s.exited) return
      try {
        s.write({ type: 'update_environment_variables', variables })
        pushStatus(hub)
      } catch (e) {
        broadcast(hub, { kind: 'error', message: `更新环境变量失败: ${e}` })
        pushStatus(hub)
      }
      break
    }
    case 'rewind_conversation': {
      // 对话回滚：销毁当前进程，带 --resume-session-at 重新 spawn
      const at = String(data.userMessageId ?? '')
      if (!at) return
      const parsed = parseKey(hub.key)
      const sid = session()?.sessionId ?? parsed?.resumeSessionId
      if (!parsed || !sid) {
        broadcast(hub, { kind: 'error', message: '无法回滚：未知会话 ID' })
        return
      }
      // 先从 map 摘掉再 kill，避免旧 onExit 污染新会话
      processManager.dispose(hub.key)
      hub.spawnOpts = { ...hub.spawnOpts, cwd: parsed.cwd, resumeSessionId: sid, resumeSessionAt: at }
      ensureSpawned(hub)
      broadcast(hub, { kind: 'rewound', userMessageId: at })
      break
    }
    case 'btw': {
      // 侧问：fork 当前会话的一次性问答，不污染主会话
      const question = String(data.question ?? '').trim()
      const parsed = parseKey(hub.key)
      const sid = session()?.sessionId ?? parsed?.resumeSessionId
      if (!question || !parsed || !sid) {
        broadcast(hub, { kind: 'btw_result', ok: false, text: '侧问需要已有会话（先发过至少一条消息）' })
        return
      }
      runBtw(hub, parsed.cwd, sid, question)
      break
    }
    case 'approval': {
      const s = session()
      const requestId = String(data.requestId)
      hub.pendingApprovals.delete(requestId)
      if (s && !s.exited) {
        try {
          s.sendApproval(requestId, data.decision as ApprovalDecision)
        } catch (e) {
          broadcast(hub, { kind: 'error', message: `审批回复失败: ${e}` })
        }
      }
      broadcast(hub, { kind: 'approval_resolved', requestId })
      pushStatus(hub)
      s?.notifyExternalGate()
      break
    }
  }
}

// ---------- /btw 一次性侧问 ----------

import { resolveClaudeCommand } from './processManager'
import { spawn } from 'bun'

function runBtw(hub: Hub, cwd: string, sessionId: string, question: string): void {
  const { cmd, prefix } = resolveClaudeCommand()
  // Claude Code -p 支持 -n/--name：写入 custom-title，列表里可区分 fork 出来的侧问会话
  const oneLine = question.replace(/\s+/g, ' ').trim()
  const sessionName = `BTW: ${oneLine.length > 60 ? `${oneLine.slice(0, 57)}…` : oneLine}`
  let proc: ReturnType<typeof spawn>
  try {
    proc = spawn(
      [
        cmd,
        ...prefix,
        '-p',
        question,
        '--fork-session',
        '--resume',
        sessionId,
        '-n',
        sessionName,
        '--output-format',
        'stream-json',
        '--verbose',
        '--include-partial-messages',
      ],
      { cwd, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', env: { ...process.env } },
    )
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    broadcast(hub, { kind: 'btw_result', ok: false, question, text: `无法启动 claude CLI: ${message}` })
    return
  }
  broadcast(hub, { kind: 'btw_pending', question })

  // 逐行读 NDJSON：text/thinking 增量转发为 btw_delta，result 收尾
  const pump = async () => {
    const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader()
    const decoder = new TextDecoder()
    let buf = ''
    let finalText = ''
    let ok = true
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
      let nl: number
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim()
        buf = buf.slice(nl + 1)
        if (!line.startsWith('{')) continue
        let obj: Record<string, unknown>
        try {
          obj = JSON.parse(line)
        } catch {
          continue
        }
        if (obj.type === 'stream_event') {
          const ev = obj.event as { type?: string; delta?: { type?: string; text?: string; thinking?: string } } | undefined
          if (ev?.type === 'content_block_delta') {
            if (ev.delta?.type === 'text_delta' && ev.delta.text) {
              broadcast(hub, { kind: 'btw_delta', question, delta: ev.delta.text })
            } else if (ev.delta?.type === 'thinking_delta' && ev.delta.thinking) {
              broadcast(hub, { kind: 'btw_delta', question, delta: ev.delta.thinking, thinking: true })
            }
          }
        } else if (obj.type === 'result') {
          finalText = String(obj.result ?? '')
          ok = obj.is_error !== true
        }
      }
    }
    const code = await proc.exited
    broadcast(hub, { kind: 'btw_result', ok: ok && code === 0, question, text: finalText.trim() })
  }
  void pump().catch((e) => broadcast(hub, { kind: 'btw_result', ok: false, question, text: `侧问失败: ${e}` }))
}

// ---------- HTTP ----------

function json(data: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  })
}

const distDir = resolve(import.meta.dir, '../../web/dist')

async function handleApi(req: Request, url: URL): Promise<Response | undefined> {
  if (url.pathname === '/api/sessions' && req.method === 'GET') {
    const sessions = listSessions()
    // 附加 key 与进程内状态
    return json(
      sessions.map((s: SessionInfo) => ({
        ...s,
        key: keyFor(s.slug, s.sessionId),
        managed: statusOf(keyFor(s.slug, s.sessionId)),
      })),
    )
  }
  if (url.pathname === '/api/sessions' && req.method === 'POST') {
    const body = (await req.json().catch(() => ({}))) as { cwd?: string }
    if (!body.cwd) return json({ error: '缺少 cwd' }, { status: 400 })
    return json({ key: `n|${encodeURIComponent(body.cwd)}`, slug: sanitizePath(body.cwd) })
  }
  const histMatch = url.pathname.match(/^\/api\/history\/([^/]+)\/([^/]+)$/)
  if (histMatch && req.method === 'GET') {
    const [, slug, sessionId] = histMatch
    return json(readHistory(slug, sessionId))
  }
  if (url.pathname === '/api/config' && req.method === 'GET') {
    return json({
      permissionPolicy: config.permissionPolicy,
      permissionModes: ['default', 'acceptEdits', 'plan', 'bypassPermissions'],
      effortLevels: ['low', 'medium', 'high', 'max'],
      models: ['sonnet', 'opus', 'haiku', 'opusplan'],
    })
  }
  return undefined
}

let server: ReturnType<typeof Bun.serve<WSData>>
try {
  server = Bun.serve<WSData>({
    port: config.port,
    async fetch(req, srv) {
      const url = new URL(req.url)

      const wsMatch = url.pathname.match(/^\/ws\/sessions\/(.+)$/)
      if (wsMatch) {
        const key = decodeURIComponent(wsMatch[1])
        if (srv.upgrade(req, { data: { key } })) return undefined
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
      return new Response('cc-remote server (web 未构建，请用 vite dev 或 bun run build)', { status: 200 })
    },
    websocket: {
      open(ws) {
        const hub = getHub(ws.data.key)
        hub.clients.add(ws)
        processManager.get(ws.data.key)?.attachClient()
        ws.send(JSON.stringify({ kind: 'status', state: statusOf(ws.data.key) }))
        for (const a of hub.pendingApprovals.values()) {
          ws.send(JSON.stringify({ kind: 'approval_request', ...a }))
        }
      },
      message(ws, raw) {
        const hub = getHub(ws.data.key)
        try {
          handleClientMessage(hub, typeof raw === 'string' ? raw : raw.toString())
        } catch (e) {
          const message = e instanceof Error ? e.message : String(e)
          console.error(`[ws ${hub.key}] 处理消息异常:`, message)
          try {
            ws.send(JSON.stringify({ kind: 'error', message }))
          } catch {}
        }
      },
      close(ws) {
        const hub = hubs.get(ws.data.key)
        if (!hub) return
        hub.clients.delete(ws)
        processManager.get(ws.data.key)?.detachClient()
        if (hub.clients.size === 0 && !processManager.get(ws.data.key)) hubs.delete(ws.data.key)
      },
    },
  })
} catch (e) {
  const msg = e instanceof Error ? e.message : String(e)
  console.error(`[cc-remote] 无法监听 :${config.port}: ${msg}`)
  if (process.platform === 'win32') {
    console.error(`[cc-remote] 若 netstat 显示 LISTENING 但 PID 进程已不存在，属于 Windows 僵尸端口，只能重启电脑释放 :${config.port}`)
  }
  process.exit(1)
}

console.log(`[cc-remote] listening on http://localhost:${server.port}`)
console.log(`[cc-remote] permissionPolicy=${config.permissionPolicy} claudeConfigDir=${config.claudeConfigDir}`)

let shuttingDown = false
function shutdown(reason: string): void {
  if (shuttingDown) {
    // 二次 Ctrl+C：不再等待，硬退
    process.exit(1)
  }
  shuttingDown = true
  console.log(`[cc-remote] ${reason}, 正在关闭…`)
  try {
    processManager.disposeAll()
  } catch (e) {
    console.error('[cc-remote] disposeAll 失败:', e)
  }
  // Windows：长时间 await stop 容易被控制台直接杀进程，留下僵尸 LISTENING。
  // 限时强制 stop，超时也 exit，尽量先关掉 listen fd。
  const forceExit = setTimeout(() => {
    console.warn('[cc-remote] 关闭超时，强制退出')
    process.exit(0)
  }, 800)
  forceExit.unref?.()
  void Promise.resolve()
    .then(() => server.stop(true))
    .catch((e) => console.error('[cc-remote] server.stop 失败:', e))
    .finally(() => {
      clearTimeout(forceExit)
      process.exit(0)
    })
}

process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))
