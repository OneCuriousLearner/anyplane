import type { SessionInfo } from './api'

/** 会话导航：默认 push（旧会话还活着）；replace 仅用于旧 key 已作废（如 /clear 重键） */
export type NavigateSession = (s: SessionInfo, opts?: { replace?: boolean }) => void

/** 从 location.hash 解析 `#s=<key>`。损坏编码返回 null，不抛 URIError。 */
export function parseDeepLinkHash(hash: string): string | null {
  const m = hash.match(/^#s=(.+)$/)
  if (!m) return null
  try {
    return decodeURIComponent(m[1])
  } catch {
    return null
  }
}

/** 选中态对应的 URL：有 key 写 `#s=<encode>`，无 key 回到 pathname+search */
export function sessionHashUrl(key: string | undefined, path = '', search = ''): string {
  return key ? `#s=${encodeURIComponent(key)}` : path + search
}

/** hash 已是目标 key 时不要再写历史（重复点击同一会话会吞掉后退） */
export function shouldWriteHash(currentKey: string | null, nextKey: string | undefined): boolean {
  return (nextKey ?? null) !== currentKey
}
