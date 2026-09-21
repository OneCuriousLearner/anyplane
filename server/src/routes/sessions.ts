// 会话列表与管理路由：/api/sessions（GET/POST）+ archive/restore/archived/rename。
// git 信息缓存也在这里（仅列表端点使用）。

import type { ArchivedEntry, CreateSessionResponse, SessionInfo } from '@anyplane/protocol'
import { backendPort, portFor, slugForBackend, type RouteResult } from '../backends/port'
import type { SessionSummary } from '../backends/types'
import { type GitInfo, readGitInfo } from '../fsbrowse'
import { statusOf } from '../hub/status'
import { log } from '../log'
import { json, readJsonBody } from './http'

/** RouteResult → HTTP 响应（状态码逐字保留） */
function routeResultJson(r: RouteResult): Response {
  return r.ok ? json({ ok: true }) : json({ error: r.error }, { status: r.status })
}

// ---------- /api/sessions 的 git 信息缓存 ----------
// 列表被前端轮询，每个 cwd 的读取是 2-3 次同步文件 IO；分支变化不需要秒级新鲜度，30s TTL。
const BRANCH_CACHE_TTL_MS = 30_000
const gitInfoCache = new Map<string, { info: GitInfo | undefined; at: number }>()

function gitInfoOfCached(cwd: string | undefined, read: typeof readGitInfo): GitInfo | undefined {
  if (!cwd) return undefined
  const hit = gitInfoCache.get(cwd)
  if (hit && Date.now() - hit.at < BRANCH_CACHE_TTL_MS) return hit.info
  const info = read(cwd) // 普通仓库与 worktree 都支持
  gitInfoCache.set(cwd, { info, at: Date.now() })
  return info
}

export interface SessionRouteDeps {
  listCodexSessions: () => Promise<SessionSummary[]>
  listSessions: () => Promise<SessionSummary[]> | SessionSummary[]
  readGitInfo: typeof readGitInfo
  statusOf: typeof statusOf
  portFor: typeof portFor
  listCodexArchived: () => Promise<ArchivedEntry[]>
  listClaudeArchived: () => Promise<ArchivedEntry[]>
}

export const defaultSessionRouteDeps: SessionRouteDeps = {
  // 经注册表取用适配器（routes 不 import 具体后端——依赖红线③）；箭头函数惰性求值，
  // 注册发生在装配层（index.ts），模块加载期不会触发未注册错误
  listCodexSessions: () => backendPort('codex').listSessions(),
  listSessions: () => backendPort('claude').listSessions(),
  readGitInfo,
  statusOf,
  portFor,
  listCodexArchived: () => backendPort('codex').listArchived(),
  listClaudeArchived: () => backendPort('claude').listArchived(),
}

export async function handleSessionRoutes(
  req: Request,
  url: URL,
  deps: SessionRouteDeps = defaultSessionRouteDeps,
): Promise<Response | undefined> {
  if (url.pathname === '/api/sessions' && req.method === 'GET') {
    // 两边同时发起，墙钟取较大值。allSettled 立刻给两边挂上 handler——
    // 先 await 一侧再 catch 另一侧会在间隔里冒 unhandledRejection（本仓当致命退出）。
    // Claude 失败仍上抛；Codex 失败只降级空列表。
    const [claudeResult, codexResult] = await Promise.allSettled([
      Promise.resolve(deps.listSessions()),
      deps.listCodexSessions(),
    ])
    if (claudeResult.status === 'rejected') throw claudeResult.reason
    const sessions = claudeResult.value
    const claudeRows: SessionInfo[] = sessions.map((s) => {
      const git = gitInfoOfCached(s.cwd, deps.readGitInfo)
      return {
        sessionId: s.id,
        cwd: s.cwd,
        slug: s.slug ?? '',
        title: s.title,
        lastPrompt: s.lastPrompt,
        mtime: s.mtime,
        sizeBytes: s.sizeBytes ?? 0,
        status: s.status,
        live: s.live,
        backend: 'claude' as const,
        gitBranch: git?.branch,
        worktreeOf: git?.worktreeOf,
        key: s.key,
        // listSessions 已扫过 pid 文件，复用其结果，不为每行再扫一次（null = 已知不在线）
        managed: deps.statusOf(
          s.key,
          s.live ? { status: s.status, pid: s.live.pid } : null,
        ),
      }
    })
    // codex 线程：app-server 未安装/未登录时静默降级为空列表，不拖垮 claude 列表
    let codexRows: SessionInfo[] = []
    if (codexResult.status === 'fulfilled') {
      codexRows = codexResult.value.map((t): SessionInfo => {
        const git = gitInfoOfCached(t.cwd, deps.readGitInfo)
        return {
          sessionId: t.id,
          cwd: t.cwd,
          slug: 'codex',
          title: t.title,
          lastPrompt: t.lastPrompt,
          mtime: t.mtime,
          sizeBytes: 0,
          status: t.status,
          backend: 'codex' as const,
          gitBranch: git?.branch,
          worktreeOf: git?.worktreeOf,
          key: t.key,
          managed: deps.statusOf(t.key),
        }
      })
    } else {
      log.warn(
        '[api] codex thread/list 失败（仅返回 claude 会话）:',
        codexResult.reason instanceof Error ? codexResult.reason.message : codexResult.reason,
      )
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
      slug: slugForBackend(port.name, body.cwd),
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
