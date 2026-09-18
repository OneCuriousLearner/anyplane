// 会话列表与管理路由：/api/sessions（GET/POST）+ archive/restore/archived/rename。
// git 分支缓存也在这里（仅列表端点使用）。

import type { ArchivedEntry, CreateSessionResponse, SessionInfo } from '@anyplane/protocol'
import { keyFor } from '../backends/claude/backend'
import { type DiscoveredSession, listSessions, sanitizePath } from '../backends/claude/discovery'
import { listSessions as listCodexSessions } from '../backends/codex/backend'
import { backendPort, portFor, type RouteResult } from '../backends/port'
import { readGitBranch } from '../fsbrowse'
import { statusOf } from '../hub/status'
import { log } from '../log'
import { json, readJsonBody } from './http'

/** RouteResult → HTTP 响应（状态码逐字保留） */
function routeResultJson(r: RouteResult): Response {
  return r.ok ? json({ ok: true }) : json({ error: r.error }, { status: r.status })
}

// ---------- /api/sessions 的 git 分支缓存 ----------
// 列表被前端轮询，每个 cwd 的分支读取是 2-3 次同步文件 IO；分支变化不需要秒级新鲜度，30s TTL。
const BRANCH_CACHE_TTL_MS = 30_000
const branchCache = new Map<string, { branch: string | undefined; at: number }>()

function branchOfCached(cwd: string | undefined, readBranch: typeof readGitBranch): string | undefined {
  if (!cwd) return undefined
  const hit = branchCache.get(cwd)
  if (hit && Date.now() - hit.at < BRANCH_CACHE_TTL_MS) return hit.branch
  const branch = readBranch(cwd) // 普通仓库与 worktree 都支持
  branchCache.set(cwd, { branch, at: Date.now() })
  return branch
}

export interface SessionRouteDeps {
  listCodexSessions: typeof listCodexSessions
  listSessions: typeof listSessions
  readGitBranch: typeof readGitBranch
  statusOf: typeof statusOf
  portFor: typeof portFor
  listCodexArchived: () => Promise<ArchivedEntry[]>
  listClaudeArchived: () => Promise<ArchivedEntry[]>
}

export const defaultSessionRouteDeps: SessionRouteDeps = {
  listCodexSessions,
  listSessions,
  readGitBranch,
  statusOf,
  portFor,
  // 经注册表取用适配器（routes 不 import 具体 port——依赖红线③）；箭头函数惰性求值，
  // 注册发生在装配层（index.ts），模块加载期不会触发未注册错误
  listCodexArchived: () => backendPort('codex').listArchived(),
  listClaudeArchived: () => backendPort('claude').listArchived(),
}

export async function handleSessionRoutes(
  req: Request,
  url: URL,
  deps: SessionRouteDeps = defaultSessionRouteDeps,
): Promise<Response | undefined> {
  if (url.pathname === '/api/sessions' && req.method === 'GET') {
    // codex RPC 与 claude 同步扫盘相互独立——先发起 RPC 再扫，墙钟取两者较大值而非相加
    //（此端点被每个打开的标签页 10s 轮询）。中间无 await，rejection 一定先于下方 catch 被接管。
    const codexP = deps.listCodexSessions()
    const sessions = deps.listSessions()
    const claudeRows: SessionInfo[] = sessions.map((s: DiscoveredSession) => ({
      ...s,
      backend: 'claude' as const,
      gitBranch: branchOfCached(s.cwd, deps.readGitBranch),
      key: keyFor(s.slug, s.sessionId),
      // listSessions 已扫过 pid 文件，复用其结果，不为每行再扫一次（null = 已知不在线）
      managed: deps.statusOf(
        keyFor(s.slug, s.sessionId),
        s.live ? { status: s.status, pid: s.live.pid } : null,
      ),
    }))
    // codex 线程：app-server 未安装/未登录时静默降级为空列表，不拖垮 claude 列表
    let codexRows: SessionInfo[] = []
    try {
      const threads = await codexP
      codexRows = threads.map((t): SessionInfo => ({
        sessionId: t.id,
        cwd: t.cwd,
        slug: 'codex',
        title: t.title,
        lastPrompt: t.lastPrompt,
        mtime: t.mtime,
        sizeBytes: 0,
        status: t.status,
        backend: 'codex' as const,
        gitBranch: branchOfCached(t.cwd, deps.readGitBranch),
        key: t.key,
        managed: deps.statusOf(t.key),
      }))
    } catch (e) {
      log.warn('[api] codex thread/list 失败（仅返回 claude 会话）:', e instanceof Error ? e.message : e)
    }
    return json([...codexRows, ...claudeRows])
  }
  if (url.pathname === '/api/sessions' && req.method === 'POST') {
    const body = await readJsonBody<{ cwd?: string; backend?: string }>(req)
    if (!body.cwd) return json({ error: '缺少 cwd' }, { status: 400 })
    // 新会话 key 构造经适配器（keyForNew 是 port 契约），routes 不 import 后端 key 构造函数
    const port = backendPort(body.backend === 'codex' ? 'codex' : 'claude')
    const res: CreateSessionResponse = {
      key: port.keyForNew(body.cwd),
      slug: port.name === 'codex' ? 'codex' : sanitizePath(body.cwd),
      backend: port.name,
    }
    return json(res)
  }
  if (url.pathname === '/api/sessions/archive' && req.method === 'POST') {
    const body = await readJsonBody<{ key?: string }>(req)
    if (!body.key) return json({ error: '缺少 key' }, { status: 400 })
    return routeResultJson(await deps.portFor(body.key).archive(body.key))
  }
  if (url.pathname === '/api/sessions/restore' && req.method === 'POST') {
    const body = await readJsonBody<{ key?: string }>(req)
    if (!body.key) return json({ error: '缺少 key' }, { status: 400 })
    return routeResultJson(await deps.portFor(body.key).restore(body.key))
  }
  // 归档/回收站列表：两后端各自经 port 提供（codex archived + claude trash），
  // 单后端失败在适配器内降级为空数组，互不拖垮
  if (url.pathname === '/api/sessions/archived' && req.method === 'GET') {
    const [codexArchived, claudeTrash] = await Promise.all([
      deps.listCodexArchived(),
      deps.listClaudeArchived(),
    ])
    return json({ entries: [...codexArchived, ...claudeTrash] })
  }
  if (url.pathname === '/api/sessions/rename' && req.method === 'POST') {
    const body = await readJsonBody<{ key?: string; title?: string }>(req)
    const title = body.title?.trim()
    if (!body.key || !title) return json({ error: '缺少 key 或 title' }, { status: 400 })
    // codex 走官方 thread/name/set；claude 仅离线会话（transcript 追加 custom-title），
    // 两路实现见各自适配器
    return routeResultJson(await deps.portFor(body.key).rename(body.key, title))
  }
  return undefined
}
