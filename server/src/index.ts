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
  /** 未 spawn 时缓存启动偏好；已 spawn 时记录当前选择，供 UI 重连恢复 */
  spawnOpts?: Partial<SpawnOptions>
  /** 除 effort 外、需要在进程启动后按顺序写入 stdin 的环境变量 */
  pendingEnv?: Record<string, string>
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
    activeTaskCount: s?.activeTaskCount ?? 0,
    activeTasks: s?.backgroundTasks ?? [],
    model: hub?.spawnOpts?.model,
    permissionMode: hub?.spawnOpts?.permissionMode,
    effort: hub?.spawnOpts?.effort,
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
    // 自定义 env 必须排在首条 user 消息之前写入；stdin 保证顺序。
    if (hub.pendingEnv && Object.keys(hub.pendingEnv).length > 0) {
      s.write({ type: 'update_environment_variables', variables: hub.pendingEnv })
      hub.pendingEnv = undefined
    }
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
      // model/mode 都有等价 CLI 启动参数。未 spawn 时只缓存最终选择，
      // 等首条 user 消息触发 ensureSpawned；已 spawn 时才发送运行时控制。
      if (subtype === 'set_model' && extra.model) {
        hub.spawnOpts = { ...hub.spawnOpts, model: String(extra.model) }
      }
      if (subtype === 'set_permission_mode' && extra.mode) {
        hub.spawnOpts = { ...hub.spawnOpts, permissionMode: String(extra.mode) }
      }
      let s = session()
      if (!s || s.exited) {
        if (subtype === 'set_model' || subtype === 'set_permission_mode') {
          pushStatus(hub)
          return
        }
        // 其他控制可能没有 CLI 参数等价物，仍需进程承接。
        ensureSpawned(hub)
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
      // effort 有 --effort 启动参数。未 spawn 时只缓存，首条消息时应用；
      // 已 spawn 时通过 update_environment_variables 影响后续 turn。
      const variables = (data.variables as Record<string, string>) ?? {}
      const effort = variables.CLAUDE_CODE_EFFORT_LEVEL
      if (effort) hub.spawnOpts = { ...hub.spawnOpts, effort }
      const otherVariables = Object.fromEntries(
        Object.entries(variables).filter(([key]) => key !== 'CLAUDE_CODE_EFFORT_LEVEL'),
      )
      const s = session()
      if (!s || s.exited) {
        if (Object.keys(otherVariables).length > 0) {
          hub.pendingEnv = { ...hub.pendingEnv, ...otherVariables }
        }
        pushStatus(hub)
        return
      }
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
  const sessionName = `FORK: ${oneLine.length > 60 ? `${oneLine.slice(0, 57)}…` : oneLine}`
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
    console.log(
      `[port-diagnostic] stage=${stage} appPid=${process.pid} port=${port} rows=${rows.length}`,
    )
    for (const row of rows) console.log(`[port-diagnostic] ${row}`)
  } catch (e) {
    console.warn(`[port-diagnostic] stage=${stage} failed:`, e)
  }
}

const distDir = resolve(import.meta.dir, '../../web/dist')

const [bunMajor = 0, bunMinor = 0, bunPatch = 0] = Bun.version.split(/[.-]/).map(Number)
const hasWindowsSocketFix =
  process.platform !== 'win32' ||
  bunMajor > 1 ||
  bunMinor > 3 ||
  (bunMinor === 3 && bunPatch >= 15) ||
  Bun.version.includes('canary')

if (!hasWindowsSocketFix && process.env.CC_REMOTE_ALLOW_UNSAFE_BUN !== '1') {
  console.error(
    `[cc-remote] Bun ${Bun.version} on Windows has the inherited-listener bug oven-sh/bun#36936.`,
  )
  console.error('[cc-remote] Run `bun upgrade --canary` and restart the terminal. Server startup refused.')
  process.exit(1)
}

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
      permissionModes: ['default', 'acceptEdits', 'auto', 'plan', 'bypassPermissions'],
      effortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
      models: ['haiku', 'sonnet', 'opus', 'fable'],
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
  console.error(
    `[cc-remote] bind failed port=${config.port} pid=${process.pid} ppid=${process.ppid} bun=${Bun.version}: ${msg}`,
  )
  logWindowsPortState('bind-failed', config.port)
  if (process.platform === 'win32') {
    console.error(
      '[cc-remote] 若 LISTENING PID 已不存在，通常是 Bun <=1.3.14 的 socket handle 继承问题；先升级 canary。已形成且找不到持有进程的绑定需重启 Windows 一次。',
    )
  }
  process.exit(1)
}

console.log(
  `[cc-remote] listening on http://localhost:${server.port} pid=${process.pid} ppid=${process.ppid} bun=${Bun.version}`,
)
console.log(`[cc-remote] permissionPolicy=${config.permissionPolicy} claudeConfigDir=${config.claudeConfigDir}`)

let shuttingDown = false
async function shutdown(reason: string): Promise<void> {
  if (shuttingDown) {
    console.warn(`[cc-remote] shutdown already in progress; repeated=${reason}`)
    return
  }
  shuttingDown = true
  const started = performance.now()
  console.log(`[cc-remote] shutdown begin reason=${reason} pid=${process.pid}`)

  // 先发起 listener/连接关闭，再清 Claude 子进程。Bun <=1.3.14 在 Windows
  // 会让这些子进程继承监听 handle；两边都完成前绝不能 process.exit()。
  let stopPromise: Promise<void>
  try {
    console.log('[cc-remote] server.stop(true) begin')
    stopPromise = Promise.resolve(server.stop(true))
  } catch (e) {
    console.error('[cc-remote] server.stop(true) invoke failed:', e)
    stopPromise = Promise.resolve()
  }

  try {
    processManager.disposeAll()
  } catch (e) {
    console.error('[cc-remote] disposeAll 失败:', e)
  }

  const timeout = new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 5_000))
  const stopped = stopPromise.then(
    () => 'stopped' as const,
    (e) => {
      console.error('[cc-remote] server.stop(true) rejected:', e)
      return 'failed' as const
    },
  )
  const result = await Promise.race([stopped, timeout])
  console.log(
    `[cc-remote] shutdown server=${result} elapsedMs=${Math.round(performance.now() - started)}`,
  )

  if (result === 'timeout') {
    // 到这里 listener 已调用 stop，强退只是最后兜底；正常路径不应触发。
    console.error('[cc-remote] shutdown timed out after 5s; forcing exit')
    process.exit(1)
  }
  logWindowsPortState('after-stop', config.port)
  console.log(`[cc-remote] shutdown complete elapsedMs=${Math.round(performance.now() - started)}`)
  process.exit(0)
}

process.on('SIGINT', () => void shutdown('SIGINT'))
process.on('SIGTERM', () => void shutdown('SIGTERM'))
process.on('exit', (code) => {
  console.log(`[cc-remote] process exit pid=${process.pid} code=${code} shuttingDown=${shuttingDown}`)
})
