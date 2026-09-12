// Codex 历史双轨拉取与 turn 归并（paginated vs legacy）。

import { log } from '../../log'
import { readReasoning } from './reasoningStore'
import { reasoningSidecarUuid } from './mapping'
import { itemsToHistory, type HistoryMessage, type ThreadItem } from './translate'

export type RpcRequestFn = (method: string, params?: unknown, timeoutMs?: number) => Promise<unknown>

/** readHistory 双轨共享的 turn 归一形状：legacy 来自 thread/read includeTurns，
 *  paginated 来自 turns/list 元数据 + items/list 按 turnId 归组 */
export interface HistoryTurn {
  id?: string
  startedAt?: number | null
  completedAt?: number | null
  items?: ThreadItem[]
}

/** threadMeta 在线会话查找用的最小面 */
export interface ThreadMetaSession {
  threadId?: string
  historyMode?: string
  cwd?: string
}

export interface ThreadMetaContext {
  sessions: Iterable<ThreadMetaSession>
  cache: Map<string, { historyMode?: string; cwd?: string }>
}

/** 线程元数据（historyMode/cwd 都是创建即固定的量）单缓存：readHistory/historyModeOf/
 *  threadCwd 三处共用，避免同形 thread/read 复制与重复惰性往返（审查发现）。
 *  优先级：在线会话字段（0.153 起 start/resume 响应已带 historyMode）→ 进程内缓存 →
 *  一次 thread/read includeTurns:false。 */
export async function threadMeta(
  rpcRequest: RpcRequestFn,
  threadId: string,
  ctx: ThreadMetaContext,
): Promise<{ historyMode?: string; cwd?: string }> {
  for (const s of ctx.sessions) {
    if (s.threadId === threadId && (s.historyMode || s.cwd)) return { historyMode: s.historyMode, cwd: s.cwd }
  }
  const cached = ctx.cache.get(threadId)
  if (cached) return cached
  const res = (await rpcRequest('thread/read', { threadId, includeTurns: false }, 30_000)) as {
    thread?: { historyMode?: string; cwd?: string }
  }
  const meta = { historyMode: res.thread?.historyMode, cwd: res.thread?.cwd }
  ctx.cache.set(threadId, meta)
  return meta
}

export async function historyModeOf(
  rpcRequest: RpcRequestFn,
  threadId: string,
  ctx: ThreadMetaContext,
): Promise<string | undefined> {
  return (await threadMeta(rpcRequest, threadId, ctx)).historyMode
}

export async function threadCwd(
  rpcRequest: RpcRequestFn,
  threadId: string,
  ctx: ThreadMetaContext,
): Promise<string | undefined> {
  return (await threadMeta(rpcRequest, threadId, ctx)).cwd
}

async function readLegacyTurns(rpcRequest: RpcRequestFn, threadId: string): Promise<HistoryTurn[]> {
  const res = (await rpcRequest('thread/read', { threadId, includeTurns: true }, 60_000)) as {
    thread?: { turns?: HistoryTurn[] }
  }
  return res.thread?.turns ?? []
}

async function listTurnsMeta(
  rpcRequest: RpcRequestFn,
  threadId: string,
): Promise<Array<{ id?: string; startedAt?: number | null; completedAt?: number | null }>> {
  const turnsMeta: Array<{ id?: string; startedAt?: number | null; completedAt?: number | null }> = []
  let cursor: string | null | undefined
  do {
    const page = (await rpcRequest(
      'thread/turns/list',
      { threadId, limit: 100, sortDirection: 'asc', ...(cursor ? { cursor } : {}) },
      60_000,
    )) as {
      data?: Array<{ id?: string; startedAt?: number | null; completedAt?: number | null }>
      nextCursor?: string | null
    }
    turnsMeta.push(...(page.data ?? []))
    cursor = page.nextCursor ?? null
  } while (cursor)
  return turnsMeta
}

async function listItemsByTurn(rpcRequest: RpcRequestFn, threadId: string): Promise<Map<string, ThreadItem[]>> {
  const itemsByTurn = new Map<string, ThreadItem[]>()
  let cursor: string | null | undefined
  do {
    const page = (await rpcRequest(
      'thread/items/list',
      { threadId, limit: 500, ...(cursor ? { cursor } : {}) },
      60_000,
    )) as { data?: Array<{ turnId?: string; item?: ThreadItem }>; nextCursor?: string | null }
    for (const e of page.data ?? []) {
      // 缺 turnId/item 的 entry 不能静默丢弃（AGENTS.md 宽松解析红线）——上游包装形状
      // 漂移时抄本会凭空缺块且零日志，与孤儿 turnId 同口径 warn 留痕
      if (!e.turnId || !e.item) {
        log.warn('[codex] items/list 返回缺 turnId/item 的条目，已跳过', { threadId })
        continue
      }
      const arr = itemsByTurn.get(e.turnId) ?? []
      arr.push(e.item)
      itemsByTurn.set(e.turnId, arr)
    }
    cursor = page.nextCursor ?? null
  } while (cursor)
  return itemsByTurn
}

/** paginated 历史：turns/list 默认降序（新→旧，实测）——显式 asc 翻页拿元数据；
 *  items/list 不带 turnId 时跨 turn 升序分页（entry 为 {turnId, item} 包装，非裸 ThreadItem）。
 *  两段翻页相互独立（合并只消费两者的终态），并发启动：墙钟时间取较长一段而非相加。 */
async function readPaginatedTurns(rpcRequest: RpcRequestFn, threadId: string): Promise<HistoryTurn[]> {
  const [turnsMeta, itemsByTurn] = await Promise.all([listTurnsMeta(rpcRequest, threadId), listItemsByTurn(rpcRequest, threadId)])

  const seen = new Set<string>()
  const turns = turnsMeta.map((t) => {
    if (t.id) seen.add(t.id)
    return { ...t, items: t.id ? (itemsByTurn.get(t.id) ?? []) : [] }
  })
  // 防御：item 的 turnId 不在 turns/list 里（竞态/分页窗口交错）——按首见序追加为末段，不静默丢弃
  for (const [turnId, items] of itemsByTurn) {
    if (!seen.has(turnId)) {
      log.warn('[codex] items/list 出现 turns/list 之外的 turnId，按末段追加', { threadId, turnId })
      turns.push({ id: turnId, startedAt: null, completedAt: null, items })
    }
  }
  return turns
}

/** turn 序列 → 历史消息：itemsToHistory 翻译 + 侧车 reasoning 按 turn 时间窗回插 */
function turnsToHistory(threadId: string, turns: HistoryTurn[]): HistoryMessage[] {
  const reasoning = readReasoning(threadId)
  // 侧车 append-only 按时间递增；校验失败（手工编辑等）回退全扫，语义不变
  const reasoningSorted = reasoning.every((r, i) => i === 0 || reasoning[i - 1].ts <= r.ts)
  const used = new Set<number>()
  const out: HistoryMessage[] = []
  for (let ti = 0; ti < turns.length; ti++) {
    const turn = turns[ti]
    const msgs = itemsToHistory(turn.items ?? [], typeof turn.id === 'string' ? turn.id : undefined)
    if (reasoning.length > 0) {
      const start = turn.startedAt ?? 0
      // completedAt 缺失（中断/失败的 turn）：窗口收口到下一轮起点，
      // 否则只有 start+30s，中断前已落盘的 thinking 会被永久漏掉
      const nextStart = turns[ti + 1]?.startedAt
      const end = turn.completedAt ?? nextStart ?? Number.MAX_SAFE_INTEGER / 1000
      const loMs = (start - 1) * 1000
      const hiMs = end * 1000 + 30_000
      const hit: number[] = []
      if (reasoningSorted) {
        // 时间窗二分定位起点后线性到终点：O(log n + 命中数)，免每 turn 全扫侧车
        let lo = 0
        let hi = reasoning.length
        while (lo < hi) {
          const mid = (lo + hi) >> 1
          if (reasoning[mid].ts < loMs) lo = mid + 1
          else hi = mid
        }
        for (let i = lo; i < reasoning.length && reasoning[i].ts <= hiMs; i++) {
          if (!used.has(i)) hit.push(i)
        }
      } else {
        reasoning.forEach((r, i) => {
          if (!used.has(i) && r.ts >= loMs && r.ts <= hiMs) hit.push(i)
        })
      }
      if (hit.length > 0) {
        const thinkingMsgs = hit.map((i) => ({
          uuid: reasoningSidecarUuid(reasoning[i], i),
          role: 'assistant' as const,
          blocks: [{ kind: 'thinking' as const, text: reasoning[i].text }],
        }))
        // 插到该 turn 第一个 assistant 之前（userMessage 之后），保持叙事顺序
        const insertAt = msgs.findIndex((m) => m.role === 'assistant')
        msgs.splice(insertAt >= 0 ? insertAt : msgs.length, 0, ...thinkingMsgs)
        hit.forEach((i) => used.add(i))
      }
    }
    out.push(...msgs)
  }
  return out
}

/** 历史双轨（0.153.4 实测）：
 *  - paginated 线程：`thread/turns/list`（turn 元数据，供 rewindable 锚点与侧车时间窗）
 *    + `thread/items/list`（全量 item，跨 turn 升序分页）——item 与 live itemCompleted 同形同 id；
 *  - legacy 线程：`thread/read includeTurns`（items/list 对 legacy 报 -32601，无法借用分页补齐——
 *    legacy 历史的 commandExecution/collab/reasoning 缺失是上游未修的持久化缺口，维持现状）。
 *  两侧共用 turnsToHistory（itemsToHistory + 侧车 reasoning 按 turn 时间窗回插）。 */
export async function readHistoryForThread(
  rpcRequest: RpcRequestFn,
  threadId: string,
  ctx: ThreadMetaContext,
): Promise<HistoryMessage[]> {
  // historyMode 走 threadMeta 缓存（同线程重复打开/回滚判定不再各付一次 thread/read）
  const mode = (await threadMeta(rpcRequest, threadId, ctx)).historyMode
  const turns = mode === 'paginated' ? await readPaginatedTurns(rpcRequest, threadId) : await readLegacyTurns(rpcRequest, threadId)
  return turnsToHistory(threadId, turns)
}

/** 原地回滚（paginated 线程）：thread/revert 用 beforeTurnId 之前的持久历史替换现状——
 *  thread id、连接、订阅全部保留（app-server 内部 shutdown→截断→reload），
 *  完成后服务端发 thread/reverted 通知（经 handleNotification 广播）。 */
export async function revertAt(rpcRequest: RpcRequestFn, threadId: string, beforeTurnId: string): Promise<void> {
  await rpcRequest('thread/revert', { threadId, beforeTurnId }, 60_000)
}

/** 分叉回滚：thread/fork beforeTurnId——复制该轮之前的历史为新线程，原线程不动 */
export async function forkAt(rpcRequest: RpcRequestFn, threadId: string, beforeTurnId: string): Promise<string> {
  const res = (await rpcRequest('thread/fork', { threadId, beforeTurnId }, 60_000)) as {
    thread: { id: string }
  }
  return res.thread.id
}

// paginate 留 runtime（model/list、thread/list 专用），history 模块不引入
