// 会话列表与管理路由：/api/sessions（GET/POST）+ archive/restore/archived/rename。
// git 信息缓存也在这里（仅列表端点使用）。

import type { ArchivedEntry, CreateSessionResponse, SessionInfo } from '@anyplane/protocol'
import { backendPort, portFor, sessionCwdOf, slugForBackend, type RouteResult } from '../backends/port'
import type { SessionSummary } from '../backends/types'
import { isAbsolutePath } from '../approvalSummary'
import { type GitInfo, readGitInfo } from '../fsbrowse'
import { addWorktree, gitAvailable, removeWorktree, statusSummaryOf } from '../gitworktree'
import { hubs } from '../hub/registry'
import { statusOf } from '../hub/status'
import { log } from '../log'
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { json, readJsonBody } from './http'
import { noteWorktree, worktreeOwnerOf } from '../worktreeOwners'

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

/** 行的 worktree 归属与目录存活信号：实时读盘优先，已删目录回落归属侧车（09-27 专项
 *  缺口 3——目录一删 worktreeOf 归零、会话退化裸组）。发现 worktreeOf 时顺带记侧车；
 *  dirExists 只在明确不存在时置 false（缺席 = 存在/未知，省载荷）。两后端行共用 */
function enrichGitFields(cwd: string | undefined, git: GitInfo | undefined): { worktreeOf?: string; dirExists?: boolean } {
  if (!cwd) return {}
  if (git?.worktreeOf) noteWorktree(cwd, git.worktreeOf)
  return {
    worktreeOf: git?.worktreeOf ?? worktreeOwnerOf(cwd),
    ...(existsSync(cwd) ? {} : { dirExists: false as const }),
  }
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
        ...enrichGitFields(s.cwd, git),
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
          ...enrichGitFields(t.cwd, git),
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
    // 合并后按 mtime 全局降序：此前 [...codexRows, ...claudeRows] 拼接让列表分组顺序
    // 变成「先 Codex 目录后 Claude 目录」，刚建的会话沉在视口外（走查问题 1）。
    // 各后端内部已按 mtime 排好，这里只做一次合并排序（~200 行量级，成本可忽略）
    return json([...codexRows, ...claudeRows].sort((a, b) => b.mtime - a.mtime))
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

  // ---------- worktree 生命周期（E1） ----------
  // git 缺席整个功能降级（前端入口隐藏同理）；来源无关——不区分 worktree 来自用户终端、
  // AnyPlane 创建、还是 agent 会话内自建，校验一律走 readGitInfo。

  /** git 可用性探测（DirPicker「拉 worktree 开会话」入口的隐藏判定） */
  if (url.pathname === '/api/worktree/git-available' && req.method === 'GET') {
    return json({ available: gitAvailable() })
  }

  /** 会话 cwd 反查（E2/E3 共用）：同步链走 port 的 sessionCwdOf（spawnOpts > key 内嵌 >
   *  handoffSource 反查），本函数只加 **listSessions 行反查**异步兜底（x| codex 线程——
   *  列表端点每行都有 cwd，与列表页数据源一致；thread/read 对部分老线程拿不到 cwd，review 轮
   *  用户实测 codex x| 盲区定位）。key 反查是会话相关文件系统端点的唯一入口——不接任意路径。 */
  async function cwdOfKey(key: string): Promise<string | undefined> {
    const sync = sessionCwdOf(key, hubs.get(key)?.spawnOpts?.cwd)
    if (sync) return sync
    // x| codex（及 s| 反查失败的兜底）：按 key 在列表行里找 cwd
    try {
      const rows = await deps.listCodexSessions()
      const hit = rows.find((r) => r.key === key)
      if (hit?.cwd) return hit.cwd
    } catch {
      // codex 列表失败（未装/未登录）——claude 行兜底
    }
    try {
      const rows = await deps.listSessions()
      return rows.find((r) => r.key === key)?.cwd
    } catch {
      return undefined
    }
  }

  /** E2 改动摘要：非 git 目录/git 缺席/git 失败 → available:false，前端隐藏「改动」页签。
   *  不做 gitAvailable() 前置探测——statusSummaryOf 的 spawn 失败承载同一判定（git 缺席 =
   *  非零退出），5s 轮询热路径每次省一次同步 spawn（探测结果在轮询间隔内也不会变） */
  if (url.pathname === '/api/sessions/git-status' && req.method === 'GET') {
    const key = url.searchParams.get('key') ?? ''
    if (!key) return json({ error: '缺少 key' }, { status: 400 })
    const cwd = await cwdOfKey(key)
    if (!cwd) return json({ available: false })
    const summary = statusSummaryOf(cwd)
    if (!summary) return json({ available: false })
    return json({ available: true, cwd, ...summary })
  }

  /** E3 @ 文件补全：会话 cwd 单层列举 + 前缀过滤。**root 服务端按 key 锁定**——prefix 只允许
   *  相对名（禁 `../`、绝对路径、盘符），防任意目录探测。文件与目录都出（目录带 / 后缀可续探）；
   *  隐藏文件（.开头）默认不出（避免 .git/.env 噪音），prefix 以 . 开头才出。 */
  if (url.pathname === '/api/sessions/fs-complete' && req.method === 'GET') {
    const key = url.searchParams.get('key') ?? ''
    if (!key) return json({ error: '缺少 key' }, { status: 400 })
    const rawPrefix = url.searchParams.get('prefix') ?? ''
    // 注入闸：禁 ../ 与绝对路径（Windows 盘符/UNC/POSIX 根）——searchParams 已解一次码，
    // 对「再解码一次」的变体也判（双重编码绕过：..%2F 经一次解码后是字面 ..%2F，闸漏过，
    // 下游若再解码即成 ../，review 轮自测实锤）
    const dec = (() => {
      try {
        return decodeURIComponent(rawPrefix)
      } catch {
        return rawPrefix
      }
    })()
    const isTraversal = (p: string) => /(?:^|[\\/])\.\.(?:[\\/]|$)/.test(p) || isAbsolutePath(p)
    if (isTraversal(rawPrefix) || isTraversal(dec)) {
      return json({ error: 'prefix 只允许会话目录内的相对前缀' }, { status: 400 })
    }
    const cwd = await cwdOfKey(key)
    if (!cwd) return json({ available: false })
    try {
      const norm = rawPrefix.replace(/\\/g, '/')
      // prefix 可含子目录（src/comp）——列出其所在子目录，按最后一段过滤
      const slash = norm.lastIndexOf('/')
      const dirPart = slash >= 0 ? norm.slice(0, slash) : ''
      const basePart = slash >= 0 ? norm.slice(slash + 1) : norm
      const target = dirPart ? join(cwd, ...dirPart.split('/')) : cwd
      const dirents = readdirSync(target, { withFileTypes: true })
      const showHidden = basePart.startsWith('.')
      const entries = dirents
        .filter((d) => (showHidden ? true : !d.name.startsWith('.')))
        .filter((d) => d.name.toLowerCase().startsWith(basePart.toLowerCase()))
        .map((d) => ({
          name: d.name,
          path: dirPart ? `${dirPart}/${d.name}` : d.name,
          dir: d.isDirectory(),
        }))
        .sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name))
        .slice(0, 50)
      return json({ available: true, entries })
    } catch (e) {
      log.warn(`[api] fs-complete 列举失败 key=${key} cwd=${cwd} prefix=${rawPrefix}:`, e)
      return json({ available: false })
    }
  }

  /** 创建：`git worktree add` 落盘主仓同级 <repo>-<名>、分支 worktree-<名>，直接开新会话 */
  if (url.pathname === '/api/worktree/add' && req.method === 'POST') {
    const body = await readJsonBody<{ cwd?: string; name?: string; backend?: string }>(req)
    if (!body.cwd || !body.name) return json({ error: '缺少 cwd 或 name' }, { status: 400 })
    if (!gitAvailable()) return json({ error: 'git 不可用' }, { status: 400 })
    const git = deps.readGitInfo(body.cwd)
    if (!git) return json({ error: '所选目录不是 git 仓库' }, { status: 400 })
    const mainRoot = git.worktreeOf ?? body.cwd // 在 worktree 里也能再拉：归一到主仓
    const r = addWorktree(mainRoot, body.name.trim())
    if (!r.ok || !r.path) return json({ error: r.error ?? 'git worktree add 失败' }, { status: 400 })
    noteWorktree(r.path, mainRoot) // 归属侧车立即记（列表页合并分组不等首次轮询发现）
    const port = backendPort(body.backend === 'codex' ? 'codex' : 'claude')
    return json({
      path: r.path,
      branch: r.branch,
      key: port.keyForNew(r.path),
      backend: port.name,
    })
  }

  /** 按 cwd 收集在册会话 key（worktree 移除前的 busy 检查与 dispose 对象）：
   *  前缀匹配——worktree 根与其任何子目录的会话都算（子目录进程同样持有树锁，review 轮） */
  function sessionKeysForCwd(cwd: string): string[] {
    const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
    const target = norm(cwd)
    const out: string[] = []
    for (const [key, hub] of hubs) {
      const hubCwd = sessionCwdOf(key, hub.spawnOpts?.cwd)
      if (hubCwd) {
        const c = norm(hubCwd)
        if (c === target || c.startsWith(`${target}/`)) out.push(key)
      }
    }
    return out
  }

  /** 移除：readGitInfo 校验 cwd 确为 worktree → busy 拒绝 → 先试 git worktree remove（不 dispose）
   *  → 占用/锁失败且树干净才 dispose 会话进程重试（顺序优势：杀进程才解 Windows 目录锁；
   *  成功/ dirty 升级时一个不杀——不再「失败也白杀全部会话」，review 轮）。
   *  dirty 两步走：409 携带脏区统计（N 已修改/M 未跟踪），前端确认「丢弃未提交改动」后
   *  以 force=true 调第二步（同样先试，占用则 dispose 重试）——绝不静默 --force。不碰分支。 */
  if (url.pathname === '/api/worktree/remove' && req.method === 'POST') {
    const body = await readJsonBody<{ cwd?: string; force?: boolean }>(req)
    if (!body.cwd) return json({ error: '缺少 cwd' }, { status: 400 })
    if (!gitAvailable()) return json({ error: 'git 不可用' }, { status: 400 })
    const git = deps.readGitInfo(body.cwd)
    if (!git?.worktreeOf) return json({ error: '所选目录不是 worktree（或目录不存在）' }, { status: 400 })
    const keys = sessionKeysForCwd(body.cwd)
    // busy 拒绝并提示先中断（E1 已确认）：running/requires_action 绝不强删
    const busyKeys = keys.filter((k) => deps.portFor(k).sessionOf(k)?.busy)
    if (busyKeys.length > 0) {
      return json({ error: `该 worktree 有 ${busyKeys.length} 个会话正在工作，请先中断再移除` }, { status: 409 })
    }
    const force = body.force === true
    // 先试不 dispose（成功/干净失败/dirty 升级都不杀会话——dirty 第一步、占用误判都保活）
    let r = removeWorktree(git.worktreeOf, body.cwd, force)
    // 占用/锁失败（非 dirty）且树干净：dispose 该 cwd 全部会话进程（杀进程解 Windows 目录锁）重试一次
    if (!r.ok && !r.dirty) {
      for (const k of keys) deps.portFor(k).disposeSession(k)
      r = removeWorktree(git.worktreeOf, body.cwd, force)
    }
    if (!r.ok) {
      if (r.dirty) {
        return json({ error: r.error ?? 'worktree 有未提交改动', dirty: r.dirty }, { status: 409 })
      }
      return json({ error: r.error ?? 'git worktree remove 失败' }, { status: 400 })
    }
    log.info(`[worktree] 已移除 ${body.cwd}（分支保留，归属侧车不清理）`)
    return json({ ok: true })
  }
  return undefined
}
