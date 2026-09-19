// Codex 后端的 sessionKey 编解码与会话列表/历史门面。
// sessionKey：已存在线程 `x|<threadId>`；新线程 `xn|<encodeURIComponent(cwd)>`。
// threadId 全局唯一且 thread/read 可反查 cwd，不受 claude slug 删除问题影响。

import type { HistoryMessage } from '@anyplane/protocol'
import type { SessionSummary } from '../types'
import { log } from '../../log'
import { listThreadsFromDisk } from './discovery'
import { codexRuntime } from './runtime'

export function keyFor(threadId: string): string {
  return `x|${threadId}`
}

export function keyForNew(cwd: string): string {
  return `xn|${encodeURIComponent(cwd)}`
}

/** codex key → spawn 参数。cwd 对新线程来自 key；已有线程由 thread/read 惰性解析。
 *  编码段损坏（非法 % 转义）按"无法解析"处理：返回 null */
export function parseKey(key: string): { cwd?: string; resumeThreadId?: string } | null {
  try {
    const parts = key.split('|')
    if (parts[0] === 'x' && parts.length === 2) {
      return { resumeThreadId: parts[1] }
    }
    if (parts[0] === 'xn' && parts.length === 2) {
      return { cwd: decodeURIComponent(parts[1]) }
    }
    return null
  } catch {
    return null
  }
}

export { isCodexKey } from '../port'

/** x|threadId 的纯形状解析（xn| 新线程无 threadId，返回 undefined） */
export function splitThreadId(key: string): string | undefined {
  const parts = key.split('|')
  return parts[0] === 'x' && parts.length === 2 ? parts[1] : undefined
}

interface ThreadRow {
  id?: string
  preview?: string
  cwd?: string
  updatedAt?: number
  createdAt?: number
  status?: { type?: string }
  name?: string | null
}

function toSummary(t: ThreadRow): SessionSummary {
  const st = t.status?.type
  return {
    backend: 'codex',
    key: keyFor(String(t.id)),
    id: String(t.id),
    cwd: t.cwd,
    title: t.name ?? undefined,
    lastPrompt: t.preview,
    mtime: (t.updatedAt ?? t.createdAt ?? 0) * 1000,
    status: st === 'active' ? 'busy' : st === 'idle' ? 'idle' : 'offline',
  }
}

/** /api/sessions 每个打开的标签页 10s 轮询一次；短 TTL 缓存削峰（新建线程最坏晚 5s 进列表，可接受） */
const LIST_TTL_MS = 5000
let listCache: { at: number; rows: SessionSummary[] } | undefined

// 会话发现双轨（懒 spawn 红线：绝不只为列表拉起 app-server）：
//   ① app-server 已运行（有 live 会话）→ RPC 全保真（含 live status）
//   ② 未运行 → 读盘（rollout 头 + session_index），零进程
//   ③ 读盘格式漂移/损坏 → RPC 兜底（=旧行为，会拉起进程），失败退避 60s 防崩溃重试循环
// 退避按列表类型分开：active 列表的一次失败不该把 archived 页的兜底也拖睡 60s
const RPC_FALLBACK_BACKOFF_MS = 60_000
const rpcFallbackNotBefore = { active: 0, archived: 0 }

async function rpcRowsWithBackoff(archived: boolean): Promise<ThreadRow[]> {
  const key = archived ? 'archived' : 'active'
  if (Date.now() < rpcFallbackNotBefore[key]) return []
  try {
    const rows = archived
      ? (((await codexRuntime.listThreadsArchived()) as ThreadRow[]) ?? [])
      : ((await codexRuntime.listThreads()) as ThreadRow[])
    rpcFallbackNotBefore[key] = 0
    return rows
  } catch (e) {
    rpcFallbackNotBefore[key] = Date.now() + RPC_FALLBACK_BACKOFF_MS
    throw e
  }
}

/** 同 thread id 去重（updatedAt 降序输入）：resume 续跑在多轨都可能产生同 id 多行
 *  （读盘轨在 discovery 内已去过一道；live/RPC 轨上游 fs-scan 按文件出项也会重）。
 *  双轨在同一汇聚点去重，卡片数不随所走轨道翻转；createdAt 取更早者。 */
function dedupRows(rows: ThreadRow[]): ThreadRow[] {
  const byId = new Map<string, ThreadRow>()
  for (const r of rows) {
    const id = String(r.id)
    const existing = byId.get(id)
    if (!existing) {
      byId.set(id, { ...r })
      continue
    }
    if (!existing.preview && r.preview) existing.preview = r.preview
    if (r.createdAt && (!existing.createdAt || r.createdAt < existing.createdAt)) existing.createdAt = r.createdAt
  }
  return [...byId.values()]
}

async function listRows(archived: boolean): Promise<ThreadRow[]> {
  // live 路径失败（超时/进程中途退出/过载重试耗尽）必须能落到零进程的读盘轨，
  // 而不是把整个 codex 区抛空（routes 的 catch 只兜底成空列表）
  try {
    const live = await codexRuntime.listThreadsIfLive({ archived })
    if (live) return dedupRows(live as ThreadRow[])
  } catch (e) {
    log.warn('[codex] live RPC 列表失败，降级读盘:', e instanceof Error ? e.message : e)
  }
  try {
    return await listThreadsFromDisk(codexRuntime.home, { archived })
  } catch (e) {
    // 磁盘格式是内部实现不是协议面：漂移宁可回退 RPC（拉起进程）也不许静默空列表
    log.warn('[codex] 磁盘会话发现失败，回退 RPC（可能是上游格式漂移）:', e instanceof Error ? e.message : e)
    return dedupRows(await rpcRowsWithBackoff(archived))
  }
}

export async function listSessions(): Promise<SessionSummary[]> {
  if (listCache && Date.now() - listCache.at < LIST_TTL_MS) return listCache.rows
  const rows = (await listRows(false)).map(toSummary)
  listCache = { at: Date.now(), rows }
  return rows
}

/** 归档线程列表（/api/sessions/archived）：与活跃列表共用 toSummary 唯一映射，
 *  避免 wire 形状变化时两处漂移。不走 listSessions 的 TTL 缓存——归档页低频。 */
export async function listArchivedSessions(): Promise<SessionSummary[]> {
  return (await listRows(true)).map(toSummary)
}

export function readHistory(threadId: string): Promise<HistoryMessage[]> {
  return codexRuntime.readHistory(threadId)
}
