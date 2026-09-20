// 根 package.json 的 version。启动横幅与更新检查共用，避免两处各读一次对不上。

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

export function packageVersion(): string {
  try {
    const raw = JSON.parse(readFileSync(resolve(import.meta.dir, '../../package.json'), 'utf8')) as {
      version?: unknown
    }
    return typeof raw.version === 'string' && raw.version ? raw.version : '0.0.0'
  } catch {
    return '0.0.0'
  }
}
