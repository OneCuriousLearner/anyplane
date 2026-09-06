import { useEffect, useMemo, useRef, useState } from 'react'
import { createSession, fetchClaudeModelNames, fetchCodexHistory, fetchCodexModels, fetchConfig, fetchHistory, fetchLineage, makeSessionInfo, startHandoff, type CodexModelInfo, type LineageResponse, type ServerConfigInfo, type SessionInfo, type TierModelName } from '../lib/api'
import { SessionSocket, type ServerEvent, type SessionState } from '../lib/ws'
import { ApprovalCard } from '../components/ApprovalCard'
import { ChatHeader } from '../components/ChatHeader'
import { Composer, imgPreviewSrc } from '../components/Composer'
import { DetailDrawer, type ContextDataLite, type McpServerInfo, type SettingsDataLite } from '../components/DetailDrawer'
import { RewindPicker } from '../components/RewindPicker'
import { Transcript } from '../components/Transcript'
import { TasksPanel } from '../components/TasksPanel'
import { ClaudeStar } from '../components/ClaudeStar'
import { CodexMark } from '../components/CodexMark'
import { buildTranscriptRows, nextId, rewindPreview, usageSummary, type Block, type ChatMsg } from '../lib/blocks'
import { statusLineOf } from '../lib/chatText'
import { interceptSlash, type SlashAction } from '../lib/slashIntercept'
import { appendHistoryMsg, flushStrayResults, type IngestState } from '../lib/ingest'
import { isCodexKey, isExistingKey } from '../lib/key'
import { useTaskBuckets } from '../hooks/useTaskBuckets'
import { useTranscriptIngest } from '../hooks/useTranscriptIngest'

interface Approval {
  requestId: string
  toolName: string
  input: unknown
}

export function Chat(props: { session: SessionInfo; onBack: () => void; onNavigate?: (s: SessionInfo) => void }) {
  const { session } = props
  const isCodex = isCodexKey(session.key)
  const isExisting = isExistingKey(session.key)
  const [input, setInput] = useState('')
  const [state, setState] = useState<SessionState>({ spawned: false, busy: false })
  const [connected, setConnected] = useState(false)
  const [approvals, setApprovals] = useState<Approval[]>([])
  const [cfg, setCfg] = useState<ServerConfigInfo>()
  const [showRewind, setShowRewind] = useState(false)
  const [phase, setPhase] = useState<string>()
  const [initInfo, setInitInfo] = useState<{ model?: string; slashCommands?: string[] }>({})
  const [permMode, setPermMode] = useState<string>()
  const [effort, setEffort] = useState<string>()
  const [codexModels, setCodexModels] = useState<CodexModelInfo[]>()
  const [lineage, setLineage] = useState<LineageResponse>()
  const [handoffBusy, setHandoffBusy] = useState(false)
  const [sendMode, setSendMode] = useState<'steer' | 'queue'>('steer')
  /** 待发送的图片附件（预览 src 由 mediaType+dataBase64 派生，不单独存储） */
  const [pendingImages, setPendingImages] = useState<
    Array<{ name: string; mediaType: string; dataBase64: string }>
  >([])
  const [detailOpen, setDetailOpen] = useState(false)
  const [detailTitle, setDetailTitle] = useState('')
  const [detailContent, setDetailContent] = useState('加载中…')
  /** claude MCP 面板：mcp_status 的结构化结果（null = 未加载/加载失败，此时看 detailContent） */
  const [mcpServers, setMcpServers] = useState<McpServerInfo[] | null>(null)
  /** claude context 用量结构化结果（get_context_usage） */
  const [contextData, setContextData] = useState<ContextDataLite | null>(null)
  /** claude 设置结构化结果（get_settings） */
  const [settingsData, setSettingsData] = useState<SettingsDataLite | null>(null)
  /** MCP 动作进行中：`${serverName}:${action}` */
  const [mcpBusy, setMcpBusy] = useState<string | null>(null)
  /** 在途 MCP 动作的 query id（query_result 按 id 辨认动作应答与普通查询应答） */
  const pendingMcpActionRef = useRef<string | null>(null)
  const [goalOpen, setGoalOpen] = useState(false)
  const [goalDraft, setGoalDraft] = useState('')
  const [moreOpen, setMoreOpen] = useState(false)
  const querySeq = useRef(0)
  const sockRef = useRef<SessionSocket | undefined>(undefined)
  const scrollRef = useRef<HTMLDivElement>(null)
  const [atBottom, setAtBottom] = useState(true)
  const atBottomRef = useRef(true)

  // ---------- 后台任务（与主线并行的 agent/task/shell，右侧拉栏展示；task_type 全类型入桶） ----------
  // 桶状态与辅助群已下沉 hooks/useTaskBuckets.ts（F3）：api 为每渲染重建的普通对象——
  // 内部全走 ref/稳定 setState/isCodex（会话内不变），与此前过期闭包语义等价
  const { tasks, tasksOpen, setTasksOpen, api: taskApi } = useTaskBuckets({ isCodex })

  // ---------- 主抄本 ingest（消息/流式草稿/配对索引；F4 下沉 hooks/useTranscriptIngest.ts） ----------
  // api 为每渲染重建的普通对象：内部全走 ref/稳定 setState/注入的稳定 setter，过期闭包语义等价
  const { messages, draft, api: ingestApi } = useTranscriptIngest({
    isCodex,
    sockRef,
    taskApi,
    setPhase,
    setPermMode,
    setInitInfo,
  })

  const loadSessionHistory = () =>
    isCodex ? fetchCodexHistory(session.sessionId) : fetchHistory(session.slug, session.sessionId)
  /** 当前会话权威 ID：spawn 后以 status 广播为准（/clear 重键、b| 分叉首条消息后的真实 id）；
   *  未 spawn 时只有 s|/x| key 内嵌的才是本会话 id——b| 嵌的是源会话 id，不能误显示 */
  const currentSessionId =
    state.sessionId ??
    (session.key.startsWith('s|') || session.key.startsWith('x|') ? session.sessionId : undefined)

  // codex 模型目录（model/list）：模型/effort 档位/默认值
  useEffect(() => {
    if (!isCodex) return
    fetchCodexModels()
      .then((r) => setCodexModels(r.models))
      .catch(() => {})
  }, [isCodex])

  // 接力链：当前会话参与的血缘记录（仅在链上时显示导航条）
  useEffect(() => {
    setMoreOpen(false)
    setGoalOpen(false)
    setDetailOpen(false)
    setLineage(undefined)
    fetchLineage(session.key)
      // 记录按时间排序一次到位（渲染期不再重复排序）
      .then((r) =>
        setLineage(
          r.records.length > 0
            ? { ...r, records: [...r.records].sort((a, b) => a.at.localeCompare(b.at)) }
            : undefined,
        ),
      )
      .catch(() => {})
  }, [session.key])

  // ---------- 历史加载（切换会话时取消过期请求，避免「卡住不出对话」） ----------
  useEffect(() => {
    let cancelled = false
    ingestApi.reset()
    // Chat 组件在 session 切换时会复用，清掉上一会话的运行时/待启动配置。
    // 新会话的缓存选择会由随后到达的 status 恢复。
    setInitInfo({})
    setPermMode(undefined)
    setEffort(undefined)
    setApprovals([])
    setPhase(undefined)
    taskApi.clear()
    if (!isExisting) return
    loadSessionHistory()
      .then((resp) => {
        if (cancelled) return
        ingestApi.applyHistory(resp)
      })
      .catch((e) => {
        if (!cancelled) ingestApi.pushSystem(`⚠ 加载历史失败: ${e}`, 'error')
      })
    return () => {
      cancelled = true
    }
  }, [session.key])

  // ---------- WS 连接 ----------
  useEffect(() => {
    fetchConfig().then(setCfg).catch(() => {})
    const sock = new SessionSocket(
      session.key,
      (ev: ServerEvent) => {
        switch (ev.kind) {
          case 'status':
            setState(ev.state)
            if (typeof ev.state.model === 'string') {
              setInitInfo((prev) => ({ ...prev, model: ev.state.model }))
            }
            if (typeof ev.state.permissionMode === 'string') setPermMode(ev.state.permissionMode)
            if (typeof ev.state.effort === 'string') setEffort(ev.state.effort)
            // 服务端权威运行任务表水合任务桶（中途接入补建 / 断线丢通知判死）
            taskApi.hydrateTasks(ev.state)
            // 进程已退出时固化/清理未完成的流式草稿，避免半截内容悬挂
            if (ev.state.exited) {
              ingestApi.commitDraft()
              setPhase(undefined)
            } else if (ev.state.sessionState === 'idle' && !ev.state.busy && !ev.state.waiting && ingestApi.draftRef.current) {
              // 自愈：权威 idle 到达时清掉陈旧流式草稿。服务端重启/断线期间 turn 终结时
              // 客户端拿不到终结事件，"生成中"会永远挂着（实测：watch 重载后复现）。
              // 等审批（waiting/requires_action）期间草稿是合法的，不在此清理。
              ingestApi.setDraftBoth(null)
              setPhase(undefined)
              // turn 已终结：此刻仍未配对的 tool_result 不会再等到它的调用了，
              // 浮现为孤立提示而非静默丢弃（旧实现直接 clear，用户零反馈）
              ingestApi.setMsgs((prev) => {
                const st: IngestState = { msgs: prev, toolIdx: ingestApi.toolPosRef.current, pending: ingestApi.pendingResultsRef.current }
                flushStrayResults(st)
                return st.msgs
              })
            }
            break
          case 'approval_request':
            setApprovals((prev) =>
              prev.some((a) => a.requestId === ev.requestId)
                ? prev
                : [...prev, { requestId: ev.requestId, toolName: ev.toolName, input: ev.input }],
            )
            break
          case 'approval_resolved':
            setApprovals((prev) => prev.filter((a) => a.requestId !== ev.requestId))
            break
          case 'approval_auto': {
            // 规则引擎自动裁决的审计留痕：不进审批队列，只落一条系统卡。
            // 摘要字段提取与服务端 summarizeInput 同口径（command / file_path / url）。
            const inp = ev.input as Record<string, unknown> | undefined
            const detail =
              (typeof inp?.command === 'string' && inp.command) ||
              (typeof inp?.file_path === 'string' && inp.file_path) ||
              (typeof inp?.grantRoot === 'string' && inp.grantRoot) ||
              (typeof inp?.url === 'string' && inp.url) ||
              ''
            ingestApi.pushSystem(
              `规则自动${ev.action === 'allow' ? '放行' : '拒绝'}：${ev.toolName}${detail ? ` ${detail.slice(0, 120)}` : ''}（${ev.rule}）`,
            )
            break
          }
          case 'error':
            ingestApi.pushSystem(`⚠ ${ev.message}`, 'error')
            break
          case 'btw_pending':
            // 创建侧问卡片（发送方与其他客户端都以此为准）
            if (!ingestApi.messagesRef.current.some((m) => m.btw === ev.question && m.btwPending)) {
              ingestApi.pushMsg({ id: nextId(), role: 'assistant', btw: ev.question, btwPending: true, blocks: [] })
            }
            break
          case 'btw_delta': {
            const target = ingestApi.messagesRef.current.find((m) => m.btw === ev.question && m.btwPending)
            if (!target) break
            ingestApi.setMsgs((prev) =>
              prev.map((m) => {
                if (m.id !== target.id) return m
                const blocks = [...m.blocks]
                const kind = ev.thinking ? 'thinking' : 'text'
                const i = blocks.findIndex((b) => b.kind === kind)
                if (i >= 0) {
                  const b = blocks[i]
                  if (b.kind === 'text' || b.kind === 'thinking') {
                    blocks[i] = { ...b, text: b.text + ev.delta }
                  }
                } else {
                  blocks.push({ kind, text: ev.delta })
                }
                // thinking 在 text 之前
                blocks.sort((a, b) => (a.kind === 'thinking' ? -1 : 0) - (b.kind === 'thinking' ? -1 : 0))
                return { ...m, blocks }
              }),
            )
            break
          }
          case 'btw_result': {
            // 找不到 pending 卡（如校验失败路径或漏收 btw_pending）时自行建卡落地结果——
            // 配对不变量由数据保证，不依赖服务端的消息时序
            if (!ingestApi.messagesRef.current.some((m) => m.btw === ev.question && m.btwPending)) {
              const blocks: Block[] = ev.ok
                ? ev.text.trim()
                  ? [{ kind: 'text', text: ev.text }]
                  : []
                : [{ kind: 'text', text: `⚠ ${ev.text}` }]
              ingestApi.pushMsg({ id: nextId(), role: 'assistant', btw: ev.question, btwPending: false, blocks })
              break
            }
            ingestApi.setMsgs((prev) =>
              prev.map((m) => {
                if (m.btw !== ev.question || !m.btwPending) return m
                if (ev.ok) {
                  // 用完整结果替换正文（增量可能因快照归并而不全）
                  const thinking = m.blocks.find((b) => b.kind === 'thinking')
                  const blocks: Block[] = []
                  if (thinking) blocks.push(thinking)
                  if (ev.text.trim()) blocks.push({ kind: 'text', text: ev.text })
                  return { ...m, blocks, btwPending: false }
                }
                return { ...m, blocks: [...m.blocks, { kind: 'text', text: `⚠ ${ev.text}` }], btwPending: false }
              }),
            )
            break
          }
          case 'forked': {
            if (ev.branchOf) {
              // claude 懒分叉：b| key 导航，首条消息才真正 --fork-session；
              // 历史视图直接读源会话 transcript（分支将原样继承它）
              ingestApi.pushSystem(
                `⎇ 已创建分支${ev.name ? `「${ev.name}」` : ''}：新会话携带当前全部历史，原会话保持不动`,
              )
              props.onNavigate?.(
                makeSessionInfo({
                  key: ev.targetKey,
                  slug: session.slug,
                  sessionId: ev.branchOf,
                  cwd: session.cwd,
                  backend: 'claude',
                }),
              )
              break
            }
            // codex 分叉回滚完成：原线程不动，跳到携带截断历史的新线程
            ingestApi.pushSystem('⎇ 已分叉：新会话携带所选消息之前的历史，原会话保持不动')
            setShowRewind(false)
            props.onNavigate?.(
              makeSessionInfo({
                key: ev.targetKey,
                slug: 'codex',
                // codex 分叉路径服务端始终携带 targetSessionId（branchOf 不存在时）
                sessionId: ev.targetSessionId ?? '',
                cwd: session.cwd,
                backend: 'codex',
                managed: { spawned: true, busy: false, clients: 0 },
              }),
            )
            break
          }
          case 'handoff_pending':
            ingestApi.pushSystem(`⇄ 源会话正在生成交接简报（→ ${ev.toBackend === 'codex' ? 'Codex' : 'Claude'}）…`)
            break
          case 'handoff_brief':
            break // 简报在 handoff_done 时一并展示
          case 'handoff_done': {
            ingestApi.pushMsg({
              id: nextId(),
              role: 'system',
              systemKind: 'info',
              blocks: [{ kind: 'text', text: `⇄ 接力简报（已播种给 ${ev.toBackend === 'codex' ? 'Codex' : 'Claude'} 新会话）：\n\n${ev.brief}` }],
            })
            props.onNavigate?.(
              makeSessionInfo({
                key: ev.targetKey,
                slug: ev.toBackend === 'codex' ? 'codex' : session.slug,
                // 目标已 spawn 时 targetKey 是 resolved key（s|/x|）：必须带真实 id，
                // 否则 codex 侧 fetchCodexHistory('new') 必失败、历史视图永远空白
                sessionId: ev.targetSessionId ?? 'new',
                cwd: session.cwd,
                backend: ev.toBackend,
                status: 'busy',
                managed: { spawned: true, busy: true, clients: 0 },
              }),
            )
            break
          }
          case 'handoff_error':
            ingestApi.pushSystem(`⚠ 接力失败: ${ev.message}`, 'error')
            break
          case 'query_result': {
            // MCP 管理动作应答（按 query id 辨认）：清忙态、给反馈、成功后刷新清单
            if (pendingMcpActionRef.current && ev.id === pendingMcpActionRef.current) {
              pendingMcpActionRef.current = null
              setMcpBusy(null)
              if (ev.ok) {
                ingestApi.pushSystem('✓ MCP 操作完成')
                runQuery('mcp_status', 'MCP 状态')
              } else {
                ingestApi.pushSystem(`⚠ MCP 操作失败: ${ev.error ?? '未知错误'}`, 'error')
              }
              break
            }
            // 始终保留原始 JSON（非结构化 tab 的主视图 + 设置面板的折叠原件）
            const raw = ev.ok
              ? JSON.stringify(ev.data, null, 2).slice(0, 8000)
              : `⚠ ${ev.error ?? '查询失败'}`
            setDetailContent(raw)
            // 按应答形状分发到结构化面板（claude 专属；codex 一律 JSON 直出）。
            // 形状不匹配的 tab 清空对应结构化态，渲染链自然落回 <pre>
            const d = ev.ok && !isCodex ? (ev.data as Record<string, unknown>) : undefined
            setMcpServers(Array.isArray(d?.mcpServers) ? (d.mcpServers as McpServerInfo[]) : null)
            setContextData(
              d && Array.isArray(d.categories) && typeof d.totalTokens === 'number'
                ? (d as unknown as ContextDataLite)
                : null,
            )
            setSettingsData(d && d.applied && Array.isArray(d.sources) ? (d as unknown as SettingsDataLite) : null)
            break
          }
          case 'rewound':
            // 回滚会销毁并重生 CLI 进程（dispose 先摘 map 再 kill，onExit 不会触发），
            // 进行中的流式草稿/待配对工具结果/相位指示全部失效，必须一并清理，
            // 否则陈旧草稿会挂在回滚标签之下。
            ingestApi.setDraftBoth(null)
            ingestApi.pendingResultsRef.current.clear()
            setPhase(undefined)
            ingestApi.setMsgs((prev) => {
              const idx = prev.findIndex((m) => m.id === ev.userMessageId)
              const base = idx >= 0 ? prev.slice(0, idx + 1) : prev
              const label = ev.scope === 'both' ? '↩ 对话和文件已回滚' : '↩ 对话已回滚'
              return [...base, { id: nextId(), role: 'system', blocks: [{ kind: 'text', text: label }] }]
            })
            break
          case 'cli':
            if (ingestApi.gapReloadingRef.current) break
            ingestApi.handleCli(ev.msg, ev.replay === true)
            break
          case 'tail': {
            // 外部会话 transcript 追加：与历史共用同一套归并；uuid 去重兜底（重连续订可能重放）
            const h = ev.msg
            if (h.uuid && ingestApi.messagesRef.current.some((m) => m.id === h.uuid)) break
            ingestApi.setMsgs((prev) => {
              const st: IngestState = { msgs: prev, toolIdx: ingestApi.toolPosRef.current, pending: ingestApi.pendingResultsRef.current }
              appendHistoryMsg(st, h)
              // 不在此 flush：tail 是逐条到达，tool_use 可能在后续行；孤儿在权威 idle 时统一浮现
              return st.msgs
            })
            // 尾到的主线 tool_result 给已存在桶补终态——外部会话（tailer 路径）没有
            // task_notification，这是它唯一的终态信号；与历史回填同规则：终态挂 30s 驱逐
            for (const blk of h.blocks) {
              if (blk.kind !== 'tool_result' || !blk.id) continue
              taskApi.settleBucketFromResult(blk.id, blk.text ?? '', blk.isError === true)
            }
            break
          }
          case 'moved': {
            // /clear 对话重置：进程已换新 sessionId 续跑，Hub 重键完毕——跳到新会话页
            //（旧 transcript 在磁盘原样保留，列表页可见）
            const parts = ev.targetKey.split('|')
            props.onNavigate?.(
              makeSessionInfo({
                key: ev.targetKey,
                slug: parts[1] ?? session.slug,
                sessionId: ev.targetSessionId ?? 'new',
                cwd: session.cwd,
                backend: 'claude',
                managed: { spawned: true, busy: false, clients: 0 },
              }),
            )
            break
          }
          case 'replay_gap': {
            // 断线太久，服务端环形缓冲已挤掉起点：补发会留空洞，直接重载历史。
            // transcript 是权威事实源，重载一定能补齐（代价只是一次 HTTP）。
            // 必须与初次加载走同一 loader——Codex 没有 Claude transcript 路径。
            // 先挡住 cli 再清草稿：环里残留的 stream/assistant 不能在重载完成前改抄本。
            ingestApi.gapReloadingRef.current = true
            ingestApi.setDraftBoth(null)
            ingestApi.pendingResultsRef.current.clear()
            setPhase(undefined)
            const gapKey = session.key
            loadSessionHistory()
              .then((resp) => {
                if (sockRef.current?.key !== gapKey) return // 异步返回时已切走
                ingestApi.applyHistory(resp)
                ingestApi.pushSystem('↻ 断线较久，已重新载入对话')
              })
              .catch(() => {
                if (sockRef.current?.key !== gapKey) return
                ingestApi.pushSystem('⚠ 重新载入对话失败，请手动刷新', 'error')
              })
              .finally(() => {
                if (sockRef.current?.key === gapKey) ingestApi.gapReloadingRef.current = false
              })
            break
          }
          case 'tail_reset': {
            // 外部会话截断了 transcript（rewind / clear）：重载历史并用新偏移重新订阅
            ingestApi.setDraftBoth(null)
            ingestApi.pendingResultsRef.current.clear()
            const keyAtFetch = session.key
            fetchHistory(session.slug, session.sessionId)
              .then((resp) => {
                // 异步返回时用户可能已切走：socket 已换成新会话的，弃掉过期结果
                if (sockRef.current?.key !== keyAtFetch) return
                ingestApi.applyHistory(resp)
              })
              .catch(() => {})
            break
          }
        }
      },
      (open) => {
        setConnected(open)
        if (!open) return
        // 重连必须 attach：Codex x| 靠它 resume；fromSeq 为 0 也要带上，
        // 才能取回「一条可落盘 cli 都没收到就断线」期间的环。首连走下面的 attach。
        if (sock.reconnecting) sock.send({ kind: 'attach', fromSeq: sock.replayFrom })
        // 重连后服务端的 tailer 已随连接断开被回收，用已知的偏移重新订阅（重放部分由 uuid 去重）
        if (ingestApi.historyOffsetRef.current != null) {
          sock.send({ kind: 'tail_subscribe', from: ingestApi.historyOffsetRef.current })
        }
      },
    )
    sockRef.current = sock
    sock.send({ kind: 'attach' })
    return () => sock.close()
  }, [session.key])

  // 只滚消息列表容器。禁止 scrollIntoView：它会连带滚动 overflow 祖先，
  // 把 absolute 顶/底栏一起顶出视口（表现为先对齐再跳到 top=-8px）。
  const scrollToBottom = (smooth = false) => {
    const el = scrollRef.current
    if (!el) return
    if (smooth) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
    else el.scrollTop = el.scrollHeight
  }

  /** 跟随滚动的 rAF 合帧：流式输出时 draft 每个 token 都变引用，逐次 smooth scrollTo
   *  会在移动端积出可感 jank（smooth 动画彼此打断）。合到下一帧只滚一次，
   *  且流式期间用 auto——smooth 的缓动跟不上 token 速率，反而拖尾。 */
  const followRaf = useRef(0)
  const scheduleFollow = (smooth: boolean) => {
    if (followRaf.current) return
    followRaf.current = requestAnimationFrame(() => {
      followRaf.current = 0
      if (atBottomRef.current) scrollToBottom(smooth)
    })
  }
  useEffect(() => () => cancelAnimationFrame(followRaf.current), [])

  // 贴底时才自动跟随滚动；用户上翻时保持位置（用 ↓ 按钮回到底部）
  useEffect(() => {
    if (!atBottomRef.current) return
    scheduleFollow(!draft) // 流式进行中走 auto，收尾/新消息才用 smooth
  }, [messages, approvals, draft])

  const onScroll = () => {
    const el = scrollRef.current
    if (!el) return
    const at = el.scrollHeight - el.scrollTop - el.clientHeight < 80
    atBottomRef.current = at
    setAtBottom(at)
  }

  // ---------- 发送 ----------
  const runQuery = (query: string, title: string) => {
    querySeq.current += 1
    setDetailTitle(title)
    setDetailContent('加载中…')
    sockRef.current?.send({ kind: 'query', id: `q-${querySeq.current}`, query })
  }

  /** 各档实际配置的模型名（StatusPill 打开时实时拉取；null = 未拉取/失败 → 降级 tier 名） */
  const [modelNames, setModelNames] = useState<Record<string, TierModelName> | null>(null)
  /** claude 专属：开 StatusPill 面板即查当前设置（配置改动即刻反映，无需等会话重启） */
  const loadModelNames = () => {
    if (isCodex) return
    void fetchClaudeModelNames(session.cwd)
      .then(setModelNames)
      .catch(() => {})
  }

  /** MCP 管理动作（claude）：reconnect / toggle。复用 query 通道（带 extra 的带应答控制请求） */
  const mcpAction = (serverName: string, action: 'mcp_reconnect' | 'mcp_toggle', enabled?: boolean) => {
    if (mcpBusy) return
    setMcpBusy(`${serverName}:${action}`)
    querySeq.current += 1
    const id = `q-${querySeq.current}`
    pendingMcpActionRef.current = id
    sockRef.current?.send({
      kind: 'query',
      id,
      query: action,
      extra: { serverName, ...(enabled === undefined ? {} : { enabled }) },
    })
  }

  // ---------- goal 设定/清除：claude 走 /goal 斜杠命令（本地命令，不进模型上下文），codex 走 thread/goal RPC ----------
  const sendGoal = (condition?: string) => {
    if (isCodex) {
      sockRef.current?.send(
        condition
          ? { kind: 'control', subtype: 'set_goal', extra: { objective: condition } }
          : { kind: 'control', subtype: 'clear_goal' },
      )
    } else {
      sockRef.current?.send({ kind: 'user', text: condition ? `/goal ${condition}` : '/goal clear' })
    }
    ingestApi.pushSystem(condition ? `◎ 已设定目标：${condition}` : '◎ 已清除目标')
  }

  // ---------- StatusPill 共享处理器（claude/codex 两个胶囊的 mode/effort 同构；model 因本地回显差异分开） ----------
  const handleSetMode = (m: string) => {
    setPermMode(m)
    sockRef.current?.send({ kind: 'control', subtype: 'set_permission_mode', extra: { mode: m } })
  }
  const handleSetEffort = (e: string) => {
    setEffort(e)
    sockRef.current?.send({ kind: 'update_env', variables: { CLAUDE_CODE_EFFORT_LEVEL: e } })
  }

  /** 斜杠拦截动作的副作用执行器（拦截表本身已数据化下沉 lib/slashIntercept.ts，含判例注释） */
  const runSlashAction = (a: SlashAction) => {
    const sock = sockRef.current
    switch (a.type) {
      case 'openRewind':
        setShowRewind(true)
        return
      case 'btw':
        if (a.question) sock?.send({ kind: 'btw', question: a.question })
        else ingestApi.pushSystem('用法：/btw <问题>')
        return
      case 'branch':
        if (isCodex) ingestApi.pushSystem('Codex 请用「回滚」面板的从此处分叉')
        else sock?.send({ kind: 'branch', ...(a.name ? { name: a.name } : {}) })
        return
      case 'exitHint':
        ingestApi.pushSystem('此命令会终止 CLI 进程。要结束会话请回列表页归档（⌄ 按钮），进程回收由服务端空闲策略处理')
        return
      case 'compact':
        sock?.send({ kind: 'control', subtype: 'compact' })
        return
      case 'context': {
        // codex 无 get_context_usage 对应物；用状态里的累计 token 用量顶一句
        const u = state.usage
        ingestApi.pushSystem(
          u
            ? `◈ 线程累计：in ${u.inputTokens} / out ${u.outputTokens}${u.reasoningTokens ? ` / reasoning ${u.reasoningTokens}` : ''}（窗口占用明细请开「详情」）`
            : '◈ 暂无用量数据（先跑一轮）',
        )
        return
      }
      case 'goal':
        if (a.clear) sendGoal()
        else if (a.condition) sendGoal(a.condition)
        else ingestApi.pushSystem(state.goal ? `◎ 当前目标：${state.goal.condition}` : '用法：/goal <条件>，/goal clear 清除')
        return
      case 'review':
        sock?.send({ kind: 'control', subtype: 'review', ...(a.instructions ? { extra: { instructions: a.instructions } } : {}) })
        ingestApi.pushSystem(a.instructions ? `◈ 审查中：${a.instructions}` : '◈ 审查未提交的改动中…')
        return
      case 'rename':
        if (!a.name) {
          ingestApi.pushSystem('用法：/rename <新名字>')
          return
        }
        sock?.send({ kind: 'control', subtype: 'rename', extra: { name: a.name } })
        ingestApi.pushSystem(`✎ 重命名线程为「${a.name}」`)
        return
      case 'newThread': {
        const cwd = session.cwd
        if (cwd) {
          void createSession(cwd, 'codex').then(({ key }) =>
            props.onNavigate?.(
              makeSessionInfo({ key, slug: 'codex', sessionId: 'new', cwd, backend: 'codex', status: 'offline' }),
            ),
          )
        } else {
          ingestApi.pushSystem('⚠ 未知当前目录，无法新建线程', 'error')
        }
        return
      }
    }
  }

  const send = () => {
    const text = input.trim()
    const sock = sockRef.current
    if ((!text && pendingImages.length === 0) || !sock) return

    // 斜杠命令拦截：表与判例在 lib/slashIntercept.ts（顺序即优先级），命中即拦截并清空输入框。
    // codex 的斜杠命令不会被 app-server 解释（原样进模型上下文），有对应物的必须前端拦截。
    const action = interceptSlash(text, { isCodex })
    if (action) {
      runSlashAction(action)
      setInput('')
      return
    }

    const echoBlocks: Block[] = [
      ...pendingImages.map((img) => ({ kind: 'image' as const, src: imgPreviewSrc(img) })),
      ...(text ? [{ kind: 'text' as const, text }] : []),
    ]
    ingestApi.pushMsg({ id: nextId(), role: 'user', blocks: echoBlocks })
    sock.send({
      kind: 'user',
      text,
      ...(busy ? { sendMode } : {}),
      ...(pendingImages.length > 0 ? { attachments: pendingImages } : {}),
    })
    setInput('')
    setPendingImages([])
  }

  // rewindPreview 会对每条用户消息跑正则解析，只有选择器打开时才计算
  const rewindTargets = useMemo(() => {
    if (!showRewind) return []
    return messages
      .filter((m) => m.role === 'user' && m.id.includes('-') && m.rewindable !== false)
      .map((m) => {
        const rawText = m.blocks
          .filter((block): block is Extract<Block, { kind: 'text' }> => block.kind === 'text')
          .map((block) => block.text)
          .join('\n\n')
        return { uuid: m.id, timestamp: m.timestamp, ...rewindPreview(rawText) }
      })
  }, [showRewind, messages])

  // 渲染行在 Chat 层算：Transcript 保持纯展示，重进/重渲时不重复摊平
  const transcriptRows = useMemo(() => buildTranscriptRows(messages, draft), [messages, draft])

  const busy = state.busy
  const waiting = state.waiting || approvals.length > 0
  const usageLine = usageSummary(state.usage, 'tok ')
  const statusLine = statusLineOf(state, { connected, phase, waiting })

  return (
    <div className="flex h-full min-h-0 bg-bg text-ink">
      <div className="relative min-h-0 min-w-0 flex-1 overflow-clip">
      {/* 消息抄本：占满整个视口，上下各留 ~100px 空区避让悬浮栏 */}
      <div ref={scrollRef} onScroll={onScroll} className="h-full overflow-y-auto">
        <div className="mx-auto max-w-3xl px-[17px] pb-[300px] pt-[84px] md:px-[29px]">
          <Transcript rows={transcriptRows} draft={draft} />

          {approvals.map((a) => (
            <ApprovalCard
              key={a.requestId}
              approval={a}
              onDecision={(decision) => sockRef.current?.send({ kind: 'approval', requestId: a.requestId, decision })}
            />
          ))}

          {/* 底部 100px 空位上方：后端徽标（忙碌旋转 / 空闲可点彩蛋） */}
          <div className="mt-4 ml-[10px] flex items-center gap-2.5">
            {isCodex ? (
              <CodexMark active={busy || Boolean(draft) || Boolean(phase)} size={28} />
            ) : (
              <ClaudeStar active={busy || Boolean(draft) || Boolean(phase)} size={28} />
            )}
          </div>
        </div>
      </div>

      {/* 顶栏：悬浮磨砂横带 */}
      <ChatHeader
        session={session}
        connected={connected}
        statusLine={statusLine}
        busy={busy}
        phase={phase}
        onBack={props.onBack}
        tasks={tasks}
        tasksOpen={tasksOpen}
        onToggleTasks={() => setTasksOpen((v) => !v)}
        isExisting={isExisting}
        isCodex={isCodex}
        sessionId={state.sessionId}
        currentSessionId={currentSessionId}
        goal={state.goal}
        usageLine={usageLine}
        moreOpen={moreOpen}
        setMoreOpen={setMoreOpen}
        onSystemMessage={ingestApi.pushSystem}
        onToggleDetail={() => {
          setDetailOpen((v) => !v)
          // codex 无 get_context_usage 对应物，默认落在 MCP 状态上
          if (!detailOpen) runQuery(isCodex ? 'mcp_status' : 'get_context_usage', isCodex ? 'MCP 状态' : 'context 用量')
        }}
        goalOpen={goalOpen}
        onToggleGoal={() => {
          setGoalDraft(state.goal?.condition ?? '')
          setGoalOpen((v) => !v)
        }}
        onCloseGoal={() => setGoalOpen(false)}
        goalDraft={goalDraft}
        onGoalDraftChange={setGoalDraft}
        onSendGoal={sendGoal}
        onBranch={() => sockRef.current?.send({ kind: 'branch' })}
        handoffBusy={handoffBusy}
        onHandoff={() => {
          const toBackend = isCodex ? 'claude' : 'codex'
          setHandoffBusy(true)
          startHandoff(session.key, toBackend)
            .catch((e) => ingestApi.pushSystem(`⚠ 接力失败: ${e instanceof Error ? e.message : e}`, 'error'))
            .finally(() => setHandoffBusy(false))
        }}
        lineage={lineage}
        onNavigate={props.onNavigate}
      >
        {/* 会话详情抽屉 */}
        {detailOpen && (
          <DetailDrawer
            detailTitle={detailTitle}
            detailContent={detailContent}
            isCodex={isCodex}
            mcpServers={mcpServers}
            mcpBusy={mcpBusy}
            onMcpAction={mcpAction}
            contextData={contextData}
            settingsData={settingsData}
            modelNames={modelNames}
            onRunQuery={runQuery}
            onClose={() => setDetailOpen(false)}
          />
        )}
      </ChatHeader>

      {showRewind && (
        <RewindPicker
          targets={rewindTargets}
          mode={isCodex ? 'codex' : 'claude'}
          onClose={() => setShowRewind(false)}
          onRewindFiles={(uuid) => {
            sockRef.current?.send({ kind: 'control', subtype: 'rewind_files', extra: { user_message_id: uuid } })
            ingestApi.pushSystem('↩ 已请求回滚文件')
            setShowRewind(false)
          }}
          onRewindConversation={(uuid) => {
            sockRef.current?.send({ kind: 'rewind_conversation', userMessageId: uuid })
            setShowRewind(false)
          }}
          onRewindBoth={(uuid) => {
            sockRef.current?.send({ kind: 'rewind_both', userMessageId: uuid })
            setShowRewind(false)
          }}
        />
      )}

      {/* 输入区：悬浮磨砂圆角块；模型胶囊 / 图片 / 发送全收进块内 */}
      <Composer
        input={input}
        onInputChange={setInput}
        busy={busy}
        connected={connected}
        sendMode={sendMode}
        onSendModeChange={setSendMode}
        isCodex={isCodex}
        pendingImages={pendingImages}
        onPendingImagesChange={setPendingImages}
        onSend={send}
        onInterrupt={() => sockRef.current?.send({ kind: 'control', subtype: 'interrupt' })}
        atBottom={atBottom}
        onScrollToBottom={() => scrollToBottom(false)}
        slashCommands={state.slashCommands}
        initSlashCommands={initInfo.slashCommands}
        cfg={cfg}
        claudeModel={initInfo.model}
        permMode={permMode}
        effort={effort}
        modelNames={modelNames}
        onPanelOpen={loadModelNames}
        onSetClaudeModel={(m) => {
          setInitInfo((prev) => ({ ...prev, model: m }))
          sockRef.current?.send({ kind: 'control', subtype: 'set_model', extra: { model: m } })
        }}
        onSetMode={handleSetMode}
        onSetEffort={handleSetEffort}
        codexModels={codexModels}
        stateModel={state.model}
        statePermissionMode={state.permissionMode}
        stateEffort={state.effort}
        onSetCodexModel={(m) => {
          sockRef.current?.send({ kind: 'control', subtype: 'set_model', extra: { model: m } })
        }}
        context={state.context}
        usage={state.usage}
        onOpenFullDetail={
          !isCodex && isExisting
            ? () => {
                setDetailOpen(true)
                runQuery('get_context_usage', 'context 用量')
              }
            : undefined
        }
      />
      </div>
      <TasksPanel
        open={tasksOpen}
        onClose={() => setTasksOpen(false)}
        tasks={tasks}
        onStop={
          // codex app-server 没有 stop_task 对应物（sendControl 落 default 报错卡），不显示停止按钮
          isCodex
            ? undefined
            : (taskId) => sockRef.current?.send({ kind: 'control', subtype: 'stop_task', extra: { task_id: taskId } })
        }
      />
    </div>
  )
}
