// 会话列表与管理路由：/api/sessions（GET/POST）+ archive/restore/archived/rename。
// git 分支缓存也在这里（仅列表端点使用）。

import { keyFor, keyForNew } from '../backends/claude/backend'
import { listSessions, sanitizePath, type SessionInfo } from '../backends/claude/discovery'
import { keyForNew as codexKeyForNew, listSessions as listCodexSessions } from '../backends/codex/backend'
import { claudePort } from '../backends/claude/port'
import { codexPort } from '../backends/codex/port'
import { portFor, type RouteResult } from '../backends/port'
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

function branchOfCached(cwd?: string): string | undefined {
  if (!cwd) return undefined
  const hit = branchCache.get(cwd)
  if (hit && Date.now() - hit.at < BRANCH_CACHE_TTL_MS) return hit.branch
  const branch = readGitBranch(cwd) // 普通仓库与 worktree 都支持
  branchCache.set(cwd, { branch, at: Date.now() })
  return branch
}

export async function handleSessionRoutes(req: Request, url: URL): Promise<Response | undefined> {
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
  if (url.pathname === '/api/sessions/archive' && req.method === 'POST') {
    const body = await readJsonBody<{ key?: string }>(req)
    if (!body.key) return json({ error: '缺少 key' }, { status: 400 })
    return routeResultJson(await portFor(body.key).archive(body.key))
  }
  if (url.pathname === '/api/sessions/restore' && req.method === 'POST') {
    const body = await readJsonBody<{ key?: string }>(req)
    if (!body.key) return json({ error: '缺少 key' }, { status: 400 })
    return routeResultJson(await portFor(body.key).restore(body.key))
  }
  // 归档/回收站列表：两后端各自经 port 提供（codex archived + claude trash），
  // 单后端失败在适配器内降级为空数组，互不拖垮
  if (url.pathname === '/api/sessions/archived' && req.method === 'GET') {
    const [codexArchived, claudeTrash] = await Promise.all([
      codexPort.listArchived(),
      claudePort.listArchived(),
    ])
    return json({ entries: [...codexArchived, ...claudeTrash] })
  }
  if (url.pathname === '/api/sessions/rename' && req.method === 'POST') {
    const body = await readJsonBody<{ key?: string; title?: string }>(req)
    const title = body.title?.trim()
    if (!body.key || !title) return json({ error: '缺少 key 或 title' }, { status: 400 })
    // codex 走官方 thread/name/set；claude 仅离线会话（transcript 追加 custom-title），
    // 两路实现见各自适配器
    return routeResultJson(await portFor(body.key).rename(body.key, title))
  }
  return undefined
}
