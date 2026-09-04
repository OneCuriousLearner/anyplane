// 会话归档/回收站：无物理删除。
// - codex：官方 thread/archive（归档即回收站语义，rollout 与 sqlite 一致；thread/delete 不暴露）
// - claude：官方无归档概念——把 transcript 移入 ~/.anyplane/trash/claude/<slug>/（含 subagents 目录），
//   恢复时移回。仅离线会话可操作（与改名同一边界：进程活着的会话绝不碰）。

import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { config } from './config'
import { ccDataDir, ensurePrivateDir } from './util'

function trashRoot(): string {
  return ensurePrivateDir(join(ccDataDir(), 'trash', 'claude'))
}

/** rename 的跨文件系统兜底：CLAUDE_CONFIG_DIR 可指到与 ~/.anyplane 不同的挂载点（EXDEV）。
 *  非原子：cpSync 成功后、rmSync 前崩溃会留下双份；调用方/用户需手动清理回收站。
 */
function move(src: string, dest: string): void {
  try {
    renameSync(src, dest)
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code !== 'EXDEV') throw e
    cpSync(src, dest, { recursive: true })
    // 简单一致性校验（仅文件）：复制失败通常已抛错；这里避免 rmSync 掉尚未成功复制的源
    if (
      existsSync(src) &&
      existsSync(dest) &&
      statSync(src).isFile() &&
      statSync(src).size !== statSync(dest).size
    ) {
      throw new Error(`EXDEV 复制大小不一致: ${src} -> ${dest}`)
    }
    rmSync(src, { recursive: true, force: true })
  }
}

function transcriptPath(slug: string, sessionId: string): string {
  return join(config.claudeConfigDir, 'projects', slug, `${sessionId}.jsonl`)
}

export interface TrashEntry {
  key: string
  slug: string
  sessionId: string
  trashedAt?: string
  sizeBytes: number
  title?: string
}

/** claude 会话归档：jsonl + 可能的 subagents 目录一起移入回收站 */
export function archiveClaudeSession(slug: string, sessionId: string): void {
  const src = transcriptPath(slug, sessionId)
  if (!existsSync(src)) throw new Error('transcript 不存在')
  const destDir = join(trashRoot(), slug)
  mkdirSync(destDir, { recursive: true })
  const dest = join(destDir, `${sessionId}.jsonl`)
  if (existsSync(dest)) throw new Error('回收站已有同名会话（先恢复或手动清理）')
  move(src, dest)
  // 同名 subagents 目录（subagent transcript）一并移走
  const sideDir = join(config.claudeConfigDir, 'projects', slug, sessionId)
  if (existsSync(sideDir)) {
    move(sideDir, join(destDir, sessionId))
  }
  // 元信息（恢复依据 + 列表展示）
  writeFileSync(join(destDir, `${sessionId}.meta.json`), JSON.stringify({ trashedAt: new Date().toISOString() }))
}

/** 从回收站恢复到原 slug 目录 */
export function restoreClaudeSession(slug: string, sessionId: string): void {
  const destDir = join(trashRoot(), slug)
  const src = join(destDir, `${sessionId}.jsonl`)
  if (!existsSync(src)) throw new Error('回收站中没有该会话')
  const dest = transcriptPath(slug, sessionId)
  if (existsSync(dest)) throw new Error('原位置已有同名 transcript')
  const projectDir = join(config.claudeConfigDir, 'projects', slug)
  mkdirSync(projectDir, { recursive: true })
  move(src, dest)
  const sideDir = join(destDir, sessionId)
  if (existsSync(sideDir)) move(sideDir, join(projectDir, sessionId))
  const meta = join(destDir, `${sessionId}.meta.json`)
  if (existsSync(meta)) move(meta, join(destDir, `${sessionId}.meta.json.bak`))
}

/** 回收站列表（claude 部分） */
export function listTrash(): TrashEntry[] {
  const root = trashRoot()
  const out: TrashEntry[] = []
  for (const slug of readdirSync(root)) {
    const dir = join(root, slug)
    for (const file of readdirSync(dir)) {
      if (!file.endsWith('.jsonl')) continue
      const sessionId = basename(file, '.jsonl')
      const p = join(dir, file)
      let trashedAt: string | undefined
      try {
        const meta = JSON.parse(readFileSync(join(dir, `${sessionId}.meta.json`), 'utf8'))
        trashedAt = meta.trashedAt
      } catch {}
      let sizeBytes = 0
      try {
        sizeBytes = statSync(p).size
      } catch {}
      out.push({ key: `s|${slug}|${sessionId}`, slug, sessionId, trashedAt, sizeBytes })
    }
  }
  return out.sort((a, b) => (b.trashedAt ?? '').localeCompare(a.trashedAt ?? ''))
}
