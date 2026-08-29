// 访问令牌管理：URL ?token= 首次注入 → localStorage 持久化 → 从地址栏抹除。
// 服务端未配置 authToken 时令牌为空即可（不鉴权）。

const STORAGE_KEY = 'anyplane-token'

export function getToken(): string | null {
  const q = new URLSearchParams(location.search).get('token')
  if (q) {
    localStorage.setItem(STORAGE_KEY, q)
    const url = new URL(location.href)
    url.searchParams.delete('token')
    history.replaceState(null, '', url.pathname + url.search + url.hash)
    return q
  }
  return localStorage.getItem(STORAGE_KEY)
}

export function setToken(t: string): void {
  localStorage.setItem(STORAGE_KEY, t)
}

export function authHeaders(): Record<string, string> {
  const t = getToken()
  return t ? { authorization: `Bearer ${t}` } : {}
}

/** 浏览器 WebSocket 握手无法自定义请求头，只能走 query */
export function wsTokenQuery(): string {
  const t = getToken()
  return t ? `?token=${encodeURIComponent(t)}` : ''
}

// 401 通知：api 层触发，App 层显示令牌输入页
let listener: (() => void) | undefined
export function onAuthRequired(fn: () => void): void {
  listener = fn
}
export function notifyAuthRequired(): void {
  listener?.()
}
