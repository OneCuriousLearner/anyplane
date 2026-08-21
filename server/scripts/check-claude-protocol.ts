// claude 协议漂移检查：从源码快照提取 control_request subtype 与 stdout 消息类型清单，
// 与入库基线 diff。CLI 升级后跑一次，新增项人工评估是否要适配。
// 用法：bun run server/scripts/check-claude-protocol.ts [快照路径] [--update]
//   快照默认 /data/workspace/claude-code（或 ../claude-code 自动探测）
//   --update 重建基线 server/scripts/protocol-baseline.claude.json

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const args = process.argv.slice(2).filter((a) => !a.startsWith('--'))
const update = process.argv.includes('--update')
const snapshot =
  args[0] ??
  (['/data/workspace/claude-code', join(process.env.HOME ?? '', 'claude-code')].find((p) => existsSync(p)) ||
  '/data/workspace/claude-code')

const controlSchemas = join(snapshot, 'src/entrypoints/sdk/controlSchemas.ts')
const coreSchemas = join(snapshot, 'src/entrypoints/sdk/coreSchemas.ts')
for (const f of [controlSchemas, coreSchemas]) {
  if (!existsSync(f)) {
    console.error(`找不到快照文件: ${f}`)
    process.exit(1)
  }
}

/** z.literal('xxx') 提取 */
function literals(file: string, pattern: RegExp): string[] {
  const src = readFileSync(file, 'utf8')
  return [...new Set([...src.matchAll(pattern)].map((m) => m[1]!))].sort()
}

const controlSubtypes = literals(controlSchemas, /subtype:\s*z\.literal\('([^']+)'\)/g)
// stdout 顶层 type（SDKMessage union 成员）
const stdoutTypes = literals(coreSchemas, /type:\s*z\.literal\('([^']+)'\)/g)
// system 消息的 subtype
const systemSubtypes = literals(coreSchemas, /subtype:\s*z\.literal\('([^']+)'\)/g)

const current = {
  extractedAt: new Date().toISOString(),
  snapshot,
  controlSubtypes,
  stdoutTypes,
  systemSubtypes,
}

const baselinePath = join(import.meta.dir, 'protocol-baseline.claude.json')
if (update || !existsSync(baselinePath)) {
  writeFileSync(baselinePath, JSON.stringify(current, null, 2))
  console.log(`基线已写入 ${baselinePath}`)
  console.log(`control_subtypes=${controlSubtypes.length} stdout_types=${stdoutTypes.length} system_subtypes=${systemSubtypes.length}`)
  process.exit(0)
}

const baseline = JSON.parse(readFileSync(baselinePath, 'utf8')) as typeof current
let drift = 0
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
  console.log(`⚠ ${key}:`)
  if (added.length) console.log(`  新增: ${added.join(', ')}`)
  if (removed.length) console.log(`  移除: ${removed.join(', ')}`)
}
if (drift > 0) {
  console.log('\n发现漂移：评估新增项后 bun run server/scripts/check-claude-protocol.ts --update 更新基线')
  process.exit(1)
}
console.log('无漂移')
