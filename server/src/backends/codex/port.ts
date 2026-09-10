// codex 后端适配器：把 codexRuntime 的能力包装成 BackendPort。
// 方法体多为 index.ts 原 codex 分支的逐字搬迁——重构红线是零行为改动。

import { defaultPermissionMode } from '../../config'
import { generateCodexBrief, type HandoffDetail } from '../../handoff'
import { log } from '../../log'
import { errorMessage } from '../../util'
import type { Hub } from '../../hub/types'
import {
  baseStatusOf,
  btwDeliver,
  btwRejectNoSession,
  hubServices,
  type ArchivedEntry,
  type BackendPort,
  type RouteResult,
  type SessionHandle,
  type StatusContext,
} from '../port'
import type { SpawnOptions } from '../types'
import { listArchivedSessions, parseKey as codexParseKey, splitThreadId } from './backend'
import { codexRuntime, type CodexSession } from './runtime'

class CodexPort implements BackendPort {
  readonly name = 'codex' as const

  sessionOf(key: string): SessionHandle | undefined {
    return codexRuntime.get(key)
  }

  hasLiveSession(key: string): boolean {
    const s = codexRuntime.get(key)
    return !!s && !s.exited
  }

  // 外部门禁（control.sock 生态）是 claude-only 概念；codex 无对应物
  notifyExternalGate(_key: string): void {}

  /** 与 claude 适配器的 statusOf 同形，供列表 managed 字段与 WS status 复用 */
  statusOf(key: string, cx: StatusContext): Record<string, unknown> {
    const s = codexRuntime.get(key)
    const hub = cx.hub
    const waiting = (s?.waiting ?? false) || (hub?.pendingApprovals.size ?? 0) > 0
    return {
      ...baseStatusOf(s, hub, waiting),
      // 不下发 activeTasks/activeTaskCount：codex 服务端不维护任务表，恒空数组会被
      // hydrateTasks 误读为"权威空"而在空闲时判死 live 桶；字段缺席则前端跳过水合
      model: hub?.spawnOpts?.model,
      tailing: false,
      goal: s?.goal ?? null,
      // 回滚面板的分叉/原地回滚文案依据（legacy→thread/fork，paginated→thread/revert）
      historyMode: s?.historyMode,
    }
  }

  // ---------- 生命周期 ----------

  onAttach(hub: Hub, msg: Record<string, unknown>): void {
    // x| 会话 attach 即 resume（订阅实时事件）；xn| 新会话保持懒启动
    if (msg.warm === true || msg.opts || hub.key.startsWith('x|')) {
      void this.ensure(hub, msg.opts as Partial<SpawnOptions> | undefined)
    } else {
      hubServices().pushStatus(hub)
    }
  }

  /** 原 index.ts ensureCodexSession：attach(x|) 或首条 user 消息时 resume/start 线程 */
  async ensure(hub: Hub, opts?: Partial<SpawnOptions>): Promise<CodexSession | undefined> {
    const parsed = codexParseKey(hub.key)
    if (!parsed) {
      hubServices().broadcastError(hub, '无法解析 codex 会话 key')
      return undefined
    }
    const spawnOpts = {
      cwd: parsed.cwd,
      resumeThreadId: parsed.resumeThreadId,
      permissionMode: defaultPermissionMode(),
      ...hub.spawnOpts,
      ...opts,
    }
    hub.spawnOpts = spawnOpts
    const s = codexRuntime.ensure(hub.key, spawnOpts, hubServices().sessionCallbacks(hub))
    s.syncClients(hub.clients.size)
    try {
      await s.start()
    } catch (e) {
      // start 失败（如 -32600 线程被占用）必须摘掉句柄：否则 exited=false 的僵尸会话让
      // hasLiveSession 恒真——Hub 永不回收，且下次 ensure 复用同一坏对象永远不自愈。
      s.dispose()
      hubServices().broadcastError(hub, errorMessage(e))
      hubServices().pushStatus(hub)
      return undefined
    }
    hubServices().pushStatus(hub)
    return s
  }

  async ensureForSend(hub: Hub): Promise<SessionHandle | undefined> {
    let s = codexRuntime.get(hub.key)
    if (!s || s.exited || !s.sessionId) {
      s = (await this.ensure(hub)) as CodexSession | undefined
    }
    if (!s || s.exited) return undefined // ensure 已广播具体错误
    return s
  }

  // 无出站 /goal 跟踪与 AI 标题通道（codex 的 goal 由 thread/goal/* 通知驱动）
  maybeGenerateTitle(_hub: Hub): void {}

  // codex 的实时流走 app-server 订阅，无 tailer 概念
  startTailer(_hub: Hub, _from?: number): void {}
  stopTailer(_hub: Hub): void {}

  /** codex 回滚双轨（0.153.4 实测分流）：
   *  - paginated 线程（0.153 起新线程默认）：thread/revert 原地截断持久历史，thread id /
   *    订阅 / 会话 key 全不变，广播 reverted 让前端就地截断视图（不再产生孤立 fork 线程）。
   *  - legacy 线程：降级 thread/fork(beforeTurnId) 复制该轮之前的历史为新线程，原线程不动。
   *  userMessageId 即历史的轮首 userMessage 的 turnId。 */
  rewindConversation(hub: Hub, at: string): void {
    if (hubServices().rewindBusy(hub)) return
    const tid = codexRuntime.get(hub.key)?.sessionId ?? codexParseKey(hub.key)?.resumeThreadId
    if (!tid) {
      hubServices().broadcastError(hub, 'codex 会话未就绪，无法回滚')
      return
    }
    // revert/fork 是异步 RPC（最长 60s）窗口：置 rewindPending 门控用户消息
    //（hub/messages.ts user 分支），否则新 turn 与 thread/revert 并发会截掉刚开始的对话
    hub.rewindPending = true
    hubServices().pushStatus(hub, { rewindPending: true })
    void codexRuntime
      .historyModeOf(tid)
      .then(async (mode) => {
        if (mode === 'paginated') {
          // 清环必须在 revertAt 之前：环里躺着"被回滚的未来"，重连补放会复活它们。
          // 提前清可根除对上游"RPC 应答先于 thread/reverted 通知"的顺序依赖——通知无论何时
          // 到达都会落进新环（cliSeq 不动保持单调），重放即触发前端权威重载。
          // 代价：revert 失败也清了环（罕见），损失的只是补放缓冲，新 attach 仍读权威历史。
          hub.cliRing = []
          await codexRuntime.revertAt(tid, at)
          hubServices().broadcast(hub, { kind: 'reverted', userMessageId: at })
          hubServices().pushStatus(hub)
          return
        }
        const newId = await codexRuntime.forkAt(tid, at)
        hubServices().broadcast(hub, {
          kind: 'forked',
          targetKey: `x|${newId}`,
          targetSessionId: newId,
          fromTurnId: at,
        })
      })
      .catch((e) => hubServices().broadcastError(hub, `回滚失败: ${errorMessage(e)}`))
      .finally(() => {
        hub.rewindPending = false
        hubServices().pushStatus(hub, { rewindPending: false })
      })
  }

  rewindBoth(hub: Hub, _at: string): void {
    hubServices().broadcastError(hub, 'Codex 没有文件检查点，不支持文件回滚（可用 git 管理代码历史）')
  }

  // ---------- 消息域 ----------

  /** interrupt/set_model/set_permission_mode/compact 直接翻译；其余控制请求暂无对应物 */
  deliverControl(hub: Hub, subtype: string, extra: Record<string, unknown>): void {
    const s = codexRuntime.get(hub.key)
    if (s && !s.exited) {
      s.sendControl(subtype, extra)
    }
    hubServices().pushStatus(hub)
  }

  /** 映射为 reasoning effort（CodexSession.write 内部翻译） */
  updateEnv(hub: Hub, variables: Record<string, string>): void {
    const s = codexRuntime.get(hub.key)
    if (s && !s.exited) {
      s.write({ type: 'update_environment_variables', variables })
    }
    hubServices().pushStatus(hub)
  }

  branch(hub: Hub, _name: string): void {
    // codex 走既有 thread/fork（RewindPicker 的"从此处分叉"）
    hubServices().broadcastError(hub, 'Codex 请用回滚面板的「从此处分叉」')
  }

  btw(hub: Hub, question: string): void {
    const parsed = codexParseKey(hub.key)
    const tid = codexRuntime.get(hub.key)?.sessionId ?? parsed?.resumeThreadId
    if (!question || !tid) {
      btwRejectNoSession(hub, question)
      return
    }
    btwDeliver(hub, question, async () => {
      const r = await codexRuntime.runEphemeralQuestion(tid, question, 180_000, (delta, thinking) => {
        hubServices().broadcast(hub, { kind: 'btw_delta', question, delta, thinking: thinking || undefined })
      })
      return r.text
    })
  }

  query(
    hub: Hub,
    query: string,
    _extra: Record<string, unknown>,
    reply: (payload: Record<string, unknown>) => void,
  ): void {
    // codex 仅 mcp_status 有对应物 mcpServerStatus/list（动作类一律拒绝）
    if (query !== 'mcp_status') {
      reply({ ok: false, error: `codex 后端暂不支持 ${query}` })
      return
    }
    void codexRuntime
      .rpcRequest('mcpServerStatus/list', {})
      .then((d) => reply({ ok: true, data: d }))
      .catch((e) => reply({ ok: false, error: errorMessage(e) }))
  }

  // ---------- handoff（接力） ----------

  handoffSource(key: string): { cwd?: string; sourceId?: string } {
    const parsed = codexParseKey(key)
    return { cwd: parsed?.cwd, sourceId: parsed?.resumeThreadId }
  }

  async handoffCwdOf(_key: string, sourceId: string): Promise<string | undefined> {
    return codexRuntime.threadCwd(sourceId)
  }

  async forkBriefForHandoff(
    _fromKey: string,
    _cwd: string,
    sourceId: string,
    detail: HandoffDetail,
  ): Promise<{ text: string; usage?: Record<string, number> }> {
    return generateCodexBrief(sourceId, detail)
  }

  async seedHandoffTarget(hub: Hub, seed: string): Promise<string | undefined> {
    const s = await this.ensure(hub)
    if (!s || s.exited) throw new Error('目标 codex 会话启动失败')
    s.sendUserText(seed)
    return s.sessionId
  }

  /** handoff 播种线程的重键（xn|→x|）：线程句柄不换，map 键跟随真实 threadId。
   *  xn| 时代的 spawnOpts.resumeThreadId 是显式 undefined，回收重生时会经扩散合并盖掉
   *  parseKey(x|) 的 resumeThreadId 而 thread/start 出全新线程——重键时对齐当前线程身份。 */
  rekeySession(hub: Hub, oldKey: string, newKey: string, newSessionId: string): void {
    codexRuntime.rekey(oldKey, newKey)
    if (hub.spawnOpts) (hub.spawnOpts as { resumeThreadId?: string }).resumeThreadId = newSessionId
  }

  // ---------- REST 管理面（官方 RPC：loaded/stored thread 均可） ----------

  /** thread 管理 RPC 共享核：splitThreadId 守卫 + rpcRequest + RouteResult 信封只有一份，
   *  守卫措辞或错误映射（如 -32600 线程被占用）修订时三处管理端点不会分叉 */
  private async threadRpc(key: string, method: string, params: Record<string, unknown>): Promise<RouteResult> {
    const threadId = splitThreadId(key)
    if (!threadId) return { ok: false, error: '无法解析 threadId', status: 400 }
    try {
      await codexRuntime.rpcRequest(method, { threadId, ...params })
      return { ok: true }
    } catch (e) {
      return { ok: false, error: errorMessage(e), status: 500 }
    }
  }

  archive(key: string): Promise<RouteResult> {
    return this.threadRpc(key, 'thread/archive', {})
  }

  restore(key: string): Promise<RouteResult> {
    return this.threadRpc(key, 'thread/unarchive', {})
  }

  rename(key: string, title: string): Promise<RouteResult> {
    return this.threadRpc(key, 'thread/name/set', { name: title })
  }

  /** codex 归档列表：复用 backend 的 toSummary 唯一映射；RPC 失败降级空数组不拖垮 claude trash */
  async listArchived(): Promise<ArchivedEntry[]> {
    try {
      const rows = await listArchivedSessions()
      return rows.map((s) => ({
        key: s.key,
        sessionId: s.id,
        slug: 'codex',
        backend: 'codex' as const,
        title: s.title,
        lastPrompt: s.lastPrompt,
        cwd: s.cwd,
        mtime: s.mtime,
      }))
    } catch (e) {
      log.warn('[api] codex archived 列表失败:', e instanceof Error ? e.message : e)
      return []
    }
  }
}

export const codexPort = new CodexPort()
