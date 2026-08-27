// Codex 后端的 sessionKey 编解码与会话列表/历史门面。
// sessionKey：已存在线程 `x|<threadId>`；新线程 `xn|<encodeURIComponent(cwd)>`。
// threadId 全局唯一且 thread/read 可反查 cwd，不受 claude slug 删除问题影响。

import type { SessionSummary, HistoryMessage } from '../types'
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

export function isCodexKey(key: string): boolean {
  return key.startsWith('x|') || key.startsWith('xn|')
}

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

export async function listSessions(): Promise<SessionSummary[]> {
  const threads = await codexRuntime.listThreads()
  return threads.map((t) => toSummary(t as ThreadRow))
}

export function readHistory(threadId: string): Promise<HistoryMessage[]> {
  return codexRuntime.readHistory(threadId)
}
