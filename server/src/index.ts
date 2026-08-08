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
  return {
    spawned: !!s && !s.exited,
    busy: s?.busy ?? false,
    sessionId: s?.sessionId,
    clients: s?.connectedClients ?? 0,
  }
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
  processManager.ensure(hub.key, spawnOpts, {
    onMessage: (msg: CliMessage) => {
      broadcast(hub, { kind: 'cli', msg })
      // result 后同步 busy 状态
      if (msg.type === 'result') broadcast(hub, { kind: 'status', state: statusOf(hub.key) })
    },
    onApprovalRequest: (req) => {
      hub.pendingApprovals.set(req.requestId, req)
      broadcast(hub, {
        kind: 'approval_request',
        requestId: req.requestId,
        toolName: req.toolName,
        input: req.input,
      })
    },
    onExit: (code) => {
      broadcast(hub, { kind: 'status', state: { ...statusOf(hub.key), exited: true, exitCode: code } })
    },
  })
  broadcast(hub, { kind: 'status', state: statusOf(hub.key) })
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
      ensureSpawned(hub, data.opts as Partial<SpawnOptions> | undefined)
      // 重放挂起的审批
      for (const a of hub.pendingApprovals.values()) {
        broadcast(hub, { kind: 'approval_request', ...a })
      }
      break
    }
    case 'user': {
      const s = session()
      if (!s || s.exited) {
        ensureSpawned(hub)
      }
      try {
        session()!.sendUserText(String(data.text ?? ''))
        broadcast(hub, { kind: 'status', state: statusOf(hub.key) })
      } catch (e) {
        broadcast(hub, { kind: 'error', message: `发送失败: ${e}` })
      }
      break
    }
    case 'control': {
      const s = session()
      if (!s || s.exited) {
        broadcast(hub, { kind: 'error', message: '会话未启动' })
        return
      }
      s.sendControl(String(data.subtype), (data.extra as Record<string, unknown>) ?? {})
      break
    }
    case 'update_env': {
      const s = session()
      if (s && !s.exited) {
        s.write({ type: 'update_environment_variables', variables: (data.variables as Record<string, string>) ?? {} })
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
      session()?.dispose()
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
      if (s && !s.exited) s.sendApproval(requestId, data.decision as ApprovalDecision)
      broadcast(hub, { kind: 'approval_resolved', requestId })
      break
    }
  }
}

// ---------- /btw 一次性侧问 ----------

import { resolveClaudeCommand } from './processManager'
import { spawn } from 'bun'

function runBtw(hub: Hub, cwd: string, sessionId: string, question: string): void {
  const { cmd, prefix } = resolveClaudeCommand()
  const proc = spawn(
    [cmd, ...prefix, '-p', question, '--fork-session', '--resume', sessionId, '--output-format', 'json'],
    { cwd, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', env: { ...process.env } },
  )
  broadcast(hub, { kind: 'btw_pending', question })
  void Promise.all([new Response(proc.stdout as ReadableStream<Uint8Array>).text(), proc.exited])
    .then(([text, code]) => {
      let answer = text
      try {
        const obj = JSON.parse(text)
        answer = String(obj.result ?? text)
      } catch {}
      broadcast(hub, { kind: 'btw_result', ok: code === 0, question, text: answer.trim() })
    })
    .catch((e) => broadcast(hub, { kind: 'btw_result', ok: false, question, text: `侧问失败: ${e}` }))
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

const server = Bun.serve<WSData>({
  port: config.port,
  async fetch(req, server) {
    const url = new URL(req.url)

    const wsMatch = url.pathname.match(/^\/ws\/sessions\/(.+)$/)
    if (wsMatch) {
      const key = decodeURIComponent(wsMatch[1])
      if (server.upgrade(req, { data: { key } })) return undefined
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
      handleClientMessage(hub, typeof raw === 'string' ? raw : raw.toString())
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

console.log(`[cc-remote] listening on http://localhost:${server.port}`)
console.log(`[cc-remote] permissionPolicy=${config.permissionPolicy} claudeConfigDir=${config.claudeConfigDir}`)

process.on('SIGINT', () => {
  processManager.disposeAll()
  process.exit(0)
})
process.on('SIGTERM', () => {
  processManager.disposeAll()
  process.exit(0)
})
