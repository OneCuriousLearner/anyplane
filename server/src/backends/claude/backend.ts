// Claude 后端门面：把 discovery / processManager / tailer 收敛为 AgentBackend 形状。
// sessionKey：已存在会话 `s|<slug>|<sessionId>`；新会话 `n|<encodeURIComponent(cwd)>`；
// 分叉会话 `b|<encodeURIComponent(cwd)>|<sourceSessionId>`（懒分叉：首条消息才 --fork-session）。

import { config } from '../../config'
import type { SessionSummary } from '../types'
import {
  listSessions,
  liveSessionInfo,
  readHistory,
  sanitizePath,
  type SessionInfo,
} from './discovery'
import { processManager } from './processManager'

export function keyFor(slug: string, sessionId: string): string {
  return `s|${slug}|${sessionId}`
}

export function keyForNew(cwd: string): string {
  return `n|${encodeURIComponent(cwd)}`
}

export function keyForBranch(cwd: string, sourceSessionId: string): string {
  return `b|${encodeURIComponent(cwd)}|${sourceSessionId}`
}

export interface ParsedKey {
  cwd: string
  resumeSessionId?: string
  slug?: string
  /** b| 分叉：首条消息 spawn 时以此为 --fork-session --resume 的源 */
  forkFromSessionId?: string
}

/** parseKey 靠 listSessions() 反查 cwd——slug 目录被删时 key 无法解析（已知限制）。
 *  编码段损坏（非法 % 转义）按"无法解析"处理：返回 null，由调用方走既有的错误播报路径 */
export function parseKey(key: string): ParsedKey | null {
  try {
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
    if (parts[0] === 'b' && parts.length === 3) {
      return { cwd: decodeURIComponent(parts[1]), forkFromSessionId: parts[2] }
    }
    return null
  } catch {
    return null
  }
}

/** s|slug|sid 的纯形状解析：不做 listSessions() 反查（零 I/O），只需 slug/sessionId 的场景用。
 *  安全闸：slug 是 sanitizePath 产物（仅 [a-zA-Z0-9-]），sessionId 同理限定——
 *  两段都会被拼进 ~/.claude/projects/ 下的文件路径，必须拒绝 `..` / 分隔符（路径遍历）。 */
export function splitExistingKey(key: string): { slug: string; sessionId: string } | null {
  const parts = key.split('|')
  if (parts[0] !== 's' || parts.length !== 3) return null
  const [, slug, sessionId] = parts
  if (!/^[a-zA-Z0-9-]+$/.test(slug) || !/^[a-zA-Z0-9-]+$/.test(sessionId)) return null
  return { slug, sessionId }
}

function toSummary(s: SessionInfo): SessionSummary {
  return {
    backend: 'claude',
    key: keyFor(s.slug, s.sessionId),
    id: s.sessionId,
    slug: s.slug,
    cwd: s.cwd,
    title: s.title,
    lastPrompt: s.lastPrompt,
    mtime: s.mtime,
    sizeBytes: s.sizeBytes,
    status: s.status,
    live: s.live,
  }
}

export const claudeBackend = {
  name: 'claude' as const,
  keyFor,
  keyForNew,
  keyForBranch,
  parseKey,
  listSessions: (): SessionSummary[] => listSessions().map(toSummary),
  readHistory,
  liveSessionInfo,
  sanitizePath,
  ensure: (key: string, opts: Parameters<typeof processManager.ensure>[1], cb: Parameters<typeof processManager.ensure>[2]) =>
    processManager.ensure(key, opts, cb),
  get: (key: string) => processManager.get(key),
  dispose: (key: string) => processManager.dispose(key),
  disposeAll: () => processManager.disposeAll(),
}

export { config }
