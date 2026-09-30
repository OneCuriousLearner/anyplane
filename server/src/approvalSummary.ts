// 审批输入摘要（推送通知/审批页/approval_auto 留痕卡共用唯一口径）：按工具挑裁决所需的
// 关键字段，其余给 JSON 截断。与 web 端 toolSummary 同族但取舍不同——审批场景 Bash 必须给
// command 本体（description 是作者给的说明文字，不能作为裁决依据）。
// 家在本模块（叶子）而非 push/fanout：hub 层广播 approval_auto 也需要它，push→hub 单向红线不能破。
// cwd 外警示（outsideCwd）同家：审批卡的「⚠ 触及工作目录之外」徽与推送摘要共用检测口径。

import { existsSync, readFileSync, statSync } from 'node:fs'
import { resolve } from 'node:path'

export function summarizeInput(toolName: string, input: unknown): string {
  const obj = (input ?? {}) as Record<string, unknown>
  if (toolName === 'Bash') return String(obj.command ?? '').slice(0, 400)
  if (toolName === 'Glob' || toolName === 'Grep') return String(obj.pattern ?? '')
  if (toolName === 'WebSearch') return String(obj.query ?? '')
  if (toolName === 'WebFetch') return String(obj.url ?? '')
  if (toolName === 'Agent') return String(obj.description ?? obj.prompt ?? '').slice(0, 300)
  if (obj.file_path) return String(obj.file_path)
  if (obj.path) return String(obj.path)
  if (obj.grantRoot) return String(obj.grantRoot)
  const json = JSON.stringify(input ?? {})
  return json.length > 300 ? json.slice(0, 300) + '…' : json
}

// ---------- cwd 外路径警示（C2） ----------

/** 路径归一：分隔符统一为 `/`、剥尾斜杠；Windows 另做整体小写（NTFS 不区分大小写——
 *  模型常发全小写路径，段级大小写敏感会把 cwd 树内路径误报成「之外」）+ 盘符/MSYS 形态归一。
 *  MSYS 重写（/d/... → d:/...）只在 win32 生效——POSIX 上 `/Users/foo` 会被 mangling 成
 *  `u:sers/foo`，existsSync 永远找不到 `.git`，家族豁免在非 Windows 静默全灭（review 轮） */
function normPath(p: string): string {
  let s = p.replace(/\\/g, '/')
  if (process.platform === 'win32') {
    const msys = /^\/([a-zA-Z])(?=\/|$)/.exec(s)
    if (msys) s = `${msys[1]}:${s.slice(2)}`
    s = s.toLowerCase()
  }
  return s.replace(/\/+$/, '')
}

/** 绝对路径判定：Windows 盘符 / UNC / POSIX 根 */
function isAbsolutePath(p: string): boolean {
  return /^([A-Za-z]:[\\/]|\\\\|\/)/.test(p)
}

/** 收集审批输入里的绝对路径候选（字段集合与 approvalRules.extractPaths 对齐 + input.cwd）。
 *  Bash 的 command 是自由文本不做解析（假阳性比漏报更伤信任）。 */
function absolutePathsOf(input: unknown): string[] {
  if (!input || typeof input !== 'object') return []
  const obj = input as Record<string, unknown>
  const out: string[] = []
  const add = (v: unknown) => {
    if (typeof v === 'string' && isAbsolutePath(v)) out.push(v)
  }
  add(obj.file_path)
  add(obj.path)
  add(obj.grantRoot)
  add(obj.cwd)
  if (Array.isArray(obj.paths)) for (const p of obj.paths) add(p)
  return [...new Set(out)]
}

/** 目录的 git 公共目录（commondir）：普通仓库是自身 .git；worktree 的 .git 是指向文件，
 *  且 git ≥2.5 提供 commondir 文件直指公共目录（读不到时按 worktrees/<name> 布局剥两层兜底，
 *  与 fsbrowse.readGitInfo 同一布局知识）。非仓库返回 undefined。 */
function gitCommonDir(dir: string): string | undefined {
  try {
    const dotGit = resolve(dir, '.git')
    if (statSync(dotGit).isDirectory()) return normPath(dotGit)
    const ptr = readFileSync(dotGit, 'utf8').trim()
    if (!ptr.startsWith('gitdir:')) return undefined
    const gitdir = resolve(dir, ptr.slice(7).trim())
    try {
      const common = readFileSync(resolve(gitdir, 'commondir'), 'utf8').trim()
      if (common) return normPath(resolve(gitdir, common))
    } catch {
      // 无 commondir 文件：按 <公共目录>/worktrees/<name> 布局剥两层
    }
    const norm = normPath(gitdir)
    const m = /^(.*)\/worktrees\/[^/]+$/.exec(norm)
    return m ? m[1] : undefined
  } catch {
    return undefined
  }
}

/** 从 start 逐级向上找最近的 .git（文件或目录），返回其 commondir；到根都没找到返回 undefined。
 *  审批路径不热，每级一次 existsSync 可接受（目标路径可能尚未创建，不能从路径自身 stat 起）。 */
function enclosingGitCommonDir(start: string): string | undefined {
  let dir = normPath(start)
  for (;;) {
    if (existsSync(`${dir}/.git`)) return gitCommonDir(dir)
    if (/^[a-z]:$/i.test(dir)) return undefined // 盘符根（.git 上面已查过）
    const parent = dir.includes('/') ? dir.slice(0, dir.lastIndexOf('/')) : ''
    if (!parent || parent === dir) return undefined
    dir = parent
  }
}

/**
 * cwd 外路径警示：候选路径与会话 cwd 不同源时返回该路径（第一条），全部同源/无候选返回 undefined。
 * 同源判定两级：① 字面包含（cwd 子树内）；② 同仓库家族豁免——共同 git commondir
 *（主仓 ↔ 其任何 worktree：agent 受用户之托在自建 worktree 干活是官方玩法，逐次警示 = 警报疲劳）。
 * 跨仓库/系统路径（从隔壁项目拷 node_modules 那类）才报。会话 cwd 未知时不报（宁可沉默）。
 */
export function outsideCwdPath(input: unknown, sessionCwd: string | undefined): string | undefined {
  if (!sessionCwd) return undefined
  const cwd = normPath(sessionCwd)
  if (!cwd) return undefined
  const cwdCommon = enclosingGitCommonDir(cwd)
  for (const candidate of absolutePathsOf(input)) {
    const c = normPath(candidate)
    if (c === cwd || c.startsWith(`${cwd}/`)) continue
    if (cwdCommon && enclosingGitCommonDir(c) === cwdCommon) continue
    return candidate
  }
  return undefined
}
