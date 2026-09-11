// claude 后端适配器：把 processManager/discovery 的能力包装成 BackendPort。
// 方法体多为 index.ts 原 claude 分支的逐字搬迁——重构红线是零行为改动。

import { appendFileSync, existsSync } from 'node:fs'
import { archiveClaudeSession, listTrash, restoreClaudeSession } from '../../archive'
import { defaultPermissionMode } from '../../config'
import { briefPrompt, generateClaudeBrief, type HandoffDetail } from '../../handoff'
import { log } from '../../log'
import { errorMessage, transcriptPathOf } from '../../util'
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
import { hydratedContextOf, keyForBranch, parseKey, splitExistingKey, type ParsedKey } from './backend'
import { liveSessionInfo } from './discovery'
import { processManager, type ClaudeSession } from './processManager'
import { sessionModelOf } from './sessionModels'
import { TranscriptTailer } from './tailer'

/** 离线/tail 会话的模型回填：s| key 的 sessionId → init 持久化表；其余 key 形状（n|/b|）无表可查 */
function offlineModelOf(key: string): string | undefined {
  const ek = splitExistingKey(key)
  return ek ? sessionModelOf(ek.sessionId) : undefined
}

class ClaudePort implements BackendPort {
  readonly name = 'claude' as const

  sessionOf(key: string): SessionHandle | undefined {
    return processManager.get(key)
  }

  hasLiveSession(key: string): boolean {
    return !!processManager.get(key)
  }

  notifyExternalGate(key: string): void {
    processManager.get(key)?.notifyExternalGate()
  }

  statusOf(key: string, cx: StatusContext): Record<string, unknown> {
    const s = processManager.get(key)
    const hub = cx.hub
    const pending = hub?.pendingApprovals.size ?? 0
    // 未被本服务 spawn 的会话：读 pid 文件，把外部 CLI 的实时状态反映到 busy/waiting
    let live: { status: string; pid: number } | undefined
    if (!s || s.exited) {
      const ek = splitExistingKey(key)
      if (ek) live = cx.liveHint === undefined ? liveSessionInfo(ek.sessionId) : (cx.liveHint ?? undefined)
    }
    const waiting = (s?.waiting ?? false) || pending > 0 || live?.status === 'waiting'
    const st = baseStatusOf(s, hub, waiting)
    if (live?.status === 'busy') st.busy = true // 审批等待与外部进程 busy 都算 busy，防止误回收
    // 离线/未 spawn 水合：直读 transcript 尾部，点开会话即有上下文环形（无需先发消息）；
    // live 值存在时恒优先（spawn 内水合与实时跟踪是同源数据的更新版）
    if (cx.hydrateContext && st.context == null) st.context = hydratedContextOf(key)
    return {
      ...st,
      activeTaskCount: s?.activeTaskCount ?? 0,
      activeTasks: s?.backgroundTasks ?? [],
      slashCommands: s?.slashCommands,
      // spawnOpts.model 是用户显式选择（未 spawn 时的待应用值）；initModel 是进程 init 报告的解析后 ID。
      // 后者让重连 attach 的页面不必等下一轮就能显示模型（StatusPill 再经 modelNames 映射成配置名）。
      // 都缺席（离线/tail 外部会话）时回退 init 持久化的 sessionId→model 表——与 hydratedContextOf
      // 的窗口推断同源，避免 StatusPill 退化成 "…" 占位
      model: hub?.spawnOpts?.model ?? s?.initModel ?? offlineModelOf(key),
      tailing: !!hub?.tailer,
      liveStatus: live?.status,
      goal: hub?.goal ?? null,
    }
  }

  // ---------- 生命周期（原 index.ts ensureSpawned/ensureClaudeSession/tailer 三件套） ----------

  onAttach(hub: Hub, msg: Record<string, unknown>): void {
    // 浏览历史只握手，不 spawn。发消息 / 切 model·mode·effort / rewind / btw 时再启动 CLI。
    // 若客户端显式传 warm:true，则预热 resume（用于主动续聊）。
    if (msg.warm === true || msg.opts) {
      this.ensureSpawned(hub, msg.opts as Partial<SpawnOptions> | undefined)
    } else {
      hubServices().pushStatus(hub)
    }
  }

  async ensure(hub: Hub, opts?: Partial<SpawnOptions>): Promise<SessionHandle | undefined> {
    // 零 await 红线：本函数体到 return 前不得出现 await——spawn/stopTailer/syncClients/
    // pendingEnv 写入必须与调用同拍完成（调用方 await 只推迟其后续代码一个微任务）
    this.ensureSpawned(hub, opts)
    const s = processManager.get(hub.key)
    return s && !s.exited ? s : undefined
  }

  async ensureForSend(hub: Hub): Promise<SessionHandle | undefined> {
    // 零 await 红线同 ensure
    return this.sessionForSend(hub)
  }

  /** 原 ensureClaudeSession：未运行则触发懒 spawn；仍未就绪返回 undefined
   * （ensureSpawned 已广播具体错误）。同步路径（rewindBoth）也用它。 */
  private sessionForSend(hub: Hub): ClaudeSession | undefined {
    let s = processManager.get(hub.key)
    if (!s || s.exited) {
      this.ensureSpawned(hub)
      s = processManager.get(hub.key)
    }
    return s && !s.exited ? s : undefined
  }

  private ensureSpawned(hub: Hub, opts?: Partial<SpawnOptions>, parsedHint?: ParsedKey): void {
    // parseKey 会反查 listSessions()（一次文件系统扫描）；调用方已解析过时直接复用
    const parsed = parsedHint ?? parseKey(hub.key)
    if (!parsed) {
      hubServices().broadcastError(hub, '无法解析会话（项目目录不存在？）')
      return
    }
    const spawnOpts: SpawnOptions = {
      cwd: parsed.cwd,
      resumeSessionId: parsed.resumeSessionId,
      forkFromSessionId: parsed.forkFromSessionId,
      permissionMode: defaultPermissionMode(),
      ...hub.spawnOpts,
      ...opts,
    }
    // b| 懒分叉的一次性语义：首个 init 已把分叉产出的新 sessionId 记入 hub.sessionId，
    // 此后 respawn/rewind 必须 resume 分叉自身。否则 spawn() 里 fork 分支优先于 resume，
    // 会从源会话重新 fork 出全新 sessionId，静默丢弃分叉后的全部对话；rewind 路径更致命——
    // --resume-session-at 带的 messageId 在源 transcript 里根本不存在。
    if (spawnOpts.forkFromSessionId && hub.sessionId) {
      delete spawnOpts.forkFromSessionId
      spawnOpts.resumeSessionId = hub.sessionId
    }
    // 会话身份以最新 init 记下的 hub.sessionId 为权威：/clear 重键、handoff 重键、n| 首 turn 之后，
    // spawnOpts 里的 resumeSessionId 都是陈旧值（或是显式 undefined——扩散合并会盖掉 parsed 的
    // resumeSessionId）。进程空闲回收后重生必须续跑当前会话，否则 /clear 后回到旧 transcript、
    // n| 会话静默开空白新会话。
    if (hub.sessionId) spawnOpts.resumeSessionId = hub.sessionId
    hub.spawnOpts = spawnOpts
    try {
      const s = processManager.ensure(hub.key, spawnOpts, hubServices().sessionCallbacks(hub))
      // spawn 成功（或已有存活进程）：live 流接管，停掉 transcript tailer 避免重复推送
      this.stopTailer(hub)
      // 懒 spawn：WS 可能在进程创建前已 open，对齐客户端引用计数
      s.syncClients(hub.clients.size)
      // 自定义 env 必须排在首条 user 消息之前写入；stdin 保证顺序。
      if (hub.pendingEnv && Object.keys(hub.pendingEnv).length > 0) {
        s.write({ type: 'update_environment_variables', variables: hub.pendingEnv })
        hub.pendingEnv = undefined
      }
    } catch (e) {
      log.error(`[session ${hub.key}] spawn 失败:`, e) // 原对象打日志保留堆栈
      hubServices().broadcastError(hub, errorMessage(e))
    }
    // resumeSessionAt 是一次性 spawn 参数（命令行 args 已在 spawn() 内同步生成）。
    // 无论本次成败都不能留在 hub.spawnOpts 里，否则之后空闲回收后的普通 respawn
    // 会带着它再次截断同一条消息，静默丢弃回滚之后的新对话。
    delete hub.spawnOpts.resumeSessionAt
    hubServices().pushStatus(hub)
  }

  afterUserSent(hub: Hub, text: string): void {
    // /goal 是 claude 的本地斜杠命令（2.1.139+）：goal 状态不进 stream-json，
    // 这里从出站文本跟踪 chip 状态；result 到达时清除（见 onMessage）
    const goalMatch = text.match(/^\/goal\s*(.*)$/i)
    if (goalMatch) {
      const arg = goalMatch[1].trim()
      if (!arg) {
        // /goal 无参 = 查询状态，本地输出，不改变跟踪
      } else if (/^(clear|stop|off|reset|none|cancel)$/i.test(arg)) {
        hub.goal = undefined
      } else {
        hub.goal = { condition: arg, since: Date.now() }
      }
      hubServices().pushStatus(hub)
    }
    // 记录首条真实 user 消息作为标题素材（斜杠首消息不算会话主题，跳过）；
    // 实际触发在 maybeGenerateTitle——需要 sessionId（init 可能尚未到达）。
    // 条件显式写：titleGeneratedFor 与 sessionId 同 undefined 时也必须放行（全新 Hub）
    if (text.trim() && !text.startsWith('/') && !(hub.titleGeneratedFor && hub.titleGeneratedFor === hub.sessionId)) {
      hub.pendingTitleText ??= text
      this.maybeGenerateTitle(hub)
    }
  }

  /**
   * 官方 AI 标题（generate_session_title）：首条真实 user 消息 × 首个 init 双条件齐备即触发。
   * 两路调用——user 消息时（sessionId 已知）与 init 到达时（消息已记账）；按 sessionId 去重，
   * /clear 重键后的新会话自然再生成一次。CLI persist 把 ai-title 写进 transcript，
   * discovery 标题链（custom-title > ai-title > summary > 首条消息）自动接住，列表轮询内出现。
   */
  maybeGenerateTitle(hub: Hub): void {
    const sid = hub.sessionId
    const text = hub.pendingTitleText
    if (!sid || !text || hub.titleGeneratedFor === sid) return
    const s = processManager.get(hub.key)
    if (!s) return
    hub.titleGeneratedFor = sid
    hub.pendingTitleText = undefined
    void s
      .generateSessionTitle(text)
      .then((title) => {
        if (title) log.info(`[title] ${hubServices().sessionNameOf(hub.key)} → ${title}`)
      })
      .catch(() => {}) // 标题失败无害：列表回退首条消息摘要
  }

  // ---------- transcript tailer（外部会话实时跟踪） ----------

  stopTailer(hub: Hub): void {
    hub.tailer?.stop()
    hub.tailer = undefined
  }

  private throttledTailStatus(hub: Hub): void {
    const now = Date.now()
    if (now - (hub.tailStatusAt ?? 0) < 2000) return
    hub.tailStatusAt = now
    hubServices().pushStatus(hub)
  }

  startTailer(hub: Hub, from?: number): void {
    if (hub.tailer) return
    const ek = splitExistingKey(hub.key)
    if (!ek) return // 新会话还没有 transcript
    if (processManager.get(hub.key)) return // 已 spawn：live 流覆盖，无需 tail
    const path = transcriptPathOf(ek.slug, ek.sessionId)
    hub.tailer = new TranscriptTailer(path, from, {
      onMessage: (msg) => {
        hubServices().broadcast(hub, { kind: 'tail', msg })
        this.throttledTailStatus(hub)
      },
      onReset: () => {
        this.stopTailer(hub)
        hubServices().broadcast(hub, { kind: 'tail_reset' })
        hubServices().pushStatus(hub)
      },
      onTick: () => this.throttledTailStatus(hub),
    })
    hub.tailer.start()
    hubServices().pushStatus(hub)
  }

  // ---------- 回滚 ----------

  rewindConversation(hub: Hub, userMessageId: string): void {
    if (hubServices().rewindBusy(hub)) return
    this.rewindConversationAt(hub, userMessageId, 'conversation')
  }

  rewindBoth(hub: Hub, at: string): void {
    if (hubServices().rewindBusy(hub)) return
    const s = this.sessionForSend(hub)
    if (!s) return

    // 官方 TUI 的“恢复代码和对话”也是两个动作。这里必须先收到文件
    // checkpoint 成功响应，才允许销毁旧进程并以 resume-session-at 截断对话。
    // rewind_files 没有 CLI 侧超时，大项目恢复可达分钟级，给足 120s。
    hub.rewindPending = true
    hubServices().pushStatus(hub, { rewindPending: true })
    void s.sendControlAndWait('rewind_files', { user_message_id: at }, 120_000)
      .then(() => {
        if (processManager.get(hub.key) !== s || s.exited) {
          hubServices().broadcastError(hub, '恢复文件后会话已变化，未回滚对话')
          return
        }
        this.rewindConversationAt(hub, at, 'both')
      })
      .catch((error) => {
        // 超时 ≠ 失败：rewind_files 没有 CLI 侧超时，大项目恢复可能在我们 120s 断点后
        // 仍静默完成——此时文件已回滚而对话未截断（半回滚）。文案必须如实区分，
        // 不能让用户误以为"什么都没发生"而继续在新状态上工作。
        const timedOut = errorMessage(error).includes('超时')
        hubServices().broadcastError(
          hub,
          timedOut
            ? '回滚文件响应超时：文件恢复可能仍在后台进行，未回滚对话。请确认工作区状态后再决定是否重试'
            : `回滚文件失败，未回滚对话：${errorMessage(error)}`,
        )
      })
      .finally(() => {
        hub.rewindPending = false
        hubServices().pushStatus(hub, { rewindPending: false })
      })
  }

  private rewindConversationAt(hub: Hub, userMessageId: string, scope: 'conversation' | 'both'): void {
    const current = processManager.get(hub.key)
    const parsed = parseKey(hub.key)
    const sid = current?.sessionId ?? parsed?.resumeSessionId
    if (!parsed || !sid) {
      hubServices().broadcastError(hub, '无法回滚：未知会话 ID')
      return
    }
    // 与 archive/rename 同款守卫：会话正被外部 CLI（终端 TUI）持有时拒绝——
    // 否则 --resume-session-at 会与活进程双写同一 transcript，截断点之后交错损坏。
    // 外部会话的截断由 tail_reset 路径承接（tailer 发现文件缩小即通知前端重载）。
    if (!current && liveSessionInfo(sid)) {
      hubServices().broadcastError(hub, '会话正在官方 CLI 中运行，请先在该 CLI 内回滚')
      return
    }
    // 先从 map 摘掉再 kill，避免旧 onExit 污染新会话。
    processManager.dispose(hub.key)
    hub.spawnOpts = { ...hub.spawnOpts, cwd: parsed.cwd, resumeSessionId: sid, resumeSessionAt: userMessageId }
    this.ensureSpawned(hub, undefined, parsed)
    const respawned = processManager.get(hub.key)
    if (!respawned || respawned.exited) {
      // ensureSpawned 已广播具体的 spawn 错误；不能向客户端虚报回滚成功。
      return
    }
    hubServices().broadcast(hub, { kind: 'rewound', userMessageId, scope })
  }

  // ---------- 消息域 ----------

  deliverControl(hub: Hub, subtype: string, extra: Record<string, unknown>): void {
    const { broadcastError, pushStatus } = hubServices()
    // 中断：未启动则无需操作
    if (subtype === 'interrupt') {
      const s = processManager.get(hub.key)
      if (s && !s.exited) {
        try {
          s.sendControl(subtype, extra)
        } catch (e) {
          broadcastError(hub, `中断失败: ${errorMessage(e)}`)
        }
        pushStatus(hub)
      }
      return
    }
    let s = processManager.get(hub.key)
    if (!s || s.exited) {
      if (subtype === 'set_model' || subtype === 'set_permission_mode') {
        pushStatus(hub)
        return
      }
      // 其他控制可能没有 CLI 参数等价物，仍需进程承接。
      this.ensureSpawned(hub)
      s = processManager.get(hub.key)
    }
    if (!s || s.exited) return
    try {
      s.sendControl(subtype, extra)
      pushStatus(hub)
    } catch (e) {
      broadcastError(hub, `控制请求失败: ${errorMessage(e)}`)
      pushStatus(hub)
    }
  }

  updateEnv(hub: Hub, variables: Record<string, string>): void {
    const { broadcastError, pushStatus } = hubServices()
    const otherVariables = Object.fromEntries(
      Object.entries(variables).filter(([key]) => key !== 'CLAUDE_CODE_EFFORT_LEVEL'),
    )
    const s = processManager.get(hub.key)
    if (!s || s.exited) {
      if (Object.keys(otherVariables).length > 0) {
        hub.pendingEnv = { ...hub.pendingEnv, ...otherVariables }
      }
      pushStatus(hub)
      return
    }
    try {
      s.write({ type: 'update_environment_variables', variables })
      pushStatus(hub)
    } catch (e) {
      broadcastError(hub, `更新环境变量失败: ${errorMessage(e)}`)
      pushStatus(hub)
    }
  }

  /** 分叉当前会话：懒分叉（b| key，首条消息才 --fork-session） */
  branch(hub: Hub, name: string): void {
    const { broadcast, broadcastError, getHub } = hubServices()
    const parsed = parseKey(hub.key)
    const srcSid =
      processManager.get(hub.key)?.sessionId ?? parsed?.resumeSessionId ?? parsed?.forkFromSessionId
    if (!parsed || !srcSid) {
      broadcastError(hub, '分叉需要已有会话（先发过至少一条消息）')
      return
    }
    const branchKey = keyForBranch(parsed.cwd, srcSid)
    // 预建 Hub 并缓存分叉源：首条 user 消息 ensureSpawned 时经 parseKey 拿到 forkFromSessionId
    const branchHub = getHub(branchKey)
    // /branch <名字>：透传给分叉 spawn 的 -n（列表页可区分分支用途）
    const branchName = name.trim()
    if (branchName) branchHub.spawnOpts = { ...branchHub.spawnOpts, sessionName: branchName }
    broadcast(hub, { kind: 'forked', targetKey: branchKey, branchOf: srcSid, ...(branchName ? { name: branchName } : {}) })
  }

  /** 官方 side_question 控制通道（进程内轻量 fork，共享 prompt cache，
   *  不产生磁盘 FORK 会话）。无流式增量，应答单次返回。 */
  btw(hub: Hub, question: string): void {
    const parsed = parseKey(hub.key)
    const sid =
      processManager.get(hub.key)?.sessionId ?? parsed?.resumeSessionId ?? parsed?.forkFromSessionId
    if (!question || !parsed || !sid) {
      btwRejectNoSession(hub, question)
      return
    }
    const s = this.sessionForSend(hub)
    if (!s) return // ensureSpawned 已广播具体错误
    btwDeliver(hub, question, () => s.sideQuestion(question))
  }

  query(
    hub: Hub,
    query: string,
    extra: Record<string, unknown>,
    reply: (payload: Record<string, unknown>) => void,
  ): void {
    const s = this.sessionForSend(hub)
    if (!s) {
      reply({ ok: false, error: '进程未运行' })
      return
    }
    // 重连/启用是完整 MCP 握手，慢于普通查询，给足超时
    const timeoutMs = query === 'mcp_reconnect' || query === 'mcp_toggle' ? 30_000 : 15_000
    s.sendControlAndWait(query, extra, timeoutMs)
      .then((d) => reply({ ok: true, data: d }))
      .catch((e) => reply({ ok: false, error: errorMessage(e) }))
  }

  // ---------- handoff（接力） ----------

  handoffSource(key: string): { cwd?: string; sourceId?: string } {
    const parsed = parseKey(key)
    return { cwd: parsed?.cwd, sourceId: processManager.get(key)?.sessionId ?? parsed?.resumeSessionId }
  }

  async handoffCwdOf(key: string, _sourceId: string): Promise<string | undefined> {
    return parseKey(key)?.cwd
  }

  async forkBriefForHandoff(
    fromKey: string,
    cwd: string,
    sourceId: string,
    detail: HandoffDetail,
  ): Promise<{ text: string; usage?: Record<string, number> }> {
    // claude 源在线时走 side_question 控制通道（进程内 fork，零冷启动、不留 FORK 会话）；
    // 离线才 spawn 一次性 --fork-session --bare 进程
    const live = processManager.get(fromKey)
    if (live && !live.exited) {
      try {
        const text = await live.sideQuestion(briefPrompt(detail))
        if (text.trim()) return { text, usage: undefined }
      } catch {
        // side_question 失败回落 fork spawn（如 CLI 版本过旧无此通道）
      }
    }
    return generateClaudeBrief(cwd, sourceId, detail)
  }

  async seedHandoffTarget(hub: Hub, seed: string): Promise<string | undefined> {
    this.ensureSpawned(hub)
    const s = processManager.get(hub.key)
    if (!s || s.exited) throw new Error('目标 claude 会话启动失败')
    s.sendUserText(seed)
    // claude 的 sessionId 在 init 时才就绪：短轮询等待，随后回填真实 key（血缘导航用）
    if (!s.sessionId) {
      const deadline = Date.now() + 30_000
      // 每轮重新取句柄：等待期间旧进程可能退出并被重生，旧引用拿不到新 sessionId
      for (;;) {
        const cur = processManager.get(hub.key)
        if (!cur || cur.sessionId || cur.exited || Date.now() >= deadline) {
          return cur?.sessionId
        }
        await Bun.sleep(500)
      }
    }
    return s.sessionId
  }

  /** handoff 播种进程的重键（n|→s|）：进程不换，map 键跟随真实 sessionId。
   *  spawnOpts 的 resumeSessionId 无需在此对齐——ensureSpawned 的身份权威行会处理。 */
  rekeySession(_hub: Hub, oldKey: string, newKey: string, _newSessionId: string): void {
    processManager.rekey(oldKey, newKey)
  }

  // ---------- REST 管理面（归档/恢复/改名） ----------

  async archive(key: string): Promise<RouteResult> {
    const ek = splitExistingKey(key)
    if (!ek) return { ok: false, error: '仅支持已有会话', status: 400 }
    try {
      if (processManager.get(key) || liveSessionInfo(ek.sessionId)) {
        return { ok: false, error: '会话正在运行，无法归档', status: 409 }
      }
      archiveClaudeSession(ek.slug, ek.sessionId)
      return { ok: true }
    } catch (e) {
      return { ok: false, error: errorMessage(e), status: 500 }
    }
  }

  async restore(key: string): Promise<RouteResult> {
    const ek = splitExistingKey(key)
    if (!ek) return { ok: false, error: '仅支持 claude 会话恢复', status: 400 }
    try {
      restoreClaudeSession(ek.slug, ek.sessionId)
      return { ok: true }
    } catch (e) {
      return { ok: false, error: errorMessage(e), status: 500 }
    }
  }

  /** 仅离线会话（在线会话的 transcript 由 CLI 持有，改名走其内部路径） */
  async rename(key: string, title: string): Promise<RouteResult> {
    const ek = splitExistingKey(key)
    if (!ek) return { ok: false, error: '仅支持已有 claude 会话', status: 400 }
    const { slug, sessionId } = ek
    if (processManager.get(key) || liveSessionInfo(sessionId)) {
      return { ok: false, error: '会话正在运行，请在 CLI 退出后改名', status: 409 }
    }
    const file = transcriptPathOf(slug, sessionId)
    if (!existsSync(file)) return { ok: false, error: 'transcript 不存在', status: 404 }
    try {
      // 与官方 /rename 相同的条目形状；discovery 读取时后者优先
      appendFileSync(file, JSON.stringify({ type: 'custom-title', sessionId, customTitle: title }) + '\n')
      return { ok: true }
    } catch (e) {
      return { ok: false, error: errorMessage(e), status: 500 }
    }
  }

  /** claude 无官方归档概念：回收站即 ~/.anyplane/trash/claude/ 的 transcript 迁移记录 */
  async listArchived(): Promise<ArchivedEntry[]> {
    return listTrash().map((t) => ({
      key: t.key,
      sessionId: t.sessionId,
      slug: t.slug,
      backend: 'claude' as const,
      trashedAt: t.trashedAt,
      sizeBytes: t.sizeBytes,
    }))
  }
}

export const claudePort = new ClaudePort()
