// complexity-report.ts — 巨石文件/神组件定量探测（第一层信号，只告警不裁决）
//
// 设计依据（与 docs/complexity-baseline.md 的定性基线配套）：
// 「巨石」是定性概念（职责混叠、状态纠缠、不可测），行数/hook 数只是低成本的
// 探测启发式。本脚本的产出是"待人工/LLM 定性裁决的候选清单"，不是判决。
// 双层结构：
//   第 1 层（本脚本）  定量触发：文件行数、单函数长度、组件 hook 密度、git 变更热点
//   第 2 层（.claude/tasks/complexity-patrol.md 或人工 review）
//                    定性裁决：职责是否可拆、状态是否纠缠、能否独立测试
//
// 用法:
//   bun scripts/complexity-report.ts [--since <git-date>] [--all]
//
//   --since  变更热点统计窗口，默认 "6 months ago"
//   --all    连基线内（已知、已裁决）文件一起列出；默认只列 NEW/新增告警
//
// 退出码恒为 0——本工具是告警渠道，不是红线闸（阈值命中 ≠ 必须拆，反例见基线文档：
// translate.ts 813 行但内聚，拆它反而破坏 live/历史同形红线）。
import ts from 'typescript'
import { readdirSync, readFileSync, type Dirent } from 'node:fs'
import { join, relative } from 'node:path'

const ROOT = import.meta.dir.replace(/[/\\][^/\\]+$/, '')
const SCAN_DIRS = ['server/src', 'web/src', 'scripts', 'cli', 'protocol']
// 测试文件与 fixture 的体量/密度不反映生产复杂度，排除
const SKIP = /\.(test|spec)\.|\.d\.ts$|^web[/\\]src[/\\]fixture[/\\]/

// 阈值是"触发 review"的告警线，不是"必须拆分"的红线——命中后请走第二层定性裁决
const FILE_LINES_WARN = 500
const FUNC_LINES_WARN = 150
const HOOKS_WARN = 10
const CHURN_HOT = 20 // 窗口内被 commit 触碰次数：变更热点线

// 基线白名单：2026-10-03 首轮全仓定性裁决的结论
// 是"大但内聚、刻意不拆"的文件。列在这里只为让后续运行聚焦*新增*告警；
// 若某文件经过重构瘦身或裁决反转，应从列表移除。文件路径用正斜杠。
const BASELINE = new Set([
  'server/src/backends/codex/translate.ts',
  'server/src/backends/claude/port.ts',
  'server/src/backends/claude/discovery.ts',
  'server/src/backends/codex/runtime.ts',
  'server/src/push/vapid.ts',
  'scripts/gateway.ts',
  'web/src/components/Composer.tsx',
  'web/src/hooks/useTranscriptIngest.ts',
  'web/src/hooks/useSessionSocket.ts',
  'web/src/hooks/useTaskBuckets.ts',
  'web/src/hooks/useTranscriptScroll.ts',
])

const args = process.argv.slice(2)
const sinceIdx = args.indexOf('--since')
const since = sinceIdx >= 0 ? args[sinceIdx + 1] : '6 months ago'
const showAll = args.includes('--all')

const norm = (p: string) => p.split('\\').join('/')
const relOf = (p: string) => norm(relative(ROOT, p))

function* walk(dir: string): Generator<string> {
  let entries: Dirent[]
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return // 目录不存在（如 cli/ 只有 anyplane.mjs）则跳过
  }
  for (const e of entries) {
    if (e.name === 'node_modules' || e.name === 'dist') continue
    const p = join(dir, e.name)
    if (e.isDirectory()) yield* walk(p)
    else if (/\.(ts|tsx|mts)$/.test(e.name) && !SKIP.test(relOf(p))) yield p
  }
}

interface FnFlag {
  kind: 'fn' | 'hooks'
  name: string
  detail: string
}
interface Row {
  file: string
  lines: number
  churn: number
  flags: string[]
  isNew: boolean
}

const HOOK_CALL = /^(use|create)[A-Z]/

// 只统计"顶层函数 + 类方法"的长度，不钻进函数体内部——否则嵌套回调
// （如 useSessionSocket 里的匿名 connect 回调）会被重复计数。
function analyzeFile(file: string, sourceText: string): FnFlag[] {
  const sf = ts.createSourceFile(file, sourceText, ts.ScriptTarget.Latest, true)
  const lineOf = (pos: number) => sf.getLineAndCharacterOfPosition(pos).line + 1
  const flags: FnFlag[] = []

  const measure = (node: ts.FunctionLikeDeclaration) => {
    if (!node.body) return
    const name = node.name?.getText(sf) ?? '<anonymous>'
    const len = lineOf(node.body.getEnd()) - lineOf(node.getStart()) + 1
    if (len > FUNC_LINES_WARN) flags.push({ kind: 'fn', name, detail: `${len}L>${FUNC_LINES_WARN}` })
    // hook 密度：React 组件/自定义 hook 内 use*/create* 调用数——神组件最稳的单一信号
    let hooks = 0
    const count = (n: ts.Node): void => {
      if (
        ts.isCallExpression(n) &&
        ts.isIdentifier(n.expression) &&
        HOOK_CALL.test(n.expression.text)
      )
        hooks++
      ts.forEachChild(n, count)
    }
    count(node.body)
    if (hooks > HOOKS_WARN) flags.push({ kind: 'hooks', name, detail: `hooks=${hooks}>${HOOKS_WARN}` })
  }

  const visitToplevel = (node: ts.Node) => {
    if (
      ts.isFunctionDeclaration(node) ||
      ts.isFunctionExpression(node) ||
      ts.isArrowFunction(node) ||
      ts.isMethodDeclaration(node)
    ) {
      measure(node)
      return // 不进入函数体：嵌套函数长度属父函数
    }
    if (ts.isClassLike(node)) {
      for (const member of node.members) if (ts.isMethodDeclaration(member)) measure(member)
      return
    }
    ts.forEachChild(node, visitToplevel)
  }
  visitToplevel(sf)
  return flags
}

function churnTable(since: string): Map<string, number> {
  const proc = Bun.spawnSync(
    ['git', 'log', `--since=${since}`, '--name-only', '--pretty=format:'],
    { cwd: ROOT },
  )
  const counts = new Map<string, number>()
  if (proc.exitCode !== 0) return counts
  for (const line of proc.stdout.toString().split('\n')) {
    const p = norm(line.trim())
    if (!/\.(ts|tsx|mts)$/.test(p) || /\.(test|spec)\./.test(p)) continue
    counts.set(p, (counts.get(p) ?? 0) + 1)
  }
  return counts
}

const rows: Row[] = []
for (const dir of SCAN_DIRS) {
  for (const file of walk(join(ROOT, dir))) {
    const rel = relOf(file)
    const sourceText = readFileSync(file, 'utf8')
    const lines = sourceText.split('\n').length
    const fnFlags = analyzeFile(file, sourceText)
    const flags: string[] = []
    if (lines > FILE_LINES_WARN) flags.push(`file ${lines}L>${FILE_LINES_WARN}`)
    for (const f of fnFlags) flags.push(`${f.kind === 'fn' ? 'fn' : 'component'} ${f.name} ${f.detail}`)
    if (!flags.length) continue
    rows.push({ file: rel, lines, churn: 0, flags, isNew: !BASELINE.has(rel) })
  }
}

const churn = churnTable(since)
for (const r of rows) r.churn = churn.get(r.file) ?? 0

// 优先级：P1 = 结构性信号（长函数/高 hook 密度，定性命中率高），P2 = 仅体量告警
// 同档内按变更热点排序——热点文件才是"每次改都疼"的真巨石
const tier = (r: Row) => (r.flags.some((f) => f.startsWith('fn ') || f.startsWith('component ')) ? 1 : 2)
rows.sort((a, b) => tier(a) - tier(b) || b.churn - a.churn || b.lines - a.lines)

const shown = showAll ? rows : rows.filter((r) => r.isNew || r.churn >= CHURN_HOT)
console.log(`# 复杂度探测报告（热点窗口: ${since}）`)
console.log('')
console.log('| 优先级 | 文件 | 行数 | 变更 | 信号 | 状态 |')
console.log('|---|---|---|---|---|---|')
for (const r of shown) {
  const hot = r.churn >= CHURN_HOT ? '🔥' : ''
  console.log(
    `| P${tier(r)} | ${r.file} | ${r.lines} | ${r.churn}${hot} | ${r.flags.join('<br>')} | ${r.isNew ? '**NEW**' : '基线'} |`,
  )
}
const fresh = rows.filter((r) => r.isNew)
console.log('')
console.log(`共 ${rows.length} 个文件命中阈值，其中新增告警 ${fresh.length} 个。`)
if (!showAll && fresh.length) {
  console.log('新增告警文件：')
  for (const r of fresh) console.log(`  - ${r.file}（${r.flags.join('；')}）`)
}
