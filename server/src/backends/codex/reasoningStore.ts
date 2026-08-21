// reasoning 侧车存储：codex rollout 不持久化 reasoning items（thread/turns/list
// full 视图实测只有 userMessage+agentMessage），cc-remote 自行落盘并在历史读取时按
// turn 时间窗回插，让"思考"在重进会话后仍可见。

import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export interface ReasoningEntry {
  /** Unix ms */
  ts: number
  turnId: string | null
  text: string
}

function dir(): string {
  // 运行数据统一放 ~/.cc-remote；旧路径 ~/.config/cc-remote/reasoning 只做一次性迁移
  const root = join(homedir(), '.cc-remote')
  const d = join(root, 'reasoning')
  const legacy = join(homedir(), '.config', 'cc-remote', 'reasoning')
  if (!existsSync(d) && existsSync(legacy)) {
    try {
      mkdirSync(root, { recursive: true })
      renameSync(legacy, d)
      console.log('[codex] reasoning 目录已从 ~/.config/cc-remote 迁移到 ~/.cc-remote')
    } catch {}
  }
  if (!existsSync(d)) mkdirSync(d, { recursive: true })
  return d
}

function pathOf(threadId: string): string {
  // threadId 是 UUID，直接作文件名安全
  return join(dir(), `${threadId}.jsonl`)
}

export function appendReasoning(threadId: string, entry: ReasoningEntry): void {
  try {
    appendFileSync(pathOf(threadId), JSON.stringify(entry) + '\n')
  } catch (e) {
    console.warn('[codex] reasoning 侧车写入失败:', e)
  }
}

export function readReasoning(threadId: string): ReasoningEntry[] {
  const p = pathOf(threadId)
  if (!existsSync(p)) return []
  const out: ReasoningEntry[] = []
  for (const line of readFileSync(p, 'utf8').split('\n')) {
    const t = line.trim()
    if (!t.startsWith('{')) continue
    try {
      const o = JSON.parse(t) as ReasoningEntry
      if (typeof o.ts === 'number' && typeof o.text === 'string' && o.text.trim()) out.push(o)
    } catch {}
  }
  return out
}
