// codex 后端适配器：把 codexRuntime 的能力包装成 BackendPort。
// 方法体多为 index.ts 原 codex 分支的逐字搬迁——重构红线是零行为改动。

import { defaultPermissionMode } from '../../config'
import { generateCodexBrief, type HandoffDetail } from '../../handoff'
import { errorMessage } from '../../util'
import type { Hub } from '../../hub/types'
import {
  baseStatusOf,
  hubServices,
  type BackendPort,
  type RouteResult,
  type SessionHandle,
  type StatusContext,
} from '../port'
import type { SpawnOptions } from '../types'
import { parseKey as codexParseKey, splitThreadId } from './backend'
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

  /** codex：分叉语义——thread/fork(beforeTurnId) 复制该轮之前的历史为新线程，
   *  原线程不动。userMessageId 即历史的轮首 userMessage 的 turnId。 */
  rewindConversation(hub: Hub, at: string): void {
    const tid = codexRuntime.get(hub.key)?.sessionId ?? codexParseKey(hub.key)?.resumeThreadId
    if (!tid) {
      hubServices().broadcastError(hub, 'codex 会话未就绪，无法分叉')
      return
    }
    void codexRuntime
      .forkAt(tid, at)
      .then((newId) => {
        hubServices().broadcast(hub, {
          kind: 'forked',
          targetKey: `x|${newId}`,
          targetSessionId: newId,
          fromTurnId: at,
        })
      })
      .catch((e) => hubServices().broadcastError(hub, `分叉失败: ${errorMessage(e)}`))
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
    const { broadcast } = hubServices()
    const parsed = codexParseKey(hub.key)
    const tid = codexRuntime.get(hub.key)?.sessionId ?? parsed?.resumeThreadId
    if (!question || !tid) {
      broadcast(hub, { kind: 'btw_result', ok: false, question, text: '侧问需要已有会话（先发过至少一条消息）' })
      return
    }
    void codexRuntime
      .runEphemeralQuestion(tid, question, 180_000, (delta, thinking) => {
        broadcast(hub, { kind: 'btw_delta', question, delta, thinking: thinking || undefined })
      })
      .then((r) => broadcast(hub, { kind: 'btw_result', ok: true, question, text: r.text }))
      .catch((e) =>
        broadcast(hub, { kind: 'btw_result', ok: false, question, text: `侧问失败: ${errorMessage(e)}` }),
      )
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

  // ---------- REST 管理面（官方 RPC：loaded/stored thread 均可） ----------

  async archive(key: string): Promise<RouteResult> {
    const threadId = splitThreadId(key)
    if (!threadId) return { ok: false, error: '无法解析 threadId', status: 400 }
    try {
      await codexRuntime.rpcRequest('thread/archive', { threadId })
      return { ok: true }
    } catch (e) {
      return { ok: false, error: errorMessage(e), status: 500 }
    }
  }

  async restore(key: string): Promise<RouteResult> {
    const threadId = splitThreadId(key)
    if (!threadId) return { ok: false, error: '无法解析 threadId', status: 400 }
    try {
      await codexRuntime.rpcRequest('thread/unarchive', { threadId })
      return { ok: true }
    } catch (e) {
      return { ok: false, error: errorMessage(e), status: 500 }
    }
  }

  async rename(key: string, title: string): Promise<RouteResult> {
    const threadId = splitThreadId(key)
    if (!threadId) return { ok: false, error: '无法解析 threadId', status: 400 }
    try {
      await codexRuntime.rpcRequest('thread/name/set', { threadId, name: title })
      return { ok: true }
    } catch (e) {
      return { ok: false, error: errorMessage(e), status: 500 }
    }
  }
}

export const codexPort = new CodexPort()
