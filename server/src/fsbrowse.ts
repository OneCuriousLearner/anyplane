// 新会话目录选择器的本地目录列举：仅目录、单层、懒加载友好

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** 读 git 分支名（普通仓库 .git/HEAD；worktree 的 .git 是 gitdir 指向文件）。非仓库返回 undefined */
export function readGitBranch(cwd: string): string | undefined {
  try {
    let head: string
    if (statSync(join(cwd, '.git')).isDirectory()) {
      head = readFileSync(join(cwd, '.git', 'HEAD'), 'utf8').trim()
    } else {
      const ptr = readFileSync(join(cwd, '.git'), 'utf8').trim()
      if (!ptr.startsWith('gitdir:')) return undefined
      head = readFileSync(join(ptr.slice(7).trim(), 'HEAD'), 'utf8').trim()
    }
    if (head.startsWith('ref:')) {
      return head.split('/').pop() ?? head
    }
    return head.slice(0, 7) // detached HEAD：短 sha
  } catch {
    return undefined
  }
}

export interface DirEntry {
  name: string
  path: string
}

export interface DirListResult {
  /** 当前目录；根集合视图为 '' */
  path: string
  /** 父目录；根集合/盘符根/POSIX `/` 时为 null */
  parent: string | null
  entries: DirEntry[]
  /** 用户主目录，作为快捷入口始终返回 */
  home: string
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
  const msg = e instanceof Error ? e.message : String(e)
  return new FsBrowseError(500, `读取失败: ${msg}`)
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

  let dirents
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
