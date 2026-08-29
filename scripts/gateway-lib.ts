/** 80/443 网关的纯函数：协议探测与 dev/prod 分流。不碰网络。 */

export type Mode = 'dev' | 'prod'
export type WireProto = 'tls' | 'ssh' | 'http' | 'wait'

export const MODE_COOKIE = 'anyplane-mode'

export function detectProtocol(buf: Uint8Array): WireProto {
  if (buf.length < 3) return 'wait'
  // TLS handshake: ContentType 0x16, version 0x03 0x0x
  if (buf[0] === 0x16 && buf[1] === 0x03) return 'tls'
  // SSH-2.0-...
  if (buf[0] === 0x53 && buf[1] === 0x53 && buf[2] === 0x48) return 'ssh'
  return 'http'
}

export function hostnameOf(hostHeader: string): string {
  const raw = hostHeader.trim().toLowerCase()
  if (raw.startsWith('[')) {
    const end = raw.indexOf(']')
    return end >= 0 ? raw.slice(1, end) : raw
  }
  const colon = raw.lastIndexOf(':')
  if (colon > 0 && raw.slice(colon + 1).match(/^\d+$/)) return raw.slice(0, colon)
  return raw
}

export function parseCookieMode(cookie: string | null | undefined): Mode | undefined {
  if (!cookie) return undefined
  const m = cookie.match(/(?:^|;\s*)anyplane-mode=(dev|prod)(?:;|$)/)
  return m ? (m[1] as Mode) : undefined
}

export function isAlwaysDevHost(host: string, devHost: string): boolean {
  const h = hostnameOf(host)
  const d = hostnameOf(devHost)
  if (h === d) return true
  // 第二域名约定：anyplane-dev.* 或 dev-anyplane.*
  return h.startsWith('anyplane-dev.') || h.startsWith('dev-anyplane.')
}

export function parseQueryMode(raw: string | null | undefined): Mode | undefined {
  return raw === 'dev' || raw === 'prod' ? raw : undefined
}

/**
 * 分流优先级：
 * 1. 命中 devHost / anyplane-dev.* → 永远开发（同一浏览器可同时开两个域名）
 * 2. ?mode=dev|prod（地址栏可见）
 * 3. Cookie anyplane-mode
 * 4. 默认生产
 */
export function pickMode(
  hostHeader: string,
  cookie: string | null | undefined,
  devHost: string,
  queryMode?: string | null,
): Mode {
  if (isAlwaysDevHost(hostHeader, devHost)) return 'dev'
  return parseQueryMode(queryMode) ?? parseCookieMode(cookie) ?? 'prod'
}

export function modeCookie(mode: Mode, secure: boolean): string {
  const flags = ['Path=/', 'Max-Age=31536000', 'SameSite=Lax']
  if (secure) flags.push('Secure')
  return `${MODE_COOKIE}=${mode}; ${flags.join('; ')}`
}

/** 从 `ss -tlnp` 文本里抽出占用指定 TCP 端口的 pid（不误伤 :8080 对 :80）。 */
export function parseSsListenPids(ssOut: string, port: number): number[] {
  const pids = new Set<number>()
  const portRe = new RegExp(`(?:[:\\]])${port}(?:\\s|$)`)
  for (const line of ssOut.split('\n')) {
    if (!/\bLISTEN\b/.test(line) || !portRe.test(line)) continue
    for (const m of line.matchAll(/pid=(\d+)/g)) pids.add(Number(m[1]))
  }
  return [...pids]
}

export function isOwnGatewayCmd(cmdline: string): boolean {
  return cmdline.replace(/\0/g, ' ').includes('scripts/gateway.ts')
}
