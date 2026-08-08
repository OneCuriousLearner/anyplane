// cc-remote 服务端配置
// 配置文件：项目根目录或 ~/.config/cc-remote/config.json（均可选，全部有默认值）

import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export interface ServerConfig {
  port: number
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
   * 已启用权威 session_state 时：客户端全断且 state=idle 后多久回收（默认 15 秒）。
   */
  detachRecycleMs: number
  /** claude 配置目录，默认 ~/.claude */
  claudeConfigDir: string
}

const DEFAULTS: ServerConfig = {
  port: 7480,
  permissionPolicy: 'ask',
  idleTimeoutMs: 30 * 60 * 1000,
  detachRecycleMs: 15 * 1000,
  claudeConfigDir: join(homedir(), '.claude'),
}

function loadFileConfig(): Partial<ServerConfig> {
  const candidates = [
    join(process.cwd(), 'cc-remote.config.json'),
    join(homedir(), '.config', 'cc-remote', 'config.json'),
  ]
  for (const p of candidates) {
    if (existsSync(p)) {
      try {
        return JSON.parse(readFileSync(p, 'utf8'))
      } catch (e) {
        console.error(`[config] 解析 ${p} 失败:`, e)
      }
    }
  }
  return {}
}

export const config: ServerConfig = {
  ...DEFAULTS,
  ...loadFileConfig(),
  ...(process.env.CC_REMOTE_PORT ? { port: Number(process.env.CC_REMOTE_PORT) } : {}),
  ...(process.env.CLAUDE_CONFIG_DIR ? { claudeConfigDir: process.env.CLAUDE_CONFIG_DIR } : {}),
}
