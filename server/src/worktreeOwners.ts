// worktree 归属侧车：cwd → 主仓库根的持久映射（~/.anyplane/worktree-owners.json）。
// readGitInfo 的 worktreeOf 是实时读盘推导的——目录一删就归零，已删 worktree 的会话
// 退化成一个不知所属的裸组（09-27 专项缺口 3）。首次发现时把归属记到侧车，
// 目录删了分组归属还在（纪律内：自产数据不做自动清理；旧映射失效了也只是一行
// 无害的归属标注，不驱动任何写操作）。

import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ccDataDir, ensurePrivateDir } from './util'

let pathOverride: string | undefined

function sidecarPath(): string {
  return pathOverride ?? join(ensurePrivateDir(ccDataDir()), 'worktree-owners.json')
}

let table: Record<string, string> | undefined

function load(): Record<string, string> {
  if (table !== undefined) return table
  table = {}
  try {
    const raw = JSON.parse(readFileSync(sidecarPath(), 'utf8')) as Record<string, unknown>
    for (const [k, v] of Object.entries(raw)) {
      if (typeof v === 'string' && v) table[k] = v
    }
  } catch {
    // 首启/文件损坏：空表起步（下一次 record 重建）
  }
  return table
}

/** 查归属：cwd 曾被发现是 worktree 时返回主仓库根（目录已删也可能命中） */
export function worktreeOwnerOf(cwd: string | undefined): string | undefined {
  if (!cwd) return undefined
  return load()[cwd]
}

/** 记归属（发现 worktreeOf 时调用）：主仓库根自身不写。
 *  同步写——每轮列表刷新增量为零（只在首次发现时写一次），没有批处理必要 */
export function noteWorktree(cwd: string | undefined, worktreeOf: string | undefined): void {
  if (!cwd || !worktreeOf || cwd === worktreeOf) return
  const t = load()
  if (t[cwd] === worktreeOf) return
  t[cwd] = worktreeOf
  try {
    writeFileSync(sidecarPath(), JSON.stringify(t, null, 1) + '\n')
  } catch {
    // 写失败只丢持久性，本轮内存表已更新（下次启动重发现再写）
  }
}

/** 测试复位口：跨用例共享模块单态，开头必须调（bun test 单进程跨文件共享模块实例） */
export function resetWorktreeOwnersForTest(path?: string): void {
  table = undefined
  pathOverride = path
}
