// reasoning 侧车存储：codex rollout 不持久化 reasoning items（thread/turns/list
// full 视图实测只有 userMessage+agentMessage），anyplane 自行落盘并在历史读取时按
// turn 时间窗回插，让"思考"在重进会话后仍可见。

import { appendFileSync, existsSync, statSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { ensurePrivateDir } from '../../util'

export interface ReasoningEntry {
  /** Unix ms */
  ts: number
  turnId: string | null
  text: string
}

function dir(): string {
  return ensurePrivateDir(join(homedir(), '.anyplane', 'reasoning'))
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

/** (size, mtimeMs) 记忆化：侧车是 append-only 且永不轮转，全量 re-parse 随使用量单调变贵；
 *  codex 历史读取（含子代理转录轮询回填）每次都调，不变时直接复用上次解析结果 */
const readCache = new Map<string, { size: number; mtimeMs: number; entries: ReasoningEntry[] }>()

export function readReasoning(threadId: string): ReasoningEntry[] {
  const p = pathOf(threadId)
  if (!existsSync(p)) return []
  try {
    const st = statSync(p)
    const hit = readCache.get(threadId)
    if (hit && hit.size === st.size && hit.mtimeMs === st.mtimeMs) return hit.entries
    const entries: ReasoningEntry[] = []
    for (const line of readFileSync(p, 'utf8').split('\n')) {
      const t = line.trim()
      if (!t.startsWith('{')) continue
      try {
        const o = JSON.parse(t) as ReasoningEntry
        if (typeof o.ts === 'number' && typeof o.text === 'string' && o.text.trim()) entries.push(o)
      } catch {}
    }
    readCache.set(threadId, { size: st.size, mtimeMs: st.mtimeMs, entries })
    return entries
  } catch {
    return []
  }
}
