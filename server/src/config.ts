// anyplane 服务端配置
// 配置文件：项目根目录 anyplane.config.json 或 ~/.anyplane/config.json（均可选，全部有默认值）

import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * webhook 推送通道（ntfy / Bark / Server酱 Turbo），与 Web Push 订阅并列 fan-out。
 * 配置即信任：配置文件作者 = 服务端管理员，没有浏览器注册面，因此不需要 endpoint 白名单。
 * 注意渠道凭证即通知保密边界：ntfy topic 要用不可猜的长随机串（或配 token），
 * Bark key / Server酱 SendKey 同理——持有者能读通知全文（含审批能力 URL）。
 */
export type PushWebhookConfig =
  /** ntfy：server 缺省 https://ntfy.sh（自建写自己的根地址）；topic 受保护时配 token */
  | { type: 'ntfy'; topic: string; server?: string; token?: string }
  /** Bark：完整推送 URL（https://api.day.app/<key> 或自建 bark-server 的 /<key>） */
  | { type: 'bark'; url: string }
  /** Server酱 Turbo：SendKey（推送到微信） */
  | { type: 'sct'; sendkey: string }

export interface ServerConfig {
  port: number
  /** 监听地址。默认仅回环；绑非回环地址必须同时配置 authToken */
  host: string
  /**
   * 访问令牌。未配置时不做任何鉴权（仅限回环使用）；
   * 配置后 /api 与 /ws 一律要求 Bearer 或 ?token= 校验。
   * ANYPLANE_TOKEN 环境变量优先。
   */
  authToken?: string
  /** 默认权限策略：ask = 转发到 UI 审批；bypass = spawn 时直接 bypassPermissions */
  permissionPolicy: 'ask' | 'bypass'
  /** claude CLI 路径，默认从 PATH 解析 */
  claudePath?: string
  /**
   * 无 session_state_changed 事件时的回退：客户端全断且启发式空闲后多久回收（默认 30 分钟）。
   * busy / requires_action 期间永不回收。
   */
  idleTimeoutMs: number
  /**
   * 已启用权威 session_state 时：客户端全断、主会话 idle 且无后台任务后多久回收（默认 5 分钟）。
   */
  detachRecycleMs: number
  /** claude 配置目录，默认 ~/.claude */
  claudeConfigDir: string
  /**
   * 推送 endpoint 白名单（防订阅注册 SSRF/通知窃听）。缺省用内置主流推送服务列表
   * （FCM/Mozilla/Apple/WNS + 回环 mock）；自托管推送在此追加域名；['*'] = 任意 https。
   */
  pushAllowHosts?: string[]
  /**
   * anyplane 的公网基准 URL（如 https://anyplane.example.com，不带尾斜杠）。
   * webhook 通知里的深链与直接审批按钮需要绝对 URL（ntfy app/微信/Bark 不在本站上下文），
   * 不配置则 webhook 只发纯文本（标题+摘要仍可达）。
   */
  publicUrl?: string
  /** webhook 推送通道（见 PushWebhookConfig），与 Web Push 订阅同时接收 inbox 事件 */
  pushWebhooks?: PushWebhookConfig[]
}

const DEFAULTS: ServerConfig = {
  port: 7480,
  host: '127.0.0.1',
  permissionPolicy: 'ask',
  idleTimeoutMs: 30 * 60 * 1000,
  detachRecycleMs: 5 * 60 * 1000,
  claudeConfigDir: join(homedir(), '.claude'),
}

/** 读取 anyplane 配置文件：cwd → 项目根 → ~/.anyplane/config.json，首个存在者优先。
 *  服务端与 scripts/gateway 共用同一候选集，保证两处读到的配置一致。 */
export function loadAnyplaneConfigFile(): Record<string, unknown> {
  // server 从 workspace 的 server/ 目录启动时，仍应支持 README 中约定的项目根配置文件。
  const projectRootConfig = join(import.meta.dir, '..', '..', 'anyplane.config.json')
  const candidates = [
    join(process.cwd(), 'anyplane.config.json'),
    projectRootConfig,
    join(homedir(), '.anyplane', 'config.json'),
  ]
  for (const p of candidates) {
    if (existsSync(p)) {
      try {
        return JSON.parse(readFileSync(p, 'utf8')) as Record<string, unknown>
      } catch (e) {
        console.error(`[config] 解析 ${p} 失败:`, e)
      }
    }
  }
  return {}
}

export const config: ServerConfig = {
  ...DEFAULTS,
  ...(loadAnyplaneConfigFile() as Partial<ServerConfig>),
  ...(process.env.ANYPLANE_PORT ? { port: Number(process.env.ANYPLANE_PORT) } : {}),
  ...(process.env.ANYPLANE_HOST ? { host: process.env.ANYPLANE_HOST } : {}),
  ...(process.env.ANYPLANE_TOKEN ? { authToken: process.env.ANYPLANE_TOKEN } : {}),
  ...(process.env.CLAUDE_CONFIG_DIR ? { claudeConfigDir: process.env.CLAUDE_CONFIG_DIR } : {}),
}

/** 默认权限模式：bypass 策略 → claude bypassPermissions（codex 侧经 mapPermissionMode 映射同档）。
 *  claude/codex 两条 spawn 路径共用，调用方的显式选择（spawnOpts/opts）在其后覆盖。 */
export function defaultPermissionMode(): string | undefined {
  return config.permissionPolicy === 'bypass' ? 'bypassPermissions' : undefined
}


