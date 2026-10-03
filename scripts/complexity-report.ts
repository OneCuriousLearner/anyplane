// complexity-report.ts — 巨石文件/神组件定量探测（纯无状态）
//
// 本脚本是纯函数：输入 = 当前工作区文件 + git log，输出 = 全量命中清单。
// 它不内嵌、不读取、不产出任何「基线 / 新增」概念——
// BASELINE 与 NEW 的判定由人 / LLM 对照 docs/complexity-baseline.md 完成，
// 该文档是裁决状态的唯一载体。
//
// 退出码：0 = 本次扫描零命中；1 = 有文件命中阈值。
// 退出码只表达当期扫描事实（供 CI 决定是否递送报告），不代表"存在新增告警"。
//
// 用法:
//   bun scripts/complexity-report.ts [--since <git-date>]
//
//   --since  变更热点统计窗口，默认 "6 months ago"
import ts from 'typescript'
import { readdirSync, readFileSync, type Dirent } from 'node:fs'
import { join, relative } from 'node:path'

const ROOT = import.meta.dir.replace(/[/\\][^/\\]+$/, '')
const SCAN_DIRS = ['server/src', 'web/src', 'scripts', 'cli', 'protocol']
// 测试文件与 fixture 的体量/密度不反映生产复杂度，排除
const SKIP = /\.(test|spec)\.|\.d\.ts$|^web[/\\]src[/\\]fixture[/\\]/

// 阈值是"触发 review"的告警线，不是"必须拆分"的红线——命中后请对照
// docs/complexity-baseline.md 做定性裁决
const FILE_LINES_WARN = 500
const FUNC_LINES_WARN = 150
const HOOKS_WARN = 10
const CHURN_HOT = 20 // 窗口内被 commit 触碰次数：变更热点线

const args = process.argv.slice(2)
const sinceIdx = args.indexOf('--since')
// --since 缺值会拼出 --since=undefined，git 以 128 退出、churn 静默全零——fail fast
if (sinceIdx >= 0 && !args[sinceIdx + 1]) {
  console.error('用法: bun scripts/complexity-report.ts [--since <git-date>]')
  process.exit(2)
}
const since = sinceIdx >= 0 ? args[sinceIdx + 1] : '6 months ago'

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

interface Row {
  file: string
  lines: number
  churn: number
  flags: string[]
}

const HOOK_CALL = /^(use|create)[A-Z]/

// 只统计"顶层函数 + 类方法"的长度，不钻进函数体内部——否则嵌套回调
// （如 useSessionSocket 里的匿名 connect 回调）会被重复计数。
function analyzeFile(file: string, sourceText: string): string[] {
  const sf = ts.createSourceFile(file, sourceText, ts.ScriptTarget.Latest, true)
  const lineOf = (pos: number) => sf.getLineAndCharacterOfPosition(pos).line + 1
  const flags: string[] = []

  const measure = (node: ts.FunctionLikeDeclaration) => {
    if (!node.body) return
    const name = node.name?.getText(sf) ?? '<anonymous>'
    const len = lineOf(node.body.getEnd()) - lineOf(node.getStart()) + 1
    if (len > FUNC_LINES_WARN) flags.push(`fn ${name} ${len}L>${FUNC_LINES_WARN}`)
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
    if (hooks > HOOKS_WARN) flags.push(`component ${name} hooks=${hooks}>${HOOKS_WARN}`)
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
    const flags = analyzeFile(file, sourceText)
    if (lines > FILE_LINES_WARN) flags.unshift(`file ${lines}L>${FILE_LINES_WARN}`)
    if (!flags.length) continue
    rows.push({ file: rel, lines, churn: 0, flags })
  }
}

const churn = churnTable(since)
for (const r of rows) r.churn = churn.get(r.file) ?? 0

// 优先级：P1 = 结构性信号（长函数/高 hook 密度，定性命中率高），P2 = 仅体量告警
// 同档内按变更热点排序——热点文件才是"每次改都疼"的真巨石
const tier = (r: Row) => (r.flags.some((f) => f.startsWith('fn ') || f.startsWith('component ')) ? 1 : 2)
rows.sort((a, b) => tier(a) - tier(b) || b.churn - a.churn || b.lines - a.lines)

console.log(`# 复杂度探测报告（热点窗口: ${since}）`)
console.log('')
console.log('| 优先级 | 文件 | 行数 | 变更 | 信号 |')
console.log('|---|---|---|---|---|')
for (const r of rows) {
  const hot = r.churn >= CHURN_HOT ? '🔥' : ''
  console.log(`| P${tier(r)} | ${r.file} | ${r.lines} | ${r.churn}${hot} | ${r.flags.join('<br>')} |`)
}
console.log('')
console.log(`共 ${rows.length} 个文件命中阈值。对照 docs/complexity-baseline.md 的现在时表求差集，差集即新增告警。`)

// exit 1 = 有命中（当期事实，供 CI 决定是否递送报告；不含任何基线概念）
if (rows.length) process.exit(1)
