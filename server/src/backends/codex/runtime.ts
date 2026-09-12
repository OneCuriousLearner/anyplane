// CodexRuntime：单个 codex app-server 进程托管全部 Codex 线程。
// CodexSession 见 session.ts；事件经 ThreadTranslator 翻译成 claude stream-json 形状后走统一回调。

import type { SessionCallbacks } from '../types'
import { RpcClient } from './rpc'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { HistoryMessage } from './translate'
import { log } from '../../log'
import { CodexSession, type CodexSpawnOpts } from './session'
import {
  forkAt as forkAtThread,
  historyModeOf as historyModeOfThread,
  readHistoryForThread,
  revertAt as revertAtThread,
  threadCwd as threadCwdForThread,
} from './history'

export { CodexSession, type CodexSpawnOpts } from './session'
export {
  extractTokenCountFromRolloutTail,
  mapPermissionMode,
  reasoningSidecarUuid,
  sandboxPolicyOf,
  type RolloutTokenCount,
} from './mapping'

type Params = Record<string, unknown>

// ---------- 运行时单例 ----------

interface EphemeralCollector {
  resolve: (r: { text: string; usage?: Record<string, number> }) => void
  reject: (e: Error) => void
  text: string
  usage?: Record<string, number>
  timer: Timer
  /** 超时中断用：turn/started 报回的 turnId */
  turnId?: string
  /** 增量回调（btw 流式展示用） */
  onDelta?: (delta: string, thinking?: boolean) => void
}

export class CodexRuntime {
  private rpc: RpcClient | undefined
  private starting: Promise<RpcClient> | undefined
  private sessions = new Map<string, CodexSession>()
  private threadMetaCache = new Map<string, { historyMode?: string; cwd?: string }>()
  private byThread = new Map<string, CodexSession>()
  /** ephemeral fork（/btw、接力简报）的临时事件收集器，按 threadId 路由 */
  private collectors = new Map<string, EphemeralCollector>()
  /** initialize 应答的 codexHome（rollout 水合定位 sessions/ 目录用） */
  private reportedHome: string | undefined

  /** codex 数据根目录：initialize 上报值优先，回退 CODEX_HOME env / ~/.codex */
  get home(): string {
    return this.reportedHome ?? process.env.CODEX_HOME ?? join(homedir(), '.codex')
  }

  async ensureRpc(): Promise<RpcClient> {
    if (this.rpc && !this.rpc.exited) return this.rpc
    if (this.starting) return this.starting
    this.starting = (async () => {
      const rpc = RpcClient.spawn(['codex', 'app-server', '--stdio'])
      rpc.onNotification = (n) => this.demux(n.method, n.params as Params)
      rpc.onServerRequest = (r) => this.demuxRequest(r.id, r.method, r.params as Params)
      rpc.onExit = (code) => {
        log.error(`[codex] app-server 退出 code=${code}`)
        this.rpc = undefined
        for (const s of this.sessions.values()) s.handleProcessExit()
      }
      const initRes = (await rpc.request('initialize', {
        clientInfo: { name: 'anyplane', title: 'anyplane', version: '0.2.0' },
        capabilities: { experimentalApi: true },
      })) as { codexHome?: string }
      if (typeof initRes.codexHome === 'string') this.reportedHome = initRes.codexHome
      rpc.notify('initialized', {})
      this.rpc = rpc
      log.info('[codex] app-server 已启动并完成握手')
      return rpc
    })()
    try {
      return await this.starting
    } finally {
      this.starting = undefined
    }
  }

  async rpcRequest(method: string, params?: unknown, timeoutMs?: number): Promise<unknown> {
    const rpc = await this.ensureRpc()
    return rpc.request(method, params, { timeoutMs })
  }

  respondSafe(id: number | string, result: unknown): void {
    try {
      this.rpc?.respond(id, result)
    } catch (e) {
      log.error('[codex] 审批应答失败:', e)
    }
  }

  registerThread(threadId: string, s: CodexSession): void {
    this.byThread.set(threadId, s)
  }
  unregisterThread(threadId: string, s?: CodexSession): void {
    if (!s || this.byThread.get(threadId) === s) this.byThread.delete(threadId)
  }

  /** collab 子线程路由表：子线程 id → 父会话与嵌套深度（直接子代理=1，孙代理=2…）。
   *  0.148 起子线程实时事件推到父连接（父子事件链），demux 经此表转发给父会话进侧栏桶。 */
  private children = new Map<string, { parent: CodexSession; depth: number }>()
  /** 未知线程事件的告警去重（子线程 delta 高频，每线程只留一次痕） */
  private unknownThreadWarned = new Set<string>()

  registerChild(childThreadId: string, parent: CodexSession, depth: number): void {
    if (!this.children.has(childThreadId)) {
      this.children.set(childThreadId, { parent, depth })
      this.unknownThreadWarned.delete(childThreadId)
    }
  }

  unregisterChildrenOf(parent: CodexSession): void {
    for (const [tid, link] of this.children) {
      if (link.parent === parent) this.children.delete(tid)
    }
  }

  private demux(method: string, params: Params): void {
    const threadId = typeof params.threadId === 'string' ? params.threadId : undefined
    if (threadId) {
      const collector = this.collectors.get(threadId)
      if (collector) {
        this.feedCollector(threadId, collector, method, params)
        return
      }
      const session = this.byThread.get(threadId)
      if (session) {
        session.handleNotification(method, params)
        return
      }
      const link = this.children.get(threadId)
      if (link) {
        if (!link.parent.exited) link.parent.handleChildNotification(threadId, link.depth, method, params)
        else this.children.delete(threadId)
        return
      }
      // 注册前抢先到达的子线程事件（attach 中途接入运行中的 collab 也会在此）：
      // 终态拉取兜底，不丢正确性；每线程留一次痕便于排查路由缺口
      if (!this.unknownThreadWarned.has(threadId)) {
        this.unknownThreadWarned.add(threadId)
        log.warn('[codex] 收到未注册线程的事件，已跳过（attach 中途接入或路由缺口）', {
          threadId: threadId.slice(0, 8),
          method,
        })
      }
    }
    // 无 threadId 的全局通知（account/*、remoteControl/* 等）暂不处理
  }

  private feedCollector(threadId: string, c: EphemeralCollector, method: string, params: Params): void {
    if (method === 'turn/started') {
      c.turnId = (params.turn as { id?: string } | undefined)?.id
    } else if (method === 'item/completed') {
      const item = params.item as { type?: string; text?: string } | undefined
      if (item?.type === 'agentMessage' && item.text) c.text += item.text
    } else if (method === 'item/agentMessage/delta') {
      c.onDelta?.(String(params.delta ?? ''), false)
    } else if (method === 'item/reasoning/textDelta' || method === 'item/reasoning/summaryTextDelta') {
      c.onDelta?.(String(params.delta ?? ''), true)
    } else if (method === 'thread/tokenUsage/updated') {
      const usage = (params.tokenUsage as { last?: Record<string, number> } | undefined)?.last
      if (usage) c.usage = usage
    } else if (method === 'turn/completed') {
      const turn = params.turn as { status?: string; error?: { message?: string } | null } | undefined
      clearTimeout(c.timer)
      this.collectors.delete(threadId)
      if (turn?.status === 'completed') c.resolve({ text: c.text.trim(), usage: c.usage })
      else c.reject(new Error(turn?.error?.message ?? `fork 问答未完成 (${turn?.status ?? '?'})`))
    } else if (method === 'error') {
      clearTimeout(c.timer)
      this.collectors.delete(threadId)
      const err = params.error as { message?: string } | undefined
      c.reject(new Error(err?.message ?? 'codex 错误'))
    }
  }

  /**
   * ephemeral fork 一次性问答：fork 源线程（纯内存不落盘）→ 单轮提问 → 收集回答。
   * 用于 Codex 侧交接简报生成与 /btw 侧问。只读沙箱 + 无审批，保证不会改现场。
   */
  async runEphemeralQuestion(
    sourceThreadId: string,
    question: string,
    timeoutMs = 180_000,
    onDelta?: (delta: string, thinking?: boolean) => void,
  ): Promise<{ text: string; usage?: Record<string, number> }> {
    const fork = (await this.rpcRequest('thread/fork', { threadId: sourceThreadId, ephemeral: true }, 60_000)) as {
      thread: { id: string }
    }
    const forkId = fork.thread.id
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const col = this.collectors.get(forkId)
        this.collectors.delete(forkId)
        // 超时只是调用方不等了：app-server 还在为无人消费的 ephemeral fork 烧 token，补一发中断
        if (col?.turnId) {
          void this.rpcRequest('turn/interrupt', { threadId: forkId, turnId: col.turnId }, 10_000).catch(() => {})
        }
        reject(new Error('fork 问答超时'))
      }, timeoutMs)
      this.collectors.set(forkId, { resolve, reject, text: '', timer, onDelta })
      this.rpcRequest('turn/start', {
        threadId: forkId,
        input: [{ type: 'text', text: question }],
        approvalPolicy: 'never',
        sandboxPolicy: { type: 'readOnly' },
      }).catch((e) => {
        clearTimeout(timer)
        this.collectors.delete(forkId)
        reject(e instanceof Error ? e : new Error(String(e)))
      })
    })
  }

  private demuxRequest(id: number | string, method: string, params: Params): void {
    const threadId = typeof params.threadId === 'string' ? params.threadId : undefined
    const session = threadId ? this.byThread.get(threadId) : undefined
    if (session) session.handleServerRequest(id, method, params)
    else this.respondSafe(id, { decision: 'decline' }) // 无主请求拒绝掉避免悬挂
  }

  ensure(key: string, opts: CodexSpawnOpts, cb: SessionCallbacks): CodexSession {
    const existing = this.sessions.get(key)
    if (existing && !existing.exited) {
      existing.rebind(cb)
      return existing
    }
    if (existing) this.sessions.delete(key)
    const s = new CodexSession(key, opts, this, cb)
    this.sessions.set(key, s)
    return s
  }

  get(key: string): CodexSession | undefined {
    return this.sessions.get(key)
  }

  dispose(key: string): void {
    const s = this.sessions.get(key)
    if (!s) return
    this.sessions.delete(key)
    s.dispose()
  }

  /** handoff 播种线程拿到真实 threadId 后的重键：会话不换，map 键跟随 xn|→x|。
   *  不迁的话 hub 按新 key 查不到会话会再 thread/resume 一次（同线程双会话句柄）。 */
  rekey(oldKey: string, newKey: string): boolean {
    const s = this.sessions.get(oldKey)
    if (!s) return false
    this.sessions.delete(oldKey)
    s.key = newKey
    this.sessions.set(newKey, s)
    return true
  }

  disposeAll(): void {
    for (const s of [...this.sessions.values()]) s.dispose()
    this.sessions.clear()
    this.children.clear()
    this.rpc?.kill()
    this.rpc = undefined
  }

  private historyCtx() {
    return { sessions: this.sessions.values(), cache: this.threadMetaCache }
  }

  /** 分页拉取：cursor 翻页直到无 nextCursor 或达到 limitPages */
  private async paginate(method: string, baseParams: Params, limitPages = 3): Promise<Params[]> {
    const out: Params[] = []
    let cursor: string | null = null
    for (let page = 0; page < limitPages; page++) {
      const res = (await this.rpcRequest(method, { ...baseParams, cursor, limit: 100 })) as {
        data?: Params[]
        nextCursor?: string | null
      }
      out.push(...(res.data ?? []))
      cursor = res.nextCursor ?? null
      if (!cursor) break
    }
    return out
  }

  /** 模型目录：model/list 分页拉全（含每个模型支持的 effort 列表与默认 effort） */
  async listModels(): Promise<
    Array<{
      id: string
      label: string
      description: string
      efforts: Array<{ value: string; description: string }>
      defaultEffort?: string
      isDefault: boolean
    }>
  > {
    const out = await this.paginate('model/list', {})
    return out
      .filter((m) => m.hidden !== true)
      .map((m) => ({
        id: String(m.model ?? m.id ?? ''),
        label: String(m.displayName ?? m.model ?? m.id ?? ''),
        description: String(m.description ?? ''),
        efforts: (Array.isArray(m.supportedReasoningEfforts) ? m.supportedReasoningEfforts : []).map(
          (e) => ({
            value: String((e as { reasoningEffort?: unknown }).reasoningEffort ?? ''),
            description: String((e as { description?: unknown }).description ?? ''),
          }),
        ),
        defaultEffort: typeof m.defaultReasoningEffort === 'string' ? m.defaultReasoningEffort : undefined,
        isDefault: m.isDefault === true,
      }))
  }

  /** 会话发现：thread/list 分页拉全（含 cli/exec/appServer 来源） */
  async listThreads(limitPages = 3): Promise<Params[]> {
    return this.paginate(
      'thread/list',
      { sortKey: 'updated_at', sourceKinds: ['cli', 'vscode', 'exec', 'appServer'] },
      limitPages,
    )
  }

  async readHistory(threadId: string): Promise<HistoryMessage[]> {
    return readHistoryForThread(this.rpcRequest.bind(this), threadId, this.historyCtx())
  }

  async revertAt(threadId: string, beforeTurnId: string): Promise<void> {
    return revertAtThread(this.rpcRequest.bind(this), threadId, beforeTurnId)
  }

  async historyModeOf(threadId: string): Promise<string | undefined> {
    return historyModeOfThread(this.rpcRequest.bind(this), threadId, this.historyCtx())
  }

  async forkAt(threadId: string, beforeTurnId: string): Promise<string> {
    return forkAtThread(this.rpcRequest.bind(this), threadId, beforeTurnId)
  }

  async threadCwd(threadId: string): Promise<string | undefined> {
    return threadCwdForThread(this.rpcRequest.bind(this), threadId, this.historyCtx())
  }
}

export const codexRuntime = new CodexRuntime()
