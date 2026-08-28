// 访问控制：未配置 authToken 时仅限回环使用（不鉴权）；
// 配置后 /api 与 /ws 一律要求 `Authorization: Bearer <token>` 或 `?token=<token>`。
// 静态前端壳不鉴权（JS 中无敏感数据），数据面与控制面全部受保护。

import { config } from './config'

export function isLoopbackHost(host: string): boolean {
  return host === '127.0.0.1' || host === 'localhost' || host === '::1'
}

export function isAuthorized(req: Request, url: URL): boolean {
  if (!config.authToken) return true
  if (req.headers.get('authorization') === `Bearer ${config.authToken}`) return true
  // WS 握手无法自定义请求头，浏览器端只能走 query
  if (url.searchParams.get('token') === config.authToken) return true
  return false
}

// ---------- 跨源防护（无 token 回环部署的浏览器攻击面） ----------
// WebSocket 不受同源策略约束、text/plain 简单请求不触发 preflight——
// 默认无 token 时恶意网页可经受害者浏览器直连回环服务（CSWSH/CSRF → RCE）；
// DNS rebinding 则让攻击者域名解析到 127.0.0.1，把跨源变成"同源"（靠 Host 回环白名单封堵）。
// 浏览器在 WS 握手与跨源 POST 时必定携带 Origin；非浏览器客户端（e2e 脚本/curl）不带。
// 配置 authToken 后 token 即防线，以下检查不生效（行为与旧版完全一致）。

/** Host 头去端口（兼容 [::1]:7480 形态） */
export function hostNameOf(hostHeader: string): string {
  if (hostHeader.startsWith('[')) {
    const close = hostHeader.indexOf(']')
    // 缺少闭合方括号的 IPv6 Host 头按无效处理，避免 slice(1, -1) 截断后误判为回环
    if (close === -1) return hostHeader
    return hostHeader.slice(1, close)
  }
  const i = hostHeader.lastIndexOf(':')
  return i > 0 ? hostHeader.slice(0, i) : hostHeader
}

export function isLoopbackHostname(h: string): boolean {
  // WHATWG URL 的 IPv6 hostname 保留方括号（http://[::1]:9001 → "[::1]"）
  const n = h.startsWith('[') && h.endsWith(']') ? h.slice(1, -1) : h
  if (n === 'localhost' || n === '::1') return true
  // 127.0.0.0/8 必须是合法 IPv4 地址，避免 127.evil.com 这类 DNS 名绕过
  return /^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.test(n) && n.split('.').slice(1).every((octet) => {
    const v = Number(octet)
    return v >= 0 && v <= 255
  })
}

/** Host 头必须是回环地址（无 token 模式的 DNS rebinding 防线）。
 *  Origin↔Host 一致性挡不住 rebinding：攻击者域名 rebind 到 127.0.0.1 后，浏览器发出的是
 *  同源请求，Origin 与 Host 同为攻击者域名，恰好命中 originAllowed 的"相同放行"分支。
 *  Host 是浏览器禁改头（forbidden header），攻击者页面无法让它谎称回环；
 *  无 token 时启动闸已保证只绑回环，合法浏览器入口（直连/Vite 代理/SSH 转发）Host 必然回环。
 *  缺 Host 头放行（HTTP/1.0、非浏览器客户端；浏览器必定携带）。 */
export function hostAllowed(req: Request): boolean {
  const host = req.headers.get('host')
  if (!host) return true
  return isLoopbackHostname(hostNameOf(host))
}

/** Origin 与 Host 同 host，或同为回环（dev 模式 Vite :5173 代理到 server :7480 的端口差） */
export function originAllowed(req: Request): boolean {
  const origin = req.headers.get('origin')
  if (!origin) return true // 非浏览器客户端；浏览器必带 Origin
  if (origin === 'null') return false // 沙箱 iframe / file:// 页面（浏览器特征）
  const host = req.headers.get('host') ?? ''
  let o: URL
  try {
    o = new URL(origin)
  } catch {
    return false
  }
  if (o.host === host) return true
  return isLoopbackHostname(o.hostname) && isLoopbackHostname(hostNameOf(host))
}

/** 状态变更 /api 请求必须是 application/json——text/plain 是 preflight 豁免的 CSRF 通道 */
export function jsonContentTypeRequired(req: Request, url: URL): boolean {
  if (req.method === 'GET' || req.method === 'HEAD') return true
  if (!url.pathname.startsWith('/api/')) return true
  const ct = req.headers.get('content-type')?.split(';')[0].trim()
  return ct === 'application/json'
}
