// 各档模型的「实际配置名」解析：供 StatusPill 透传显示（haiku/sonnet/opus/fable → 用户网关的真实模型名）。
// 镜像官方解析链（claude-code modelOptions.ts）：显示名 = _MODEL_NAME ?? _MODEL（模型 ID），
// 均未配置时不返回该档——前端降级为 tier 名。
// 来源合并：user → project → local → managed settings 的 env 块按序覆盖，process.env 最后覆盖
//（shell 显式导出优先；官方 CLI 也是把 settings env 灌进 process.env 后读取）。

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { config } from '../../config'

export interface TierModelName {
  /** 显示名（_MODEL_NAME 优先，缺省回退模型 ID） */
  name: string
  /** 模型 ID（仅当与显示名不同才携带，供 tooltip） */
  id?: string
}

const TIERS = ['haiku', 'sonnet', 'opus', 'fable'] as const

/** 读一个 settings 文件的 env 块（缺文件/解析失败/非字符串值一律静默跳过） */
function settingsEnv(path: string): Record<string, string> {
  try {
    if (!existsSync(path)) return {}
    const j = JSON.parse(readFileSync(path, 'utf8')) as { env?: Record<string, unknown> }
    const out: Record<string, string> = {}
    for (const [k, v] of Object.entries(j.env ?? {})) {
      if (typeof v === 'string') out[k] = v
    }
    return out
  } catch {
    return {}
  }
}

export function resolveTierModelNames(
  cwd?: string,
  procEnv: Record<string, string | undefined> = process.env,
  configDir: string = config.claudeConfigDir,
): Record<string, TierModelName> {
  const sources = [
    join(configDir, 'settings.json'),
    ...(cwd ? [join(cwd, '.claude', 'settings.json'), join(cwd, '.claude', 'settings.local.json')] : []),
    '/etc/claude-code/managed-settings.json',
  ]
  const fileEnv: Record<string, string> = {}
  for (const s of sources) Object.assign(fileEnv, settingsEnv(s))

  const out: Record<string, TierModelName> = {}
  for (const tier of TIERS) {
    const T = tier.toUpperCase()
    const name = procEnv[`ANTHROPIC_DEFAULT_${T}_MODEL_NAME`] ?? fileEnv[`ANTHROPIC_DEFAULT_${T}_MODEL_NAME`]
    const id = procEnv[`ANTHROPIC_DEFAULT_${T}_MODEL`] ?? fileEnv[`ANTHROPIC_DEFAULT_${T}_MODEL`]
    const display = name ?? id
    if (display) out[tier] = { name: display, ...(id && id !== display ? { id } : {}) }
  }
  return out
}
