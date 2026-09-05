// 协议漂移预警：CLI 版本探测 + 后台检查 + 告警投递。
// 设计见 docs/PLAN-drift-guard-and-approval-engine.md 第一节。
//
// 工作方式：
//   1. 服务端启动时读 claude/codex 版本，与 ~/.anyplane/protocol-checks.json 记录比对；
//   2. 版本前进而该版本未通过检查 → 控制台醒目提醒（一行复制即跑的命令），不阻塞启动；
//   3. 检查脚本成功退出后记录版本（脚本尾部调 markChecked）；
//   4. 配置了 pushWebhooks 时（driftAlert 默认开），漂移检出即发 error 级通知到手机。
//
// 仓库约定：本模块只被服务端入口与两个 check 脚本引用，不产生任何外发请求
// （告警走 push.ts 的既有 webhook 扇出，配置即信任边界不变）。

import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { config } from './config'
import { pushWebhooksToAll } from './push'

const STATE_PATH = join(homedir(), '.anyplane', 'protocol-checks.json')

interface DriftState {
  /** 各 CLI 最近一次「该版本无漂移或基线已更新」的记录 */
  checked: Record<string, string> // cli -> version
  /** 最近一次检出漂移的版本（用于避免重复告警） */
  alerted?: Record<string, string> // cli -> version
}

function loadState(): DriftState {
  try {
    if (existsSync(STATE_PATH)) {
      return JSON.parse(readFileSync(STATE_PATH, 'utf8')) as DriftState
    }
  } catch (e) {
    console.warn(`[drift] 状态文件解析失败（当空处理）:`, e)
  }
  return { checked: {} }
}

function saveState(s: DriftState): void {
  try {
    mkdirSync(join(homedir(), '.anyplane'), { recursive: true })
    writeFileSync(STATE_PATH, JSON.stringify(s, null, 2))
  } catch (e) {
    console.warn(`[drift] 状态写入失败:`, e)
  }
}

/** 读 CLI 版本；CLI 不存在返回 null。claude 可能是 .cmd/.exe（resolveClaudeCommand 逻辑在
 *  processManager，这里独立解析避免循环依赖——只要版本号字符串，不需要完整命令解析）。 */
export function cliVersionOf(cli: 'claude' | 'codex'): string | null {
  const candidates =
    cli === 'claude'
      ? process.platform === 'win32'
        ? ['claude.exe', 'claude.cmd', 'claude']
        : ['claude']
      : process.platform === 'win32'
        ? ['codex.exe', 'codex.cmd', 'codex']
        : ['codex']
  for (const cmd of candidates) {
    try {
      const r = spawnSync(cmd, ['--version'], { encoding: 'utf8', timeout: 10_000, shell: cmd.endsWith('.cmd') })
      const out = (r.stdout ?? '').trim()
      if (r.status === 0 && out) return out.split('\n')[0]!.trim()
    } catch {
      /* 继续下一个候选 */
    }
  }
  return null
}

/** 启动时版本探测：版本前进而未通过检查 → 控制台提醒。返回是否需要提醒。 */
export function startupVersionProbe(): void {
  const state = loadState()
  for (const cli of ['claude', 'codex'] as const) {
    const v = cliVersionOf(cli)
    if (!v) continue // CLI 不在 PATH，无会话可开，不打扰
    if (state.checked[cli] === v) continue
    const script =
      cli === 'codex' ? 'server/scripts/check-codex-schema.ts' : 'server/scripts/check-claude-protocol.ts'
    console.warn(
      `[drift] 检测到 ${cli} 版本为「${v}」，尚未通过协议漂移检查。\n` +
        `        建议尽快执行：bun run ${script}\n` +
        `        （检查通过后本提醒自动消失）`,
    )
  }
}

/** 检查脚本成功/基线更新后调用：记录该版本已检查，消除启动提醒。 */
export function markChecked(cli: 'claude' | 'codex'): void {
  const v = cliVersionOf(cli)
  if (!v) return
  const state = loadState()
  state.checked[cli] = v
  saveState(state)
}

/** 漂移检出时调用：控制台 +（配置 webhook 时）手机告警。同一版本只告警一次。 */
export async function alertDrift(cli: 'claude' | 'codex', summary: string): Promise<void> {
  console.error(`[drift] ⚠ ${cli} 协议漂移：${summary}`)
  if (config.driftAlert === false) return
  if (!config.pushWebhooks?.length) return
  const v = cliVersionOf(cli) ?? 'unknown'
  const state = loadState()
  if (state.alerted?.[cli] === v) return // 同版本已告警过
  state.alerted = { ...(state.alerted ?? {}), [cli]: v }
  saveState(state)
  try {
    await pushWebhooksToAll({
      type: 'error',
      title: `AnyPlane 协议漂移预警`,
      body: `${cli} ${v}：${summary}。请运行检查脚本评估后更新基线。`,
    })
  } catch (e) {
    console.warn('[drift] webhook 告警投递失败:', e)
  }
}
