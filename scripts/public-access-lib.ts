// 公网配方一键脚本的纯逻辑：参数解析、Caddyfile 渲染、token 解析。
// 与 public-access.ts 的副作用层分离（gateway.ts/gateway-lib.ts 同款拆分），便于 bun test 锁定。

export type Recipe = 'funnel' | 'cf-quick' | 'caddy'

export interface PublicAccessArgs {
  recipe: Recipe
  /** caddy 配方必需：DDNS 已指向本机的域名 */
  domain?: string
  /** 反代目标端口（缺省读 config；显式 --port 优先） */
  port?: number
  /** caddy 入站端口（默认 8443：家宽 80/443 入站常被运营商过滤） */
  httpsPort: number
}

export const USAGE = `AnyPlane 公网接入一键脚本（封装 docs/public-access.md 三套配方的最小命令）

用法:
  bun run public-access funnel                  Tailscale funnel（一条命令，需 /dev/net/tun）
  bun run public-access cf-quick                Cloudflare 临时隧道（零账号，域名每次重启轮换）
  bun run public-access caddy <domain>          家宽 IPv6 + Caddy 反代（DDNS 需已配好）
                                                [--https-port 8443]
公共选项:
  --port <n>   反代目标端口（默认读 anyplane 配置，7480）

前置（脚本只起隧道/反代，不碰账号体系）:
  - 必须已配置 authToken（ANYPLANE_TOKEN 或配置文件）——公网上它是唯一防线，缺失即拒绝执行
  - funnel：tailscale 已安装且 tailscale up；POSIX 下需 /dev/net/tun
  - cf-quick：cloudflared 已安装
  - caddy：caddy 已安装；域名 AAAA 记录已指向本机（DDNS 自行配置，见 docs/public-access.md 方案三）
`

export function parseArgs(argv: string[]): PublicAccessArgs {
  const [recipe, ...rest] = argv
  if (recipe !== 'funnel' && recipe !== 'cf-quick' && recipe !== 'caddy') {
    throw new Error(`未知配方: ${recipe ?? '(空)'}\n\n${USAGE}`)
  }
  let domain: string | undefined
  let port: number | undefined
  let httpsPort = 8443
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '--port') {
      port = Number(rest[++i])
      if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new Error(`--port 非法: ${rest[i]}`)
    } else if (rest[i] === '--https-port') {
      httpsPort = Number(rest[++i])
      if (!Number.isInteger(httpsPort) || httpsPort <= 0 || httpsPort > 65535)
        throw new Error(`--https-port 非法: ${rest[i]}`)
    } else if (!rest[i].startsWith('-') && domain === undefined) {
      domain = rest[i]
    } else {
      throw new Error(`未知参数: ${rest[i]}\n\n${USAGE}`)
    }
  }
  if (recipe === 'caddy' && !domain) {
    throw new Error(`caddy 配方需要域名参数：bun run public-access caddy <domain>\n\n${USAGE}`)
  }
  return { recipe, domain, port, httpsPort }
}

/** token 解析：ANYPLANE_TOKEN 优先，其次配置文件 authToken（与服务端 config.ts 同序） */
export function resolveToken(env: Record<string, string | undefined>, configFile: Record<string, unknown>): string | undefined {
  const fromEnv = env.ANYPLANE_TOKEN
  if (typeof fromEnv === 'string' && fromEnv) return fromEnv
  const fromFile = configFile.authToken
  return typeof fromFile === 'string' && fromFile ? fromFile : undefined
}

/** 端口解析：--port 优先 → ANYPLANE_PORT → 配置文件 port → 7480 */
export function resolvePort(
  flagPort: number | undefined,
  env: Record<string, string | undefined>,
  configFile: Record<string, unknown>,
): number {
  if (flagPort !== undefined) return flagPort
  const fromEnv = Number(env.ANYPLANE_PORT)
  if (Number.isInteger(fromEnv) && fromEnv > 0) return fromEnv
  const fromFile = Number(configFile.port)
  if (Number.isInteger(fromFile) && fromFile > 0) return fromFile
  return 7480
}

/** Caddy 反代配置：v6 入站 httpsPort → 回环 anyplane。TLS 由 Caddy 自动签发（HTTP-01/TLS-ALPN-01 均支持 v6） */
export function renderCaddyfile(domain: string, targetPort: number, httpsPort: number): string {
  return `# AnyPlane public-access 脚本生成（可随时手工编辑；再次运行脚本会覆盖）
${domain}:${httpsPort} {
\treverse_proxy 127.0.0.1:${targetPort}
}
`
}

/** 后续动作提醒：三个配方共用（publicUrl 与 Web Push re-subscribe 是换公网地址后的两件琐事） */
export function nextStepsHint(publicUrl: string): string {
  return [
    ``,
    `公网地址: ${publicUrl}`,
    ``,
    `后续两件事:`,
    `  1. 把该地址写入 anyplane 配置的 publicUrl（webhook 通知深链与直接审批按钮需要绝对 URL）`,
    `  2. Web Push 订阅按 origin 隔离：手机需在新地址上重新打开铃铛面板订阅一次`,
    ``,
    `验收清单（蜂窝网络，非 Wi-Fi）见 docs/public-access.md 末节。`,
  ].join('\n')
}
