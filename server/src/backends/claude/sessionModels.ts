// sessionId → 解析后模型 ID 的轻量持久化：live 会话 init 时登记，离线水合
// （backend.hydratedContextOf）据此做窗口大小启发式——transcript 里的 message.model
// 是 API 侧 ID（可能缺 [1m] 后缀，实测 "k3" vs init 的 "k3[1m]"），不能用作窗口依据。
// 落 ~/.anyplane/session-models.json（约定见 AGENTS.md：自产运行数据，不自动清理）。

import { join } from 'node:path'
import { ccDataDir, readJsonFile, writeJsonFile } from '../../util'

let storeFile: string | undefined
let table: Record<string, string> | undefined

function file(): string {
  return (storeFile ??= join(ccDataDir(), 'session-models.json'))
}

function load(): Record<string, string> {
  return (table ??= readJsonFile<Record<string, string>>(file()) ?? {})
}

/** init 报告解析后模型时登记；每 spawn 至多一次，同步写小文件成本可忽略 */
export function rememberSessionModel(sessionId: string, model: string): void {
  const t = load()
  if (t[sessionId] === model) return
  t[sessionId] = model
  try {
    writeJsonFile(file(), t)
  } catch {
    // 落盘失败不阻塞会话：下次 init 会再写
  }
}

export function sessionModelOf(sessionId: string): string | undefined {
  return load()[sessionId]
}

/** 测试钩子：重定向存储文件并重置内存缓存（不传则恢复默认路径） */
export function setStoreFileForTest(p: string | undefined): void {
  storeFile = p
  table = undefined
}
