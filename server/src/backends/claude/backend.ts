// Claude 后端的 sessionKey 编解码与纯形状解析。
// sessionKey：已存在会话 `s|<slug>|<sessionId>`；新会话 `n|<encodeURIComponent(cwd)>`；
// 分叉会话 `b|<encodeURIComponent(cwd)>|<sourceSessionId>`（懒分叉：首条消息才 --fork-session）。

import { closeSync, openSync, readSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { config } from '../../config'
import type { ContextUsageInfo } from '../types'
import { listSessions, sessionMetaOf } from './discovery'
import { contextUsageOf, contextWindowOf, extractUsageFromTranscriptTail } from './processManager'
import { sessionModelOf } from './sessionModels'

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

/** parseKey 优先直读单个 transcript 头部反查 cwd，失败回退 listSessions() 全扫——
 *  slug 目录被删时 key 无法解析（已知限制）。
 *  编码段损坏（非法 % 转义）按"无法解析"处理：返回 null，由调用方走既有的错误播报路径 */
export function parseKey(key: string): ParsedKey | null {
  try {
    const parts = key.split('|')
    if (parts[0] === 's' && parts.length === 3) {
      const [, slug, sessionId] = parts
      // 快路径：直读该 transcript 头部拿 cwd（O(1) 单文件读 + memo），
      // 避免为首条消息 spawn/rewind 付出 listSessions() 全盘扫描；splitExistingKey 先过路径安全闸
      if (splitExistingKey(key)) {
        const cwd = sessionMetaOf(slug, sessionId)?.cwd
        if (cwd) return { cwd, resumeSessionId: sessionId, slug }
      }
      // 回退：全量扫描（transcript 缺失/头部 64KB 内无 cwd 字段等）
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

// ---------- 离线水合：无活进程时从 transcript 恢复上下文占用 ----------

const HYDRATE_TAIL = 768 * 1024
const hydrationCache = new Map<string, { mtimeMs: number; context: ContextUsageInfo | undefined }>()

/** 离线水合：点开会话（attach/pushStatus）但进程未 spawn 时，直读 transcript 尾部恢复
 *  上下文占用，让环形 UI 无需发消息即有数。与 spawn 内水合（processManager）同源同口径。
 *  mtime 缓存：attach/status 高频调用下每次文件变化只重读一次；仅限 s| 既有会话 key
 *  （splitExistingKey 的形状闸同时挡掉 n|/b|/codex key 与路径遍历）。
 *  调用方须自行限频——会话列表端点不可逐行调用（N 行 × 文件读）。 */
export function hydratedContextOf(key: string): ContextUsageInfo | undefined {
  const ek = splitExistingKey(key)
  if (!ek) return undefined
  const path = join(config.claudeConfigDir, 'projects', ek.slug, `${ek.sessionId}.jsonl`)
  let size: number
  let mtimeMs: number
  try {
    const st = statSync(path)
    size = st.size
    mtimeMs = st.mtimeMs
  } catch {
    return undefined
  }
  const hit = hydrationCache.get(key)
  if (hit && hit.mtimeMs === mtimeMs) return hit.context
  const context = readTailContext(path, size, ek.sessionId)
  if (hydrationCache.size > 500) hydrationCache.delete(hydrationCache.keys().next().value!)
  hydrationCache.set(key, { mtimeMs, context })
  return context
}

function readTailContext(path: string, size: number, sessionId: string): ContextUsageInfo | undefined {
  let text: string
  try {
    const fd = openSync(path, 'r')
    try {
      const buf = Buffer.alloc(Math.min(size, HYDRATE_TAIL))
      readSync(fd, buf, 0, buf.length, Math.max(0, size - buf.length))
      text = buf.toString('utf8')
    } finally {
      closeSync(fd)
    }
  } catch {
    return undefined
  }
  const u = extractUsageFromTranscriptTail(text)
  if (!u) return undefined
  // 离线无 initModel：靠 init 时持久化的 sessionId→model 表；没见过 live 的会话回退默认窗口
  return contextUsageOf(u, contextWindowOf(sessionModelOf(sessionId)))
}
