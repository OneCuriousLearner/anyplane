// 公网配方一键脚本的逻辑层：参数解析、Caddyfile 渲染、token/端口解析、run() 主流程。
// 与 public-access.ts 的副作用层分离（gateway.ts/gateway-lib.ts 同款拆分）：
// run() 的全部副作用（进程、网络、文件、配置）经 RunDeps 注入，测试在进程内跑——
// 绝不能为测试去 spawn 真实隧道二进制（在本机跑 bun test 不应可能改写 tailnet 配置）。

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
  if (domain !== undefined && !/^[a-zA-Z0-9][a-zA-Z0-9.-]*[a-zA-Z0-9]$/.test(domain)) {
    // domain 会插值进 Caddyfile 站点块：Caddyfile 是指令式配置语言（import 可包含任意
    // 文件），空格/换行/花括号既可能被当额外指令注入，也会让 caddy run 以难诊断的
    // 解析错误退出。argv 无 shell 注入面，校验只针对配置文件生成层
    throw new Error(`域名非法（只允许字母/数字/点/连字符）：${domain}\n\n${USAGE}`)
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

// ---------- run() 主流程（副作用全部经 RunDeps 注入） ----------

export interface RunDeps {
  /** anyplane 配置文件（loadAnyplaneConfigFile：cwd → 项目根 → ~/.anyplane） */
  loadConfig(): Record<string, unknown>
  env: Record<string, string | undefined>
  platform: NodeJS.Platform
  which(bin: string): string | null
  exists(p: string): boolean
  /** 本地服务可达性预检 */
  serverUp(port: number): Promise<boolean>
  /** 上游鉴权生效探测：无凭据 GET /api/sessions 的状态码（401=强制 token；null=不可达）。
   *  token「存在」于本进程 env/配置 ≠ 上游 server 进程在强制它（配置漂移：token 后补进
   *  配置/env 时，旧 server 进程仍按启动时的无 token 配置运行）。公网暴露前必须验生效。 */
  apiStatus(port: number): Promise<number | null>
  /** caddy 配置落盘目录（~/.anyplane/caddy，0700） */
  stateDir(): string
  writeFile(path: string, content: string): Promise<unknown>
  /** 前台托管子进程（cf-quick/caddy），返回退出码 */
  foreground(cmd: string[]): Promise<number>
  /** 同步执行（funnel）：echo 时子进程输出直透终端 */
  spawnSync(cmd: string[], echo?: boolean): { exitCode: number; stdout: string }
  out(msg: string): void
  err(msg: string): void
}

export async function run(argv: string[], deps: RunDeps): Promise<number> {
  const fail = (msg: string): number => {
    deps.err(`[public-access] ${msg}`)
    return 1
  }

  if (argv.length === 0 || argv[0] === 'help' || argv[0] === '--help' || argv[0] === '-h') {
    deps.out(USAGE)
    return argv.length === 0 ? 1 : 0
  }

  let args: PublicAccessArgs
  try {
    args = parseArgs(argv)
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e))
  }

  // loadConfig 抛错（坏 approvalRules 是刻意 fail-fast）向上传播，由包装层统一成可读报错
  const configFile = deps.loadConfig()
  // 安全红线：未配置 authToken 一律拒绝——隧道层暴露在服务端启动检查之外，token 全靠自觉，
  // 本脚本把自觉变成硬门槛（集成测试锁定：任何配置候选都不得穿透进这条判定）
  if (!resolveToken(deps.env, configFile)) {
    return fail(
      '拒绝执行：未配置 authToken。公网暴露时 token 是唯一防线（隧道/反代层在服务端启动检查之外）。\n' +
        '请在 anyplane.config.json 设置 "authToken"（≥32 随机字符）或 ANYPLANE_TOKEN 环境变量后重试。',
    )
  }
  const port = resolvePort(args.port, deps.env, configFile)
  // 隧道起了才发现本地服务没跑是最常见的白忙一场
  if (!(await deps.serverUp(port))) {
    return fail(`127.0.0.1:${port} 无响应——AnyPlane 服务端未在运行。请先启动（bunx anyplane / bun run start）。`)
  }
  // token「存在」于本进程 ≠ 上游 server 进程在强制它：token 若是后补进配置/env 的，
  // 仍在运行的旧 server 进程按启动时的无 token 配置放行一切——把隧道绑上去等于裸奔。
  // 绑定公网入口前必须探测上游真实鉴权状态（验生效，而非验存在）。
  const status = await deps.apiStatus(port)
  if (status !== 401) {
    return fail(
      status === null
        ? `127.0.0.1:${port} 的 /api 无响应——服务在运行但 API 探测失败，拒绝绑定公网入口。`
        : `上游服务端未在强制 authToken（无凭据 GET /api/sessions 返回 ${status} 而非 401）。\n` +
            '常见原因：token 是后补进配置/env 的，而 server 进程仍按旧配置运行。请重启 AnyPlane 服务端后重试。',
    )
  }

  const whichOrFail = (bin: string, installHint: string): string | number => {
    const hit = deps.which(bin)
    return hit ?? fail(`未找到 ${bin}。${installHint}`)
  }

  switch (args.recipe) {
    case 'funnel': {
      const tailscale = whichOrFail('tailscale', '安装见 https://tailscale.com/download')
      if (typeof tailscale !== 'string') return tailscale
      // POSIX 无 TUN 的云容器/沙箱整套不可用，直接 fail 指到方案二（Windows 无此概念）
      if (deps.platform !== 'win32' && !deps.exists('/dev/net/tun')) {
        return fail('无 /dev/net/tun：无特权容器/沙箱跑不了 Tailscale，请改用 cf-quick。')
      }
      deps.out(`[public-access] tailscale funnel --bg ${port}`)
      const r = deps.spawnSync([tailscale, 'funnel', '--bg', String(port)], true)
      if (r.exitCode !== 0) return fail(`tailscale funnel 退出码 ${r.exitCode}（ACL 未开 funnel 或 tailnet 未 up？）`)
      // funnel 地址 = 机器名.tailnet 名.ts.net，从 status 解析（失败不致命，用户可自查）
      const st = deps.spawnSync([tailscale, 'status', '--json'])
      let url = 'https://<机器名>.<tailnet名>.ts.net'
      try {
        const j = JSON.parse(st.stdout) as { Self?: { DNSName?: string } }
        if (j.Self?.DNSName) url = `https://${j.Self.DNSName.replace(/\.$/, '')}`
      } catch {}
      deps.out(nextStepsHint(url))
      deps.out(`撤销: tailscale funnel --bg ${port} off`)
      return 0
    }
    case 'cf-quick': {
      const cloudflared = whichOrFail(
        'cloudflared',
        '安装见 https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/',
      )
      if (typeof cloudflared !== 'string') return cloudflared
      deps.out(`[public-access] cloudflared tunnel --url http://localhost:${port}`)
      deps.out('[public-access] 启动后从输出里复制 https://<随机>.trycloudflare.com（Ctrl+C 停止并释放）')
      // 前台托管：URL 由 cloudflared 自己打印，比解析输出再打印一遍更不易漂移
      return deps.foreground([cloudflared, 'tunnel', '--url', `http://localhost:${port}`])
    }
    case 'caddy': {
      const caddy = whichOrFail('caddy', '安装见 https://caddyserver.com/docs/install')
      if (typeof caddy !== 'string') return caddy
      const file = `${deps.stateDir()}/Caddyfile`
      await deps.writeFile(file, renderCaddyfile(args.domain!, port, args.httpsPort))
      deps.out(`[public-access] Caddyfile 已写入 ${file}`)
      deps.out(`[public-access] caddy run（前台；Ctrl+C 停止）。入站 :${args.httpsPort} 需在路由器/防火墙放行`)
      deps.out(nextStepsHint(`https://${args.domain}:${args.httpsPort}`))
      return deps.foreground([caddy, 'run', '--config', file])
    }
  }
}
