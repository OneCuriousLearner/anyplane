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

/** git 子进程一次性执行（数组 argv 无 shell 拼接；10s 超时） */
function git(args: string[], cwd: string): { code: number; stdout: string; stderr: string } {
  const r = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    timeout: 10_000,
    // git.cmd shim（Windows npm 布局）需 shell 才能执行；.exe 不需要
    shell: process.platform === 'win32',
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
 * 移除 worktree。force=false 先试；git 因 dirty 拒绝时返回 { dirty }（路由层转 409 携带统计，
 * 前端确认「丢弃未提交改动」后再以 force=true 调第二步）。非 dirty 失败（目录被占/不存在）
 * 原样报错。只删目录与注册——分支保留（删分支是将来独立动作）。
 */
export function removeWorktree(mainRepoRoot: string, worktreePath: string, force: boolean): WorktreeRemoveResult {
  const args = ['worktree', 'remove', worktreePath]
  if (force) args.push('--force')
  const r = git(args, mainRepoRoot)
  if (r.code === 0) return { ok: true }
  const errText = r.stderr.trim()
  // dirty 拒绝的判定：git 报 "contains modified or untracked files"（不依赖退出码细分）
  if (!force && /modified or untracked/i.test(errText)) {
    const status = git(['-C', worktreePath, 'status', '--porcelain'], mainRepoRoot)
    return { ok: false, dirty: countDirty(status.stdout), error: errText }
  }
  return { ok: false, error: errText || `git worktree remove 退出码 ${r.code}` }
}

/** git 是否可用（路由层入口隐藏判定：git 缺席时整个 worktree 功能降级） */
export function gitAvailable(): boolean {
  const r = spawnSync('git', ['--version'], {
    encoding: 'utf8',
    timeout: 5_000,
    shell: process.platform === 'win32',
    env: childEnv(),
  })
  return r.status === 0
}
