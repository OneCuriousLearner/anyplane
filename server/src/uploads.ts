// 图片上传落盘：~/.anyplane/uploads/。
// 用户自行管理（不自动清理）；hash 命名去重，同名同内容不会重复占盘。

import { createHash } from 'node:crypto'
import { existsSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { ensurePrivateDir } from './util'

export const ALLOWED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'] as const
/** claude API 硬限制：base64 后 5MB（constants/apiLimits.ts） */
export const MAX_IMAGE_BASE64 = 5 * 1024 * 1024

export interface ImageAttachment {
  name: string
  mediaType: string
  dataBase64: string
}

export function uploadsDir(): string {
  return ensurePrivateDir(join(homedir(), '.anyplane', 'uploads'))
}

const EXT_OF: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
}

/** 校验并落盘，返回绝对路径。超出限制/类型不支持抛错。 */
export function saveUpload(att: ImageAttachment): string {
  if (!ALLOWED_IMAGE_TYPES.includes(att.mediaType as (typeof ALLOWED_IMAGE_TYPES)[number])) {
    throw new Error(`不支持的图片类型 ${att.mediaType}（支持 jpeg/png/gif/webp）`)
  }
  if (att.dataBase64.length > MAX_IMAGE_BASE64) {
    throw new Error(`图片超过 5MB 限制（当前 ${(att.dataBase64.length / 1024 / 1024).toFixed(1)}MB）`)
  }
  const buf = Buffer.from(att.dataBase64, 'base64')
  if (buf.length === 0) throw new Error('图片内容为空')
  const hash = createHash('sha256').update(buf).digest('hex').slice(0, 16)
  const path = join(uploadsDir(), `${hash}.${EXT_OF[att.mediaType] ?? 'bin'}`)
  if (!existsSync(path)) writeFileSync(path, buf)
  return path
}

/** /api/uploads/<file> 的边界校验：只允许 uploads 目录内的 hash 命名文件 */
export function resolveUpload(name: string): string | null {
  if (!/^[0-9a-f]{16}\.(jpg|png|gif|webp)$/.test(name)) return null
  const path = join(uploadsDir(), name)
  return existsSync(path) ? path : null
}
