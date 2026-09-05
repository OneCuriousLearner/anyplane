// codex app-server schema 漂移检查：generate-ts --experimental 与入库基线 diff。
// 实测撞上过 wire 枚举漂移（sandbox kebab/camel 双轨），升级 codex 前必跑。
// 用法：bun run server/scripts/check-codex-schema.ts [--update]

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'bun'

const update = process.argv.includes('--update')
const baselineDir = join(import.meta.dir, 'codex-schema-baseline')

const tmp = join(import.meta.dir, '.codex-schema-tmp')
rmSync(tmp, { recursive: true, force: true })
mkdirSync(tmp, { recursive: true })

const out = spawnSync(['codex', 'app-server', 'generate-ts', '--experimental', '--out', tmp], {
  stdout: 'pipe',
  stderr: 'pipe',
})
if (out.exitCode !== 0) {
  console.error('generate-ts 失败:', out.stderr.toString().slice(0, 400))
  process.exit(1)
}

function collect(dir: string, prefix = ''): Map<string, string> {
  const map = new Map<string, string>()
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    const rel = prefix ? `${prefix}/${name}` : name
    if (name.endsWith('.ts')) map.set(rel, readFileSync(p, 'utf8'))
    else if (existsSync(p) && !name.includes('.')) {
      try {
        for (const [k, v] of collect(p, rel)) map.set(k, v)
      } catch {}
    }
  }
  return map
}

const now = collect(tmp)
rmSync(tmp, { recursive: true, force: true })

if (update || !existsSync(baselineDir)) {
  mkdirSync(baselineDir, { recursive: true })
  for (const [rel, content] of now) {
    const p = join(baselineDir, rel)
    mkdirSync(join(p, '..'), { recursive: true })
    writeFileSync(p, content)
  }
  console.log(`基线已写入 ${baselineDir}（${now.size} 个类型文件）`)
  const { markChecked } = await import('../src/driftGuard')
  markChecked('codex')
  process.exit(0)
}

const baseline = collect(baselineDir)
let changes = 0
const changeSummary: string[] = []
for (const [rel, content] of now) {
  const old = baseline.get(rel)
  if (old === undefined) {
    console.log(`⚠ 新增类型文件: ${rel}`)
    changes++
    changeSummary.push(`新增 ${rel}`)
  } else if (old !== content) {
    const addedLines = content.split('\n').length - old.split('\n').length
    console.log(`⚠ 变更: ${rel} (${addedLines >= 0 ? '+' : ''}${addedLines} 行)`)
    changes++
    changeSummary.push(`变更 ${rel}`)
  }
}
for (const rel of baseline.keys()) {
  if (!now.has(rel)) {
    console.log(`⚠ 移除类型文件: ${rel}`)
    changes++
    changeSummary.push(`移除 ${rel}`)
  }
}
if (changes > 0) {
  console.log('\n发现 schema 漂移：评估后 bun run server/scripts/check-codex-schema.ts --update 更新基线')
  const { alertDrift } = await import('../src/driftGuard')
  await alertDrift(
    'codex',
    changes <= 6 ? changeSummary.join('；') : `${changes} 处变更（${changeSummary.slice(0, 4).join('；')} 等）`,
  )
  process.exit(1)
}
console.log(`无漂移（${now.size} 个类型文件）`)
const { markChecked } = await import('../src/driftGuard')
markChecked('codex')
