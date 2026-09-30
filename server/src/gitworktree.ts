// worktree 生命周期：产品内创建（git worktree add）与移除（git worktree remove）。
// 项目首次 shell out git——纪律：所有 git 调用集中本模块，参数一律数组形式（无 shell 拼接），
// 路径与分支名在边界做字符闸；git 缺席由调用方（路由层 which 探测）前置隐藏入口。
//
// dirty 两步走（E1 备注，这是常见路径不是边角）：agent 干完活的 worktree 几乎必然有
// 未提交改动，而 `git worktree remove` 对 dirty 树默认拒绝。先不带 --force 试；被拒时把
// 「N 个已修改 / M 个未跟踪」摆进确认框，用户显式确认才走第二步强制——绝不静默 --force。

import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { childEnv } from './util'

/** 解析 git 可执行路径：优先 .exe（直接 spawn 无 shell——Windows 上 shell:true 会把未引用
 *  的含空格路径拆成多参数，git 报 invalid reference，review 轮实锤）；找不到 .exe 再回退
 *  裸 'git'（POSIX 走 PATH 解析；Windows 的 .cmd shim 场景退给 shell:true 调用方处理） */
function resolveGitCmd(): { cmd: string; shell: boolean } {
  if (process.platform === 'win32') {
    const exe = Bun.which('git.exe') ?? Bun.which('git')
    if (exe && exe.toLowerCase().endsWith('.exe')) return { cmd: exe, shell: false }
    return { cmd: exe ?? 'git', shell: true } // .cmd shim 必须经 shell
  }
  return { cmd: 'git', shell: false }
}

/** git 子进程一次性执行（数组 argv；10s 超时）。shell 只在解析不到 .exe 时启用 */
function git(args: string[], cwd: string): { code: number; stdout: string; stderr: string } {
  const { cmd, shell } = resolveGitCmd()
  const r = spawnSync(cmd, args, {
    cwd,
    encoding: 'utf8',
    timeout: 10_000,
    shell,
    env: childEnv(),
  })
  return {
    code: r.status ?? 1,
    stdout: (r.stdout ?? '').toString(),
    stderr: ((r.stderr ?? '') as string).toString() + (r.error ? ` ${r.error.message}` : ''),
  }
}

/** worktree 名/分支名的字符闸：字母数字/点/下划线/连字符，禁路径分隔与空格（防注入与怪目录） */
const NAME_RE = /^[A-Za-z0-9._-]+$/

export interface WorktreeAddResult {
  ok: boolean
  /** 落盘绝对路径（成功时必有） */
  path?: string
  /** 分支名（成功时必有） */
  branch?: string
  error?: string
}

/**
 * 创建 worktree：`git worktree add <path> -b worktree-<name>`（落盘主仓同级 <repo>-<name>）。
 * mainRepoRoot 必须是仓库根（路由层 readGitInfo 已校验其为主仓）；name 过字符闸。
 * 分支已存在/目录已存在/git 报错都原样上抛文案（用户要能看到「分支 worktree-x 已存在」）。
 */
export function addWorktree(mainRepoRoot: string, name: string): WorktreeAddResult {
  if (!NAME_RE.test(name)) {
    return { ok: false, error: 'worktree 名只接受字母数字/点/下划线/连字符' }
  }
  const path = join(dirname(mainRepoRoot), `${mainRepoRoot.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? 'repo'}-${name}`)
  const branch = `worktree-${name}`
  const r = git(['worktree', 'add', path, '-b', branch], mainRepoRoot)
  if (r.code !== 0) {
    return { ok: false, error: r.stderr.trim() || `git worktree add 退出码 ${r.code}` }
  }
  return { ok: true, path, branch }
}

export interface WorktreeDirtyInfo {
  /** 已修改（含暂存与未暂存的跟踪文件改动） */
  modified: number
  /** 未跟踪 */
  untracked: number
}

/** `git status --porcelain` 行首两列：XY。未跟踪是 `??`；其余任一位非空即改动 */
export function countDirty(porcelain: string): WorktreeDirtyInfo {
  let modified = 0
  let untracked = 0
  for (const line of porcelain.split('\n')) {
    if (!line.trim()) continue
    if (line.startsWith('??')) untracked++
    else modified++
  }
  return { modified, untracked }
}

export interface WorktreeRemoveResult {
  ok: boolean
  /** dirty 被拒（first pass 未 --force）：附脏区统计，由路由层转 409 让前端走确认第二步 */
  dirty?: WorktreeDirtyInfo
  error?: string
}

/**
 * 移除 worktree。force=false 先试；失败时不依赖 git 英文报错文案——直接查
 * `git status --porcelain`：有改动即返回 { dirty }（路由层转 409 让前端走确认第二步，
 * 与 git 界面语言无关，review 轮）；无改动则是占用/锁/不存在等真失败，原样报错。
 * 只删目录与注册——分支保留（删分支是将来独立动作）。
 */
export function removeWorktree(mainRepoRoot: string, worktreePath: string, force: boolean): WorktreeRemoveResult {
  const args = ['worktree', 'remove', worktreePath]
  if (force) args.push('--force')
  const r = git(args, mainRepoRoot)
  if (r.code === 0) return { ok: true }
  const errText = r.stderr.trim()
  // 失败即查脏区（不依赖 "modified or untracked" 文案——本地化 git 不报英文，review 轮）：
  // 有改动 = dirty 两步走；无改动 = 占用/锁/不存在
  if (!force) {
    const status = git(['-C', worktreePath, 'status', '--porcelain'], mainRepoRoot)
    const dirty = countDirty(status.stdout)
    if (dirty.modified > 0 || dirty.untracked > 0) {
      return { ok: false, dirty, error: errText }
    }
  }
  return { ok: false, error: errText || `git worktree remove 退出码 ${r.code}` }
}

/** worktree 的脏区统计（路由层「dispose 后重试」路径与 dirty 检测共用） */
export function dirtyOf(worktreePath: string): WorktreeDirtyInfo {
  const status = git(['-C', worktreePath, 'status', '--porcelain'], dirname(worktreePath))
  return countDirty(status.stdout)
}

// ---------- E2 改动摘要（侧栏「改动」页签数据源） ----------

export interface StatusFileEntry {
  /** 相对仓库根的路径（porcelain 原样，分隔符未归一） */
  path: string
  /** porcelain XY 两列原样（如 " M"/"A "/"??"/"MM"） */
  xy: string
  /** 分组：modified（跟踪文件改动）/ added（新增含暂存 A）/ deleted（D）/ untracked（??） */
  kind: 'modified' | 'added' | 'deleted' | 'untracked'
}

export interface GitStatusSummary {
  branch?: string
  files: StatusFileEntry[]
  counts: WorktreeDirtyInfo & { deleted: number }
}

/** porcelain 单行的分组判定：?? 未跟踪；含 D 删除；含 A 新增；其余改动 */
function kindOf(xy: string): StatusFileEntry['kind'] {
  if (xy === '??') return 'untracked'
  if (xy.includes('D')) return 'deleted'
  if (xy.includes('A')) return 'added'
  return 'modified'
}

/** 解析 `git status --porcelain` 为按组排序的文件清单（untracked → modified → added → deleted 的
 *  展示序由前端决定，本函数只按 kind 分组标好）。rename（"R  old -> new"）取新路径。 */
export function parseStatusPorcelain(porcelain: string): StatusFileEntry[] {
  const out: StatusFileEntry[] = []
  for (const line of porcelain.split('\n')) {
    if (!line.trim()) continue
    const xy = line.slice(0, 2)
    let path = line.slice(3)
    const arrow = path.indexOf(' -> ')
    if (arrow >= 0) path = path.slice(arrow + 4)
    out.push({ path, xy, kind: kindOf(xy) })
  }
  return out
}

/** 按会话 cwd 的改动摘要：分支 + 文件清单 + 分组计数。非 git 目录/git 失败返回 undefined（前端隐藏入口） */
export function statusSummaryOf(cwd: string): GitStatusSummary | undefined {
  const status = git(['-C', cwd, 'status', '--porcelain'], cwd)
  if (status.code !== 0) return undefined
  const branchR = git(['-C', cwd, 'branch', '--show-current'], cwd)
  const files = parseStatusPorcelain(status.stdout)
  const counts = { modified: 0, untracked: 0, deleted: 0 }
  for (const f of files) {
    if (f.kind === 'untracked') counts.untracked++
    else if (f.kind === 'deleted') counts.deleted++
    else counts.modified++ // added 并入 modified 计数展示（分组时仍单列）
  }
  return { branch: branchR.stdout.trim() || undefined, files, counts }
}

/** git 是否可用（路由层入口隐藏判定：git 缺席时整个 worktree 功能降级） */
export function gitAvailable(): boolean {
  const { cmd, shell } = resolveGitCmd()
  const r = spawnSync(cmd, ['--version'], {
    encoding: 'utf8',
    timeout: 5_000,
    shell,
    env: childEnv(),
  })
  return r.status === 0
}
