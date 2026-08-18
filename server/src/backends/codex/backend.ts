// Codex 后端门面：AgentBackend 形状。
// sessionKey：已存在线程 `x|<threadId>`；新线程 `xn|<encodeURIComponent(cwd)>`。
// threadId 全局唯一且 thread/read 可反查 cwd，不受 claude slug 删除问题影响。

import type { SessionSummary } from '../types'
import { codexRuntime, type CodexSpawnOpts } from './runtime'

export function keyFor(threadId: string): string {
  return `x|${threadId}`
}

export function keyForNew(cwd: string): string {
  return `xn|${encodeURIComponent(cwd)}`
}

/** codex key → spawn 参数。cwd 对新线程来自 key；已有线程由 thread/read 惰性解析 */
export function parseKey(key: string): { cwd?: string; resumeThreadId?: string } | null {
  const parts = key.split('|')
  if (parts[0] === 'x' && parts.length === 2) {
    return { resumeThreadId: parts[1] }
  }
  if (parts[0] === 'xn' && parts.length === 2) {
    return { cwd: decodeURIComponent(parts[1]) }
  }
  return null
}

export function isCodexKey(key: string): boolean {
  return key.startsWith('x|') || key.startsWith('xn|')
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

export const codexBackend = {
  name: 'codex' as const,
  keyFor,
  keyForNew,
  parseKey,
  isCodexKey,
  listSessions: async (): Promise<SessionSummary[]> => {
    const threads = await codexRuntime.listThreads()
    return threads.map((t) => toSummary(t as ThreadRow))
  },
  readHistory: (threadId: string) => codexRuntime.readHistory(threadId),
  ensure: (key: string, opts: CodexSpawnOpts, cb: Parameters<typeof codexRuntime.ensure>[2]) =>
    codexRuntime.ensure(key, opts, cb),
  get: (key: string) => codexRuntime.get(key),
  dispose: (key: string) => codexRuntime.dispose(key),
  disposeAll: () => codexRuntime.disposeAll(),
}
