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
