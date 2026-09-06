// claude 协议漂移检查：提取 control_request subtype 与 stdout 消息类型清单，与入库基线 diff。
// CLI 升级后跑一次，新增项人工评估是否要适配。
//
// 数据源优先级：
//   ① 官方公开 npm 包 @anthropic-ai/claude-agent-sdk 的 sdk.d.ts（**CI 用这条**）——
//      公开发行物、随 CLI 版本同步、无需本地快照，覆盖面比任何手抄清单都全。
//   ② 本地源码快照（显式路径参数传入的 claude-code 仓库）——仅作离线兜底；
//      它是 source-map 重建产物，**不进 CI、不得 vendor 进本仓库**。
//
// 用法：bun run server/scripts/check-claude-protocol.ts [快照路径] [--update]
//   不传快照路径时自动 npm 取包；传了则强制走快照。
//   --update 重建基线 server/scripts/protocol-baseline.claude.json

import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'bun'

const args = process.argv.slice(2).filter((a) => !a.startsWith('--'))
const update = process.argv.includes('--update')

/** 去重排序的捕获组提取 */
function literalsIn(src: string, pattern: RegExp): string[] {
  return [...new Set([...src.matchAll(pattern)].map((m) => m[1]!))].sort()
}

interface Extracted {
  source: string
  controlSubtypes: string[]
  stdoutTypes: string[]
  systemSubtypes: string[]
}

/** ① 官方 npm 包：npm pack 到临时目录后读 sdk.d.ts（纯 .d.ts 文本匹配，不求解析 TS） */
function fromNpm(): Extracted {
  const dir = mkdtempSync(join(tmpdir(), 'anyplane-cas-'))
  try {
    const pack = spawnSync(['npm', 'pack', '@anthropic-ai/claude-agent-sdk', '--silent'], {
      cwd: dir,
      stdout: 'pipe',
      stderr: 'pipe',
    })
    if (pack.exitCode !== 0) throw new Error(`npm pack 失败: ${pack.stderr.toString().slice(0, 300)}`)
    const tgz = readdirSync(dir).find((f) => f.endsWith('.tgz'))
    if (!tgz) throw new Error('npm pack 未产出 .tgz')
    const untar = spawnSync(['tar', '-xzf', tgz], { cwd: dir, stdout: 'pipe', stderr: 'pipe' })
    if (untar.exitCode !== 0) throw new Error(`解包失败: ${untar.stderr.toString().slice(0, 300)}`)
    const dts = join(dir, 'package', 'sdk.d.ts')
    if (!existsSync(dts)) throw new Error(`包内缺 sdk.d.ts（包结构变了？）`)
    const src = readFileSync(dts, 'utf8')
    const version = JSON.parse(readFileSync(join(dir, 'package', 'package.json'), 'utf8')).version
    // .d.ts 里 control subtype 与 system subtype 混在同一 `subtype: 'x'` 形态，无法从字面区分，
    // 合并为一张 subtype 全集即可——基线 diff 关心的是"有没有新东西"，不是归属哪张表
    return {
      source: `npm:@anthropic-ai/claude-agent-sdk@${version}`,
      controlSubtypes: literalsIn(src, /subtype:\s*'([a-zA-Z_]+)'/g),
      stdoutTypes: literalsIn(src, /\btype:\s*'([a-zA-Z_]+)'/g),
      systemSubtypes: [],
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/** ② 本地源码快照：Zod schema 的 z.literal('x') */
function fromSnapshot(snapshot: string): Extracted {
  const controlSchemas = join(snapshot, 'src/entrypoints/sdk/controlSchemas.ts')
  const coreSchemas = join(snapshot, 'src/entrypoints/sdk/coreSchemas.ts')
  for (const f of [controlSchemas, coreSchemas]) {
    if (!existsSync(f)) {
      console.error(`找不到快照文件: ${f}`)
      process.exit(1)
    }
  }
  const control = readFileSync(controlSchemas, 'utf8')
  const core = readFileSync(coreSchemas, 'utf8')
  return {
    source: `snapshot:${snapshot}`,
    controlSubtypes: literalsIn(control, /subtype:\s*z\.literal\('([^']+)'\)/g),
    stdoutTypes: literalsIn(core, /type:\s*z\.literal\('([^']+)'\)/g),
    systemSubtypes: literalsIn(core, /subtype:\s*z\.literal\('([^']+)'\)/g),
  }
}

let extracted: Extracted
if (args[0]) {
  extracted = fromSnapshot(args[0])
} else {
  try {
    extracted = fromNpm()
  } catch (e) {
    const fallback = [join(process.env.HOME ?? '', 'claude-code')].find((p) => existsSync(p))
    if (!fallback) {
      console.error(`取官方 SDK 包失败且无本地快照可兜底: ${e instanceof Error ? e.message : e}`)
      process.exit(1)
    }
    console.warn(`⚠ 取官方 SDK 包失败，回退本地快照: ${e instanceof Error ? e.message : e}`)
    extracted = fromSnapshot(fallback)
  }
}
console.log(`数据源: ${extracted.source}`)

const current = {
  extractedAt: new Date().toISOString(),
  ...extracted,
}

const baselinePath = join(import.meta.dir, 'protocol-baseline.claude.json')
if (update || !existsSync(baselinePath)) {
  writeFileSync(baselinePath, JSON.stringify(current, null, 2))
  console.log(`基线已写入 ${baselinePath}`)
  console.log(
    `control_subtypes=${current.controlSubtypes.length} stdout_types=${current.stdoutTypes.length} system_subtypes=${current.systemSubtypes.length}`,
  )
  const { markChecked } = await import('../src/driftGuard')
  markChecked('claude')
  process.exit(0)
}

const baseline = JSON.parse(readFileSync(baselinePath, 'utf8')) as typeof current
let drift = 0
const driftSummary: string[] = []
for (const key of ['controlSubtypes', 'stdoutTypes', 'systemSubtypes'] as const) {
  const before = new Set(baseline[key])
  const now = new Set(current[key])
  const added = [...now].filter((x) => !before.has(x))
  const removed = [...before].filter((x) => !now.has(x))
  if (added.length === 0 && removed.length === 0) {
    console.log(`✓ ${key}: 无漂移（${now.size} 项）`)
    continue
  }
  drift += added.length + removed.length
  if (added.length) driftSummary.push(`${key} 新增 ${added.length} 项`)
  if (removed.length) driftSummary.push(`${key} 移除 ${removed.length} 项`)
  console.log(`⚠ ${key}:`)
  if (added.length) console.log(`  新增: ${added.join(', ')}`)
  if (removed.length) console.log(`  移除: ${removed.join(', ')}`)
}
if (drift > 0) {
  console.log('\n发现漂移：评估新增项后 bun run server/scripts/check-claude-protocol.ts --update 更新基线')
  const { alertDrift } = await import('../src/driftGuard')
  await alertDrift('claude', driftSummary.join('；'))
  process.exit(1)
}
console.log('无漂移')
const { markChecked } = await import('../src/driftGuard')
markChecked('claude')
