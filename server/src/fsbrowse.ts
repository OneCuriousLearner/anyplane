// 新会话目录选择器的本地目录列举：仅目录、单层、懒加载友好
// DirEntry/DirListResult 正本在 @anyplane/protocol（前端 DirPicker 共用）

import { existsSync, readdirSync, readFileSync, statSync, type Dirent } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import type { DirEntry, DirListResult } from '@anyplane/protocol'
import { errorMessage } from './util'

/** 目录的 git 信息：分支名；cwd 本身是 worktree 时附主仓库根路径。非仓库返回 undefined */
export interface GitInfo {
  branch?: string
  worktreeOf?: string
}

/**
 * 读 git 信息（普通仓库 .git/HEAD；worktree 的 .git 是 gitdir 指向文件）。
 * worktree 判定：gitdir 的固定布局是 <git 公共目录>/worktrees/<name>——剥掉该后缀得
 * 公共目录，再以结尾形态区分宿主：`.../.git` → 普通仓库（宿主是父目录）；
 * `....git`（bare）→ 宿主即其自身；含 `/.git/modules/` 的是子模块的 worktree——
 * 从 gitdir 反推不出子模块 checkout 路径，不标注（分支仍读，仅缺徽章）。
 */
export function readGitInfo(cwd: string): GitInfo | undefined {
  try {
    if (statSync(join(cwd, '.git')).isDirectory()) {
      return { branch: readHeadBranch(join(cwd, '.git')) }
    }
    const ptr = readFileSync(join(cwd, '.git'), 'utf8').trim()
    if (!ptr.startsWith('gitdir:')) return undefined
    // gitdir 允许相对路径（相对 cwd），先归一为绝对路径再反推
    const gitdir = resolve(cwd, ptr.slice(7).trim())
    const info: GitInfo = { branch: readHeadBranch(gitdir) }
    // 分隔符归一后剥布局后缀（worktreeOf 因此是正斜杠归一路径——跨平台一致的 wire 形态）
    const norm = gitdir.replaceAll('\\', '/')
    const m = /^(.*)\/worktrees\/[^/]+\/?$/.exec(norm)
    if (m && !m[1]!.includes('/.git/modules/')) {
      const common = m[1]!
      if (common.endsWith('/.git')) info.worktreeOf = common.slice(0, -'/.git'.length)
      else if (common.endsWith('.git')) info.worktreeOf = common
    }
    return info
  } catch {
    return undefined
  }
}

/** 读 gitdir 下 HEAD 的分支名；detached HEAD 给短 sha；读不到为 undefined */
function readHeadBranch(gitdir: string): string | undefined {
  try {
    const head = readFileSync(join(gitdir, 'HEAD'), 'utf8').trim()
    if (head.startsWith('ref:')) return head.split('/').pop() ?? head
    return head.slice(0, 7)
  } catch {
    return undefined
  }
}

/** 带 HTTP 状态码的错误，由路由层映射为响应 */
export class FsBrowseError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message)
  }
}

function mapError(e: unknown, target: string): FsBrowseError {
  const code = (e as NodeJS.ErrnoException)?.code
  if (code === 'ENOENT') return new FsBrowseError(400, `路径不存在: ${target}`)
  if (code === 'ENOTDIR') return new FsBrowseError(400, `不是目录: ${target}`)
  if (code === 'EPERM' || code === 'EACCES') return new FsBrowseError(403, `无法访问（权限不足）: ${target}`)
  return new FsBrowseError(500, `读取失败: ${errorMessage(e)}`)
}

/** 平台根集合：Windows 为可用盘符，POSIX 为 /；均附带 home 快捷项 */
function roots(home: string): DirEntry[] {
  const entries: DirEntry[] = []
  if (process.platform === 'win32') {
    for (let c = 65; c <= 90; c++) {
      const drive = `${String.fromCharCode(c)}:\\`
      // 单个盘符探测失败（断连的网络盘等）只跳过，不影响其他
      try {
        if (existsSync(drive)) entries.push({ name: drive, path: drive })
      } catch {}
    }
  } else {
    entries.push({ name: '/', path: '/' })
  }
  if (home) entries.push({ name: '~', path: home })
  return entries
}

export function listDirectories(target: string): DirListResult {
  const home = homedir()
  if (!target) {
    return { path: '', parent: null, entries: roots(home), home }
  }

  let isDir: boolean
  try {
    isDir = statSync(target).isDirectory()
  } catch (e) {
    throw mapError(e, target)
  }
  if (!isDir) throw new FsBrowseError(400, `不是目录: ${target}`)

  let dirents: Dirent[] | undefined
  try {
    dirents = readdirSync(target, { withFileTypes: true })
  } catch (e) {
    throw mapError(e, target)
  }

  const entries = dirents
    .filter((d) => {
      if (d.isDirectory()) return true
      // 符号链接/junction 指向目录的也算（Dirent 只反映链接自身类型，需 stat 跟随）
      if (d.isSymbolicLink()) {
        try {
          return statSync(join(target, d.name)).isDirectory()
        } catch {
          return false
        }
      }
      return false
    })
    .map((d) => ({ name: d.name, path: join(target, d.name) }))
    .sort((a, b) => a.name.localeCompare(b.name))

  // dirname 对盘符根（C:\）与 POSIX / 都返回自身，以此判定"已到根"
  const parentDir = dirname(target)
  return { path: target, parent: parentDir === target ? null : parentDir, entries, home }
}
