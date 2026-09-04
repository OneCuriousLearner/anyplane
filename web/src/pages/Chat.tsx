import { useEffect, useMemo, useRef, useState } from 'react'
import { createSession, fetchClaudeModelNames, fetchCodexHistory, fetchCodexModels, fetchConfig, fetchHistory, fetchLineage, makeSessionInfo, startHandoff, type CodexModelInfo, type HistoryMessage, type HistoryResponse, type LineageResponse, type ServerConfigInfo, type SessionInfo, type TierModelName } from '../lib/api'
import { SessionSocket, type CliMsg, type ServerEvent, type SessionState } from '../lib/ws'
import { StatusPill } from '../components/StatusPill'
import { ApprovalCard } from '../components/ApprovalCard'
import { RewindPicker } from '../components/RewindPicker'
import { Transcript } from '../components/Transcript'
import { TasksPanel, type TaskFeed } from '../components/TasksPanel'
import { ClaudeMark } from '../components/ClaudeMark'
import { ClaudeStar } from '../components/ClaudeStar'
import { CodexMark } from '../components/CodexMark'
import { PopupPanel } from '../components/PopupPanel'
import { ContextRing } from '../components/ContextRing'
import { fmtTokens, nextId, rewindPreview, toolResultText, type Block, type ChatMsg } from '../lib/blocks'
import { isCodexKey, isExistingKey } from '../lib/key'
import { COMMAND_DESC, filterSlashHints, mergeSlashCommands, type SlashEntry } from '../lib/slashCommands'

const MORE_ITEM =
  'flex w-full items-center gap-2 rounded-[10px] px-3 py-2 text-left font-mono text-[12px] text-muted transition-colors hover:bg-surface hover:text-ink'

/** 复制到剪贴板：clipboard API 仅在安全上下文可用，http 局域网访问走 textarea 回退 */
async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    // 权限拒绝等 → 走回退
  }
  try {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.style.position = 'fixed'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.select()
    const ok = document.execCommand('copy')
    ta.remove()
    return ok
  } catch {
    return false
  }
}

interface Approval {
  requestId: string
  toolName: string
  input: unknown
}

/** claude mcp_status 应答里的单个服务器（buildMcpServerStatuses 形状） */
interface McpServerInfo {
  name: string
  /** connected / failed / disabled / pending / needs-auth 等（CLI 的 connection.type 直出） */
  status: string
  error?: string
  config?: { type?: string; command?: string; args?: string[]; url?: string }
  scope?: string
  tools?: { name: string }[]
}

/** claude get_context_usage 应答的取用子集（analyzeContext 的 ContextData 里我们渲染的部分） */
interface ContextDataLite {
  categories: { name: string; tokens: number; isDeferred?: boolean }[]
  totalTokens: number
  maxTokens: number
  percentage: number
  model?: string
}

/** claude get_settings 应答的取用子集（settings 全量不枚举——applied + sources 概览 + 原始 JSON 折叠） */
interface SettingsDataLite {
  applied?: { model?: string; effort?: string | null }
  sources?: { source: string; settings: Record<string, unknown> }[]
}

/** 流式草稿：一轮 assistant 输出的增量块（按 message.id + block index 归并） */
interface DraftBlock {
  idx: number
  kind: 'text' | 'thinking' | 'tool'
  text: string
  name?: string
  toolId?: string
  jsonBuf?: string
  finalized?: boolean
}
interface Draft {
  msgId?: string
  blocks: DraftBlock[]
}

const PHASE_LABEL: Record<string, string> = {
  requesting: '请求中',
  compacting: '压缩上下文',
}

/**
 * 历史加载与 tail 实时追加共用的消息归并：
 * tool_use ↔ tool_result 跨消息配对成卡，孤立结果降级为系统提示。
 * toolIdx：批量加载时由调用方持有的 toolUseId → 位置索引（O(1) 配对，免 O(n²) 回扫）；
 * 缺省（tail 单条追加）时线性回扫，并做不可变更新（out 与旧 state 共享 blocks 数组）。
 */
function appendHistoryMsg(out: ChatMsg[], h: HistoryMessage, toolIdx?: Map<string, { mi: number; bi: number }>): void {
  if (h.isMeta) return
  if (h.role === 'system' && h.subtype === 'compact_boundary') {
    out.push({ id: h.uuid ?? nextId(), role: 'system', systemKind: 'divider', compactMeta: h.compactMeta, blocks: [] })
    return
  }
  const pair = (toolUseId: string | undefined, text: string, isError: boolean): boolean => {
    if (!toolUseId) return false
    if (toolIdx) {
      const at = toolIdx.get(toolUseId)
      const b = at ? out[at.mi]?.blocks[at.bi] : undefined
      if (!at || !b || b.kind !== 'tool') return false
      out[at.mi].blocks[at.bi] = { ...b, resultText: text, resultError: isError, pending: false }
      return true
    }
    for (let mi = out.length - 1; mi >= 0; mi--) {
      const bi = out[mi].blocks.findIndex((b) => b.kind === 'tool' && b.id === toolUseId)
      if (bi < 0) continue
      const blocks = [...out[mi].blocks]
      const b = blocks[bi]
      if (b.kind === 'tool') {
        blocks[bi] = { ...b, resultText: text, resultError: isError, pending: false }
        out[mi] = { ...out[mi], blocks }
      }
      return true
    }
    return false
  }
  const blocks: Block[] = []
  const stray: { text: string; isError: boolean }[] = []
  for (const hb of h.blocks) {
    if (hb.kind === 'tool_use') {
      const id = hb.id ?? nextId()
      blocks.push({ kind: 'tool', id, name: hb.name ?? '?', input: hb.input })
      toolIdx?.set(id, { mi: out.length, bi: blocks.length - 1 })
    } else if (hb.kind === 'tool_result') {
      if (!pair(hb.id, hb.text ?? '', hb.isError === true)) stray.push({ text: hb.text ?? '', isError: hb.isError === true })
    } else if (hb.kind === 'image' && hb.src) {
      blocks.push({ kind: 'image', src: hb.src })
    } else if (hb.kind === 'text' || hb.kind === 'thinking') {
      blocks.push({ kind: hb.kind, text: hb.text ?? '' })
    }
  }
  if (blocks.length > 0) {
    out.push({ id: h.uuid ?? nextId(), role: h.role, blocks, timestamp: h.timestamp, rewindable: h.rewindable })
  }
  for (const r of stray) {
    out.push({
      id: nextId(),
      role: 'system',
      systemKind: r.isError ? 'error' : 'info',
      blocks: [{ kind: 'text', text: r.text.slice(0, 500) }],
    })
  }
}

/**
 * 把一条实时 sidechain CLI 消息（带 parent_tool_use_id 的完整 assistant/user）转成
 * HistoryMessage 形状，使其可以复用 appendHistoryMsg 落进后台任务桶。
 * 与 discovery.entryToHistoryMessage 的块映射保持一致（text/thinking/tool_use/tool_result）。
 */
function cliSidechainToHistory(rec: Record<string, unknown>): HistoryMessage | null {
  const type = rec.type
  if (type !== 'assistant' && type !== 'user') return null
  const content = (rec.message as { content?: unknown } | undefined)?.content
  const blocks: { kind: 'text' | 'thinking' | 'tool_use' | 'tool_result'; text?: string; name?: string; id?: string; input?: unknown; isError?: boolean }[] = []
  if (typeof content === 'string') {
    if (content.trim()) blocks.push({ kind: 'text', text: content })
  } else if (Array.isArray(content)) {
    for (const c of content as Record<string, unknown>[]) {
      if (c?.type === 'text' && typeof c.text === 'string' && c.text.trim()) blocks.push({ kind: 'text', text: c.text })
      else if (c?.type === 'thinking' && typeof c.thinking === 'string' && c.thinking.trim())
        blocks.push({ kind: 'thinking', text: c.thinking })
      else if (c?.type === 'tool_use') blocks.push({ kind: 'tool_use', name: c.name as string, id: c.id as string, input: c.input })
      else if (c?.type === 'tool_result')
        blocks.push({ kind: 'tool_result', id: c.tool_use_id as string, text: toolResultText(c.content), isError: c.is_error === true })
    }
  }
  if (blocks.length === 0) return null
  return { uuid: rec.uuid as string | undefined, role: type, blocks, timestamp: rec.timestamp as string | undefined }
}

/** 后台任务桶：TaskFeed + 归并用的 tool 配对索引与去重集合（不发布给渲染） */
interface TaskBucket extends TaskFeed {
  toolIdx: Map<string, { mi: number; bi: number }>
  seen: Set<string>
  /** codex 子线程转录已懒取过（防重取） */
  transcriptFetched?: boolean
}

/**
 * 终态卡片的展示宽限期：镜像官方协调器面板的 PANEL_GRACE_MS
 *（claude-code src/utils/task/framework.ts:28）——完成后留 30s 供扫一眼报告，随后驱逐。
 * 报告摘要仍留在主线 Agent 工具卡与系统消息里，驱逐不丢信息。
 */
const PANEL_GRACE_MS = 30_000

export function Chat(props: { session: SessionInfo; onBack: () => void; onNavigate?: (s: SessionInfo) => void }) {
  const { session } = props
  const [messages, setMessages] = useState<ChatMsg[]>([])
  const [input, setInput] = useState('')
  const [state, setState] = useState<SessionState>({ spawned: false, busy: false })
  const [connected, setConnected] = useState(false)
  const [approvals, setApprovals] = useState<Approval[]>([])
  const [cfg, setCfg] = useState<ServerConfigInfo>()
  const [showRewind, setShowRewind] = useState(false)
  const [draft, setDraft] = useState<Draft | null>(null)
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
  const fileInputRef = useRef<HTMLInputElement>(null)
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
  const moreBtnRef = useRef<HTMLButtonElement>(null)
  const [idCopied, setIdCopied] = useState(false)
  const querySeq = useRef(0)
  const sockRef = useRef<SessionSocket | undefined>(undefined)
  const scrollRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const [atBottom, setAtBottom] = useState(true)
  const atBottomRef = useRef(true)

  // ref 镜像：事件处理器在 React 渲染外触发，直接基于 ref 计算，避免过期闭包/updater 双重调用
  const messagesRef = useRef<ChatMsg[]>([])
  const draftRef = useRef<Draft | null>(null)
  const pendingResultsRef = useRef(new Map<string, { text: string; isError: boolean }>())
  /** 历史加载时服务端读到的 transcript 字节数，tail_subscribe 的起始偏移 */
  const historyOffsetRef = useRef<number | undefined>(undefined)

  // ---------- 后台任务（与主线并行的 agent/task/shell，右侧拉栏展示；task_type 全类型入桶） ----------
  const taskMapRef = useRef(new Map<string, TaskBucket>())
  const [tasks, setTasks] = useState<TaskFeed[]>([])
  const [tasksOpen, setTasksOpen] = useState(false)

  /** 发布桶快照：浅拷贝桶对象与消息数组，让 React 感知变化（事件为逐 turn 粒度，量小） */
  const pubTasks = () =>
    setTasks([...taskMapRef.current.values()].map((b) => ({ ...b, messages: [...b.messages] })))

  const taskBucket = (toolUseId: string): TaskBucket => {
    let b = taskMapRef.current.get(toolUseId)
    if (!b) {
      b = { toolUseId, status: 'running', messages: [], toolIdx: new Map(), seen: new Set() }
      taskMapRef.current.set(toolUseId, b)
    }
    return b
  }

  const appendTaskMsg = (toolUseId: string, h: HistoryMessage) => {
    const b = taskBucket(toolUseId)
    // 历史加载与 live 追加可能重叠（落盘与 WS 投递交界），按 uuid 去重
    if (h.uuid) {
      if (b.seen.has(h.uuid)) return
      b.seen.add(h.uuid)
    }
    appendHistoryMsg(b.messages, h, b.toolIdx)
  }

  /** sidechain（子代理内部消息）不进主抄本——落进对应后台任务桶，右侧栏展示。
   *  assistant（子代理输出）与 user（子代理 prompt / tool_result，桶内配对）两路同规则。 */
  const appendSidechain = (rec: Record<string, unknown>): boolean => {
    const ptui = rec.parent_tool_use_id as string | undefined
    if (!ptui) return false
    const h = cliSidechainToHistory(rec)
    if (h) {
      appendTaskMsg(ptui, h)
      pubTasks()
    }
    return true
  }

  /** 统一终态：状态 + 清心跳 + 挂驱逐倒计时（宽限期后 1s 滴答自动移除卡片）。
   *  live 与历史终态一视同仁——历史卡默示展示 30s 即足，长期驻留会让老会话侧栏越堆越多。 */
  const markTerminal = (b: TaskBucket, status: TaskFeed['status']) => {
    b.status = status
    b.activity = undefined
    b.evictAfter = Date.now() + PANEL_GRACE_MS
    maybeFetchCodexTranscript(b)
  }

  /** codex 子代理转录懒取：子线程不被父通知流转发，终态后经 thread/read 拉回填充 */
  const maybeFetchCodexTranscript = (b: TaskBucket) => {
    if (!isCodex || !b.agentId || b.transcriptFetched || b.messages.length > 0) return
    b.transcriptFetched = true
    fetchCodexHistory(b.agentId)
      .then((resp) => {
        for (const h of resp.messages) appendTaskMsg(b.toolUseId, h)
        pubTasks()
      })
      .catch(() => {})
  }

  /**
   * 用 SessionState.activeTasks（服务端权威运行任务表）水合桶：
   * 中途接入的客户端错过 live-only 的 task_started，没有这一步桶的首绘就会是终态。
   * 反方向：桶还 running 却不在任务表且会话空闲 → 通知在断线间隙丢了，判终态。
   * 判死只对 claude 生效——codex 服务端不维护任务表（backgroundTasks 恒空），空表无信息。
   */
  const hydrateTasks = (st: SessionState) => {
    if (!Array.isArray(st.activeTasks)) return
    let dirty = false
    const live = new Set<string>()
    for (const t of st.activeTasks) {
      if (!t.toolUseId) continue
      live.add(t.toolUseId)
      const existing = taskMapRef.current.get(t.toolUseId)
      if (existing) {
        // 终态不被水合覆盖；running 的补心跳信息
        if (existing.status === 'running' && t.lastToolName && existing.lastToolName !== t.lastToolName) {
          existing.lastToolName = t.lastToolName
          dirty = true
        }
        continue
      }
      const b = taskBucket(t.toolUseId)
      b.status = 'running'
      b.agentId = t.id // stop_task 需要 task_id，水合路径此前只建桶不记 agentId
      b.description = t.description ?? b.description
      b.agentType = t.taskType ?? b.agentType
      b.kind = t.taskType ?? b.kind
      b.lastToolName = t.lastToolName ?? b.lastToolName
      b.depth = t.depth ?? b.depth
      b.parentToolUseId = t.parentToolUseId ?? b.parentToolUseId
      dirty = true
    }
    if (!st.busy && !isCodex) {
      for (const b of taskMapRef.current.values()) {
        if (b.status === 'running' && !live.has(b.toolUseId)) {
          markTerminal(b, 'done')
          dirty = true
        }
      }
    }
    if (dirty) pubTasks()
  }

  const setMsgs = (up: (prev: ChatMsg[]) => ChatMsg[]) => {
    messagesRef.current = up(messagesRef.current)
    setMessages(messagesRef.current)
  }
  const setDraftBoth = (d: Draft | null) => {
    draftRef.current = d
    setDraft(d)
  }
  const pushMsg = (m: ChatMsg) => setMsgs((prev) => [...prev, m])
  const pushSystem = (text: string, kind: 'info' | 'error' = 'info') =>
    pushMsg({ id: nextId(), role: 'system', systemKind: kind, blocks: [{ kind: 'text', text }] })

  const isCodex = isCodexKey(session.key)
  const isExisting = isExistingKey(session.key)
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

  /** claude 权限模式名 → codex 预设档位（显示用） */
  const codexModeOf = (m?: string): string => {
    switch (m) {
      case 'bypassPermissions':
        return 'fullAccess'
      case 'acceptEdits':
      case 'auto':
        return 'workspaceAuto'
      case 'plan':
        return 'readOnly'
      case 'readOnly':
      case 'workspace':
      case 'workspaceAuto':
      case 'fullAccess':
        return m
      default:
        return 'workspace'
    }
  }

  const codexDefaultModel = codexModels?.find((m) => m.isDefault) ?? codexModels?.[0]
  const codexModelId = state.model ?? codexDefaultModel?.id
  const codexCurrentModel = codexModels?.find((m) => m.id === codexModelId) ?? codexDefaultModel
  const codexEffortLevels: readonly string[] = codexCurrentModel?.efforts.map((e) => e.value) ?? ['low', 'high', 'max']
  const codexCfg: ServerConfigInfo = {
    permissionPolicy: 'ask',
    permissionModes: ['readOnly', 'workspace', 'workspaceAuto', 'fullAccess'],
    effortLevels: [...codexEffortLevels],
    models: (codexModels ?? []).map((m) => m.id),
  }

  /** 历史响应落到消息列表 + 从读取位置续订 tail（初次加载与 tail_reset 重载共用） */
  const applyHistory = (resp: HistoryResponse) => {
    historyOffsetRef.current = resp.fileBytes
    const out: ChatMsg[] = []
    const toolIdx = new Map<string, { mi: number; bi: number }>()
    for (const h of resp.messages) appendHistoryMsg(out, h, toolIdx)
    setMsgs(() => out)

    // 子代理侧链进桶；终态/报告以主线 Agent 工具卡的配对结果为准（tool_result 已落盘 = 已完成）
    taskMapRef.current.clear()
    // 先扫主线找「已完成」的 Agent 调用（转录落盘即终态），它们在历史加载时**不建桶**——
    // 侧栏只放运行中与刚完成的卡，复活一堆 30s 后齐消失是噪声；翻旧账走主线 Agent 工具卡
    const finished = new Set<string>()
    for (const m of out) {
      for (const blk of m.blocks) {
        if (blk.kind === 'tool' && (blk.name === 'Agent' || blk.name === 'Task') && blk.pending === false && blk.id) {
          finished.add(blk.id)
        }
      }
    }
    for (const s of resp.subagents ?? []) {
      const id = s.toolUseId ?? s.agentId
      if (!id || finished.has(id)) continue // 已完成的在历史里不复活
      const b = taskBucket(id)
      b.agentId = s.agentId ?? b.agentId
      b.agentType = s.agentType ?? b.agentType
      b.description = s.description ?? b.description
      for (const h of s.messages) appendTaskMsg(b.toolUseId, h)
    }
    pubTasks()

    // 从历史读取位置续订 transcript 追加（外部会话的实时更新）；socket 未 open 时会排队
    // codex 的实时流走 app-server 订阅（attach 即 resume），无 tailer
    if (!isCodex) sockRef.current?.send({ kind: 'tail_subscribe', from: resp.fileBytes })
  }

  // ---------- 历史加载（切换会话时取消过期请求，避免「卡住不出对话」） ----------
  useEffect(() => {
    let cancelled = false
    setMsgs(() => [])
    setDraftBoth(null)
    pendingResultsRef.current.clear()
    historyOffsetRef.current = undefined
    // Chat 组件在 session 切换时会复用，清掉上一会话的运行时/待启动配置。
    // 新会话的缓存选择会由随后到达的 status 恢复。
    setInitInfo({})
    setPermMode(undefined)
    setEffort(undefined)
    setApprovals([])
    setPhase(undefined)
    taskMapRef.current.clear()
    setTasks([])
    setTasksOpen(false)
    if (!isExisting) return
    const loader = isCodex
      ? fetchCodexHistory(session.sessionId)
      : fetchHistory(session.slug, session.sessionId)
    loader
      .then((resp) => {
        if (cancelled) return
        applyHistory(resp)
      })
      .catch((e) => {
        if (!cancelled) pushSystem(`⚠ 加载历史失败: ${e}`, 'error')
      })
    return () => {
      cancelled = true
    }
  }, [session.key])

  // ---------- 终态卡片的 TTL 驱逐（仿官方协调器面板：1s 滴答扫 evictAfter） ----------
  useEffect(() => {
    const timer = setInterval(() => {
      const now = Date.now()
      let dirty = false
      for (const [id, b] of taskMapRef.current) {
        if (b.evictAfter != null && now >= b.evictAfter) {
          // 报告摘要仍留在主线 Agent 工具卡与「⚙ 后台任务完成」系统消息里，驱逐不丢信息
          taskMapRef.current.delete(id)
          dirty = true
        }
      }
      if (dirty) pubTasks()
      // 桶清空时收起侧栏——此时会话无运行中任务（running 桶永不驱逐），收起的都是终态卡
      if (dirty && taskMapRef.current.size === 0) setTasksOpen(false)
    }, 1000)
    return () => clearInterval(timer)
  }, [])

  // ---------- 流式草稿 ----------

  /** message_stop / result 时把草稿固化为一条 assistant 消息 */
  const commitDraft = () => {
    const d = draftRef.current
    if (!d) return
    setDraftBoth(null)
    if (d.blocks.length === 0) return
    const blocks: Block[] = []
    for (const b of d.blocks) {
      if (b.kind === 'tool') {
        let input: unknown
        try {
          input = b.jsonBuf ? JSON.parse(b.jsonBuf) : undefined
        } catch {}
        const toolId = b.toolId ?? nextId()
        const held = pendingResultsRef.current.get(toolId)
        if (held) pendingResultsRef.current.delete(toolId)
        blocks.push({
          kind: 'tool',
          id: toolId,
          name: b.name ?? '?',
          input,
          pending: !held,
          resultText: held?.text,
          resultError: held?.isError,
        })
      } else if (b.text.trim()) {
        blocks.push({ kind: b.kind, text: b.text })
      }
    }
    if (blocks.length > 0) pushMsg({ id: d.msgId ?? nextId(), role: 'assistant', blocks })
  }

  /** tool_result 配对到已渲染的工具卡片；工具块还在草稿里则暂存 */
  const pairToolResult = (toolUseId: string | undefined, text: string, isError: boolean) => {
    if (!toolUseId) return
    let found = false
    setMsgs((prev) =>
      prev.map((m) => {
        const bi = m.blocks.findIndex((b) => b.kind === 'tool' && b.id === toolUseId)
        if (bi < 0) return m
        found = true
        const blocks = [...m.blocks]
        const b = blocks[bi]
        if (b.kind === 'tool') blocks[bi] = { ...b, resultText: text, resultError: isError, pending: false }
        return { ...m, blocks }
      }),
    )
    if (!found) pendingResultsRef.current.set(toolUseId, { text, isError })
  }

  // ---------- CLI 消息处理 ----------
  const handleCli = (msg: CliMsg) => {
    const rec = msg as Record<string, unknown>

    // 流式增量事件（Anthropic API SSE 透传）
    if (msg.type === 'stream_event') {
      const ev = rec.event as
        | {
            type?: string
            index?: number
            message?: { id?: string }
            content_block?: { type?: string; id?: string; name?: string }
            delta?: { type?: string; text?: string; thinking?: string; partial_json?: string }
          }
        | undefined
      if (!ev?.type) return
      switch (ev.type) {
        case 'message_start':
          setDraftBoth({ msgId: ev.message?.id, blocks: [] })
          break
        case 'content_block_start': {
          const t = ev.content_block?.type
          const d: Draft = draftRef.current ?? { blocks: [] }
          const idx = ev.index ?? d.blocks.length
          if (!d.blocks.some((b) => b.idx === idx)) {
            d.blocks.push({
              idx,
              kind: t === 'thinking' ? 'thinking' : t === 'tool_use' ? 'tool' : 'text',
              text: '',
              toolId: ev.content_block?.id,
              name: ev.content_block?.name,
              jsonBuf: t === 'tool_use' ? '' : undefined,
            })
            d.blocks.sort((a, b) => a.idx - b.idx)
            setDraftBoth({ ...d })
          }
          break
        }
        case 'content_block_delta': {
          const delta = ev.delta
          if (!delta) break
          const d: Draft = draftRef.current ?? { blocks: [] }
          const idx = ev.index ?? d.blocks.length - 1
          let b = d.blocks.find((x) => x.idx === idx)
          if (!b) {
            b = { idx, kind: 'text', text: '' }
            d.blocks.push(b)
            d.blocks.sort((a, z) => a.idx - z.idx)
          }
          if (delta.type === 'text_delta' && delta.text) b.text += delta.text
          else if (delta.type === 'thinking_delta' && delta.thinking) {
            b.kind = 'thinking'
            b.text += delta.thinking
          } else if (delta.type === 'input_json_delta' && delta.partial_json) b.jsonBuf = (b.jsonBuf ?? '') + delta.partial_json
          // signature_delta 永不展示
          setDraftBoth({ ...d, blocks: [...d.blocks] })
          break
        }
        case 'message_stop':
          commitDraft()
          break
        // content_block_stop / message_delta 无需处理（assistant 快照与 result 会收尾）
      }
      return
    }

    if (msg.type === 'control_response') {
      const resp = rec.response as { subtype?: string; error?: string } | undefined
      if (resp?.subtype === 'error') pushSystem(`⚠ ${resp.error ?? '控制请求失败'}`, 'error')
      return
    }

    if (msg.type === 'assistant') {
      if (appendSidechain(rec)) return
      const content = msg.message?.content
      const blocks = Array.isArray(content) ? content : []
      const msgId = (rec.message as { id?: string } | undefined)?.id
      const d = draftRef.current
      if (!d || msgId !== d.msgId) {
        // 去重兜底：同 msgId 的 assistant 消息已落过（旧事件序/重放/快照迟到）时不再落第二条
        if (msgId && messagesRef.current.some((m) => m.id === msgId && m.role === 'assistant')) return
        // 没有对应草稿（如中途接入）：直接落为完整消息
        const direct: Block[] = []
        for (const c of blocks) {
          if (c?.type === 'text' && c.text?.trim()) direct.push({ kind: 'text', text: c.text })
          else if (c?.type === 'thinking' && c.thinking?.trim()) direct.push({ kind: 'thinking', text: c.thinking })
          else if (c?.type === 'tool_use')
            direct.push({ kind: 'tool', id: c.id ?? nextId(), name: c.name ?? '?', input: c.input, pending: true })
        }
        if (direct.length > 0) pushMsg({ id: msg.uuid ?? nextId(), role: 'assistant', blocks: direct })
        return
      }
      // 块快照：把草稿中对应的增量块定稿（去重关键：同 message.id 同 kind 按序匹配）
      const dblocks = d.blocks.map((b) => ({ ...b }))
      for (const c of blocks) {
        const kind = c?.type === 'thinking' ? 'thinking' : c?.type === 'tool_use' ? 'tool' : 'text'
        const b = dblocks.find((x) => !x.finalized && x.kind === kind && (kind !== 'tool' || !c.id || x.toolId === c.id))
        if (!b) continue
        b.finalized = true
        if (c?.type === 'text' && c.text) b.text = c.text
        else if (c?.type === 'thinking' && c.thinking) b.text = c.thinking
        else if (c?.type === 'tool_use') {
          b.name = c.name ?? b.name
          b.toolId = c.id ?? b.toolId
          b.jsonBuf = c.input != null ? JSON.stringify(c.input) : b.jsonBuf
        }
      }
      setDraftBoth({ ...d, blocks: dblocks })
      return
    }

    if (msg.type === 'user') {
      if (msg.isMeta) return
      if (appendSidechain(rec)) return
      const content = msg.message?.content
      const blocks = Array.isArray(content) ? content : typeof content === 'string' ? [{ type: 'text', text: content }] : []
      const textBlocks: Block[] = []
      for (const c of blocks) {
        if (c?.type === 'tool_result') {
          pairToolResult(c.tool_use_id, toolResultText(c.content), c.is_error === true)
          // 主线 Agent tool_result 是子代理的终态兜底（正常路径是 task_notification 先到）
          const b = c.tool_use_id ? taskMapRef.current.get(c.tool_use_id) : undefined
          if (b && b.status === 'running') {
            markTerminal(b, c.is_error === true ? 'error' : 'done')
            if (!b.summary) {
              const t = toolResultText(c.content)
              if (t) b.summary = t.slice(0, 500)
            }
            pubTasks()
          }
        } else if (c?.type === 'text' && c.text?.trim()) {
          // /goal 的评估器反馈（Stop hook）：goal 循环内的中途评估，渲染为系统提示而非用户气泡
          if (c.text.startsWith('Stop hook feedback:')) {
            const body = c.text.replace(/^Stop hook feedback:\s*/, '')
            pushSystem(`◎ 目标评估：${body.slice(0, 300)}`)
            continue
          }
          textBlocks.push({ kind: 'text', text: c.text })
        }
      }
      if (textBlocks.length > 0) pushMsg({ id: msg.uuid ?? nextId(), role: 'user', blocks: textBlocks })
      return
    }

    if (msg.type === 'system') {
      switch (msg.subtype) {
        case 'init': {
          const slash = Array.isArray(rec.slash_commands) ? (rec.slash_commands as string[]) : undefined
          setInitInfo({ model: rec.model as string | undefined, slashCommands: slash })
          setPermMode(rec.permissionMode as string | undefined)
          break
        }
        case 'status': {
          // status 是 string|null（如 "requesting"/"compacting"），不是对象——勿迭代
          const st = rec.status
          setPhase(typeof st === 'string' ? st : undefined)
          if (typeof rec.permissionMode === 'string') setPermMode(rec.permissionMode)
          break
        }
        case 'thinking_tokens':
          break // 增量 token 估算，不展示
        case 'task_started': {
          // 生命周期事件是桶的主注册点（tool_use_id ↔ task_id 映射在此建立）
          const toolUseId = rec.tool_use_id as string | undefined
          if (toolUseId) {
            const b = taskBucket(toolUseId)
            b.agentId = (rec.task_id as string | undefined) ?? b.agentId
            // codex 合成事件经 agent_thread_id 携带子线程 id（终态后懒拉转录用）
            b.agentId = (rec.agent_thread_id as string | undefined) ?? b.agentId
            b.description = (rec.description as string | undefined) ?? b.description
            b.agentType = (rec.subagent_type as string | undefined) ?? (rec.task_type as string | undefined) ?? b.agentType
            b.kind = (rec.task_type as string | undefined) ?? b.kind
            b.depth = (rec.spawn_depth as number | undefined) ?? b.depth
            b.status = 'running'
            pubTasks()
            // 桌面端自动拉开侧栏（移动端屏幕小，只亮顶栏按钮）
            if (window.matchMedia('(min-width: 768px)').matches) setTasksOpen(true)
          }
          pushSystem(`⚙ 后台任务启动：${String(rec.description ?? '')}`)
          break
        }
        case 'task_progress': {
          // 心跳：拟人化动作描述 + 用量，解决"长 turn 安静期像卡住"的体感
          // 桶不存在也补建——中途接入错过 task_started 时，心跳就是首个可见信号
          const toolUseId = rec.tool_use_id as string | undefined
          if (toolUseId) {
            const b = taskBucket(toolUseId)
            b.activity = (rec.description as string | undefined) ?? b.activity
            b.lastToolName = (rec.last_tool_name as string | undefined) ?? b.lastToolName
            b.usage = (rec.usage as TaskFeed['usage'] | undefined) ?? b.usage
            pubTasks()
          }
          break
        }
        case 'task_updated': {
          // 终态 patch（completed/stopped/failed）；只带 task_id，经 agentId 映射回桶
          const taskId = rec.task_id as string | undefined
          const patch = rec.patch as { status?: string } | undefined
          const b = [...taskMapRef.current.values()].find((x) => x.agentId === taskId)
          if (b && patch?.status && patch.status !== 'running' && b.status === 'running') {
            markTerminal(b, patch.status === 'completed' ? 'done' : patch.status === 'stopped' ? 'stopped' : 'error')
            pubTasks()
          }
          break
        }
        case 'task_notification': {
          const summary = typeof rec.summary === 'string' ? rec.summary : ''
          const toolUseId = rec.tool_use_id as string | undefined
          if (toolUseId) {
            const b = taskBucket(toolUseId)
            markTerminal(b, rec.status === 'completed' ? 'done' : rec.status === 'stopped' ? 'stopped' : 'error')
            b.summary = summary || b.summary
            b.usage = (rec.usage as TaskFeed['usage'] | undefined) ?? b.usage
            pubTasks()
          }
          pushSystem(`⚙ 后台任务完成${summary ? `：${summary.slice(0, 200)}` : ''}`)
          break
        }
        case 'compact_boundary': {
          const meta = (rec.compactMetadata ?? {}) as { preTokens?: number; postTokens?: number }
          pushMsg({ id: nextId(), role: 'system', systemKind: 'divider', compactMeta: meta, blocks: [] })
          break
        }
      }
      return
    }

    if (msg.type === 'result') {
      commitDraft()
      setPhase(undefined)
      const isErr = rec.is_error === true
      const dur = typeof rec.duration_ms === 'number' ? `${Math.round(rec.duration_ms / 1000)}s` : undefined
      const usage = rec.usage as { output_tokens?: number } | undefined
      const parts = [dur, usage?.output_tokens != null ? `${usage.output_tokens} tok` : undefined].filter(Boolean)
      if (isErr) {
        pushSystem(`⚠ ${String(rec.result ?? rec.subtype ?? '执行出错')}`, 'error')
      } else if (parts.length > 0) {
        pushSystem(`─ 本轮 ${parts.join(' · ')}`)
      }
      return
    }
  }

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
            hydrateTasks(ev.state)
            // 进程已退出时固化/清理未完成的流式草稿，避免半截内容悬挂
            if (ev.state.exited) {
              commitDraft()
              setPhase(undefined)
            } else if (ev.state.sessionState === 'idle' && !ev.state.busy && !ev.state.waiting && draftRef.current) {
              // 自愈：权威 idle 到达时清掉陈旧流式草稿。服务端重启/断线期间 turn 终结时
              // 客户端拿不到终结事件，"生成中"会永远挂着（实测：watch 重载后复现）。
              // 等审批（waiting/requires_action）期间草稿是合法的，不在此清理。
              setDraftBoth(null)
              setPhase(undefined)
              pendingResultsRef.current.clear()
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
          case 'error':
            pushSystem(`⚠ ${ev.message}`, 'error')
            break
          case 'btw_pending':
            // 创建侧问卡片（发送方与其他客户端都以此为准）
            if (!messagesRef.current.some((m) => m.btw === ev.question && m.btwPending)) {
              pushMsg({ id: nextId(), role: 'assistant', btw: ev.question, btwPending: true, blocks: [] })
            }
            break
          case 'btw_delta': {
            const target = messagesRef.current.find((m) => m.btw === ev.question && m.btwPending)
            if (!target) break
            setMsgs((prev) =>
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
          case 'btw_result':
            setMsgs((prev) =>
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
          case 'forked': {
            if (ev.branchOf) {
              // claude 懒分叉：b| key 导航，首条消息才真正 --fork-session；
              // 历史视图直接读源会话 transcript（分支将原样继承它）
              pushSystem(
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
            pushSystem('⎇ 已分叉：新会话携带所选消息之前的历史，原会话保持不动')
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
            pushSystem(`⇄ 源会话正在生成交接简报（→ ${ev.toBackend === 'codex' ? 'Codex' : 'Claude'}）…`)
            break
          case 'handoff_brief':
            break // 简报在 handoff_done 时一并展示
          case 'handoff_done': {
            pushMsg({
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
            pushSystem(`⚠ 接力失败: ${ev.message}`, 'error')
            break
          case 'query_result': {
            // MCP 管理动作应答（按 query id 辨认）：清忙态、给反馈、成功后刷新清单
            if (pendingMcpActionRef.current && ev.id === pendingMcpActionRef.current) {
              pendingMcpActionRef.current = null
              setMcpBusy(null)
              if (ev.ok) {
                pushSystem('✓ MCP 操作完成')
                runQuery('mcp_status', 'MCP 状态')
              } else {
                pushSystem(`⚠ MCP 操作失败: ${ev.error ?? '未知错误'}`, 'error')
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
            setDraftBoth(null)
            pendingResultsRef.current.clear()
            setPhase(undefined)
            setMsgs((prev) => {
              const idx = prev.findIndex((m) => m.id === ev.userMessageId)
              const base = idx >= 0 ? prev.slice(0, idx + 1) : prev
              const label = ev.scope === 'both' ? '↩ 对话和文件已回滚' : '↩ 对话已回滚'
              return [...base, { id: nextId(), role: 'system', blocks: [{ kind: 'text', text: label }] }]
            })
            break
          case 'cli':
            handleCli(ev.msg)
            break
          case 'tail': {
            // 外部会话 transcript 追加：与历史共用同一套归并；uuid 去重兜底（重连续订可能重放）
            const h = ev.msg
            if (h.uuid && messagesRef.current.some((m) => m.id === h.uuid)) break
            setMsgs((prev) => {
              const out = [...prev]
              appendHistoryMsg(out, h)
              return out
            })
            // 尾到的主线 tool_result 给已存在桶补终态——外部会话（tailer 路径）没有
            // task_notification，这是它唯一的终态信号；与历史回填同规则：终态挂 30s 驱逐
            for (const blk of h.blocks) {
              if (blk.kind !== 'tool_result' || !blk.id) continue
              const b = taskMapRef.current.get(blk.id)
              if (b && b.status === 'running') {
                markTerminal(b, blk.isError ? 'error' : 'done')
                if (!b.summary && blk.text) b.summary = blk.text.slice(0, 500)
                pubTasks()
              }
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
          case 'tail_reset': {
            // 外部会话截断了 transcript（rewind / clear）：重载历史并用新偏移重新订阅
            setDraftBoth(null)
            pendingResultsRef.current.clear()
            const keyAtFetch = session.key
            fetchHistory(session.slug, session.sessionId)
              .then((resp) => {
                // 异步返回时用户可能已切走：socket 已换成新会话的，弃掉过期结果
                if (sockRef.current?.key !== keyAtFetch) return
                applyHistory(resp)
              })
              .catch(() => {})
            break
          }
        }
      },
      (open) => {
        setConnected(open)
        // 重连后服务端的 tailer 已随连接断开被回收，用已知的偏移重新订阅（重放部分由 uuid 去重）
        if (open && historyOffsetRef.current != null) {
          sock.send({ kind: 'tail_subscribe', from: historyOffsetRef.current })
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

  // 贴底时才自动跟随滚动；用户上翻时保持位置（用 ↓ 按钮回到底部）
  useEffect(() => {
    if (atBottomRef.current) scrollToBottom(true)
  }, [messages, approvals, draft])

  // 输入框自适应高度：随内容增长，超过 200px 后不再扩大、内部滚动。
  // 注意 border-box：style.height 包含边框，需补回上下边框宽，否则单行时内容被裁出滚动条
  useEffect(() => {
    const el = inputRef.current
    if (!el) return
    el.style.height = 'auto'
    const h = el.scrollHeight + (el.offsetHeight - el.clientHeight)
    el.style.height = `${Math.min(h, 200)}px`
    el.style.overflowY = h > 200 ? 'auto' : 'hidden'
  }, [input])

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

  const pickImages = (files: FileList | null) => {
    if (!files) return
    for (const f of Array.from(files)) {
      if (!f.type.startsWith('image/')) continue
      const reader = new FileReader()
      reader.onload = () => {
        const url = String(reader.result ?? '')
        const comma = url.indexOf(',')
        if (comma < 0) return
        setPendingImages((prev) => [
          ...prev,
          { name: f.name, mediaType: f.type, dataBase64: url.slice(comma + 1) },
        ])
      }
      reader.readAsDataURL(f)
    }
  }

  /** 预览 src：dataURL 与传输用 base64 本是一份数据，渲染时派生 */
  const imgPreviewSrc = (img: { mediaType: string; dataBase64: string }) =>
    `data:${img.mediaType};base64,${img.dataBase64}`

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
    pushSystem(condition ? `◎ 已设定目标：${condition}` : '◎ 已清除目标')
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

  const send = () => {
    const text = input.trim()
    if ((!text && pendingImages.length === 0) || !sockRef.current) return
    // /rewind 及其官方别名 /checkpoint /undo
    if (text === '/rewind' || text === '/checkpoint' || text === '/undo') {
      setShowRewind(true)
      setInput('')
      return
    }
    if (/^\/btw(\s|$)/.test(text)) {
      const q = text.slice(4).trim()
      if (q) sockRef.current.send({ kind: 'btw', question: q })
      else pushSystem('用法：/btw <问题>')
      setInput('')
      return
    }
    // 内建 /branch（有参时）会在 headless 下写孤立 fork 会话文件却不切换（context.resume 缺席），
    // 必须全形拦截（含参数）；名字透传给分叉 spawn 的 -n
    const branchMatch = text.match(/^\/(branch|fork)(?:\s+(.*))?$/)
    if (branchMatch) {
      if (isCodex) pushSystem('Codex 请用「回滚」面板的从此处分叉')
      else sockRef.current.send({ kind: 'branch', ...(branchMatch[2]?.trim() ? { name: branchMatch[2].trim() } : {}) })
      setInput('')
      return
    }
    // /exit /quit headless 下会真的杀掉 CLI 进程——web 场景下多半是误触，拦下给替代指引
    if (text === '/exit' || text === '/quit') {
      pushSystem('此命令会终止 CLI 进程。要结束会话请回列表页归档（⌄ 按钮），进程回收由服务端空闲策略处理')
      setInput('')
      return
    }
    // codex 的斜杠命令不会被 app-server 解释（原样进模型上下文），有对应物的必须前端拦截
    if (isCodex && text === '/compact') {
      sockRef.current.send({ kind: 'control', subtype: 'compact' })
      setInput('')
      return
    }
    if (isCodex && text === '/context') {
      // codex 无 get_context_usage 对应物；用状态里的累计 token 用量顶一句
      const u = state.usage
      pushSystem(
        u
          ? `◈ 线程累计：in ${u.inputTokens} / out ${u.outputTokens}${u.reasoningTokens ? ` / reasoning ${u.reasoningTokens}` : ''}（窗口占用明细请开「详情」）`
          : '◈ 暂无用量数据（先跑一轮）',
      )
      setInput('')
      return
    }
    if (isCodex && /^\/goal(\s|$)/.test(text)) {
      const arg = text.slice(5).trim()
      if (!arg) pushSystem(state.goal ? `◎ 当前目标：${state.goal.condition}` : '用法：/goal <条件>，/goal clear 清除')
      else if (/^(clear|stop|off|reset|none|cancel)$/i.test(arg)) sendGoal()
      else sendGoal(arg)
      setInput('')
      return
    }
    if (isCodex && /^\/review(\s|$)/.test(text)) {
      // codex review/start：无参审未提交改动，带参按自定义说明审（inline 在本线程跑）
      const instructions = text.slice(7).trim()
      sockRef.current.send({ kind: 'control', subtype: 'review', ...(instructions ? { extra: { instructions } } : {}) })
      pushSystem(instructions ? `◈ 审查中：${instructions}` : '◈ 审查未提交的改动中…')
      setInput('')
      return
    }
    if (isCodex && /^\/rename(\s|$)/.test(text)) {
      const name = text.slice(7).trim()
      if (!name) {
        pushSystem('用法：/rename <新名字>')
        setInput('')
        return
      }
      sockRef.current.send({ kind: 'control', subtype: 'rename', extra: { name } })
      pushSystem(`✎ 重命名线程为「${name}」`)
      setInput('')
      return
    }
    if (isCodex && (text === '/new' || text === '/clear')) {
      // codex /new 与 /clear 同为 thread/start 新线程：导航到 xn| 新会话页（懒启动）
      const cwd = session.cwd
      if (cwd) {
        void createSession(cwd, 'codex').then(({ key }) =>
          props.onNavigate?.(
            makeSessionInfo({ key, slug: 'codex', sessionId: 'new', cwd, backend: 'codex', status: 'offline' }),
          ),
        )
      } else {
        pushSystem('⚠ 未知当前目录，无法新建线程', 'error')
      }
      setInput('')
      return
    }
    const attachments = pendingImages.map(({ name, mediaType, dataBase64 }) => ({ name, mediaType, dataBase64 }))
    const echoBlocks: Block[] = [
      ...pendingImages.map((img) => ({ kind: 'image' as const, src: imgPreviewSrc(img) })),
      ...(text ? [{ kind: 'text' as const, text }] : []),
    ]
    pushMsg({ id: nextId(), role: 'user', blocks: echoBlocks })
    sockRef.current.send({
      kind: 'user',
      text,
      ...(busy ? { sendMode } : {}),
      ...(attachments.length > 0 ? { attachments } : {}),
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

  // 优先 initialize 握手返回的命令（含描述），其次 init 消息的命令名，最后空清单（合并层用自有命令兜底）
  const cliEntries: SlashEntry[] = state.slashCommands?.length
    ? state.slashCommands.map((c) => ({ name: c.name, desc: c.description }))
    : (initInfo.slashCommands ?? []).map((n) => ({ name: n, desc: COMMAND_DESC[n] }))
  // anyplane 自有命令置顶（中文描述优先于 CLI 同名命令），其后是 CLI 报告的完整清单
  const allEntries = mergeSlashCommands(cliEntries)
  const slashHints = filterSlashHints(input, allEntries)
  // 键盘导航：↑↓ 移动，Tab/Enter 采纳，Esc 关闭（索引随清单变化钳位）
  const [slashIdx, setSlashIdx] = useState(0)
  const slashActive = slashHints.length > 0 ? Math.min(slashIdx, slashHints.length - 1) : 0
  /** 面板滚动容器：键盘导航时保证高亮行在视口内 */
  const slashScrollRef = useRef<HTMLDivElement>(null)

  // 高亮行跟随滚动：只滚面板容器（getBoundingClientRect 相对数学），不动页面滚动条
  useEffect(() => {
    const c = slashScrollRef.current
    if (!c || slashHints.length === 0) return
    const row = c.querySelectorAll('button')[slashActive]
    if (!row) return
    const cRect = c.getBoundingClientRect()
    const rRect = row.getBoundingClientRect()
    if (rRect.top < cRect.top) c.scrollTop -= cRect.top - rRect.top
    else if (rRect.bottom > cRect.bottom) c.scrollTop += rRect.bottom - cRect.bottom
  }, [slashActive, slashHints.length])

  const busy = state.busy
  const waiting = state.waiting || approvals.length > 0
  const activeTaskCount = state.activeTaskCount ?? 0
  const u = state.usage
  const usageLine =
    u && u.inputTokens + u.outputTokens > 0
      ? `tok ↑${fmtTokens(u.inputTokens)} ↓${fmtTokens(u.outputTokens)}` +
        (u.cacheReadTokens ? ` · cache ${fmtTokens(u.cacheReadTokens)}` : '') +
        (u.reasoningTokens ? ` · rs ${fmtTokens(u.reasoningTokens)}` : '')
      : undefined
  const hasPendingStartConfig =
    !state.spawned && Boolean(state.model || state.permissionMode || state.effort)
  const statusLine = !connected
    ? '连接中…'
    : phase
      ? `${PHASE_LABEL[phase] ?? phase}…`
      : waiting
        ? state.tailing
          ? '外部会话等待操作'
          : '等待审批'
        : activeTaskCount > 0
          ? `${activeTaskCount} 个后台任务运行中`
        : busy
          ? state.tailing
            ? '外部会话工作中'
            : '工作中'
          : state.spawned
            ? state.sessionState === 'idle'
              ? 'CLI 空闲'
              : 'CLI 运行中'
            : state.exited
              ? '进程已退出'
              : state.tailing
                ? '外部会话 · 实时跟踪中'
                : hasPendingStartConfig
                  ? '配置已保存（发送消息时启动 CLI）'
                  : '浏览中（发送消息时启动 CLI）'

  return (
    <div className="flex h-full min-h-0 bg-bg text-ink">
      <div className="relative min-h-0 min-w-0 flex-1 overflow-clip">
      {/* 消息抄本：占满整个视口，上下各留 ~100px 空区避让悬浮栏 */}
      <div ref={scrollRef} onScroll={onScroll} className="h-full overflow-y-auto">
        <div className="mx-auto max-w-3xl px-[17px] pb-[300px] pt-[84px] md:px-[29px]">
          <Transcript messages={messages} draft={draft} />

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
      <div className="glass-bar absolute inset-x-0 top-0 z-30">
        <div className="px-3 py-2.5">
          <div className="flex items-center gap-2">
            <button
              className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-surface2 text-muted transition-colors hover:text-ink md:hidden"
              onClick={props.onBack}
              title="返回列表"
              aria-label="返回列表"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4" aria-hidden>
                <path d="M19 12H5M12 19l-7-7 7-7" />
              </svg>
            </button>
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-medium">{session.title ?? session.cwd ?? session.sessionId}</div>
              <div className="flex items-center gap-2 font-mono text-[10px] tracking-wide text-faint">
                <span className={connected ? 'text-ok' : 'text-accent'}>{connected ? '●' : '○'}</span>
                <span className={busy || phase ? 'text-busy' : ''}>{statusLine}</span>
              </div>
            </div>
            {/* 后台任务侧栏开关：有任务活动时出现；运行中带计数徽标与呼吸 */}
            {tasks.length > 0 && (
              <button
                type="button"
                className={`relative grid h-8 w-8 shrink-0 place-items-center rounded-full transition-colors ${
                  tasksOpen ? 'bg-surface2 text-ink' : 'bg-surface2 text-muted hover:text-ink'
                }`}
                title="后台任务"
                aria-label="后台任务"
                aria-expanded={tasksOpen}
                onClick={() => setTasksOpen((v) => !v)}
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4" aria-hidden>
                  <path d="M6 3v12" />
                  <circle cx="18" cy="6" r="3" />
                  <circle cx="6" cy="18" r="3" />
                  <path d="M18 9a9 9 0 0 1-9 9" />
                </svg>
                {tasks.some((s) => s.status === 'running') && (
                  <span className="absolute top-0.5 right-0.5 size-1.5 animate-pulse rounded-full bg-busy" aria-hidden />
                )}
              </button>
            )}
            {(isExisting || !isCodex || state.sessionId) && (
              <>
                <button
                  ref={moreBtnRef}
                  type="button"
                  className={`relative grid h-8 w-8 shrink-0 place-items-center rounded-full transition-colors ${
                    moreOpen ? 'bg-surface2 text-ink' : 'bg-surface2 text-muted hover:text-ink'
                  }`}
                  title="更多"
                  aria-label="更多"
                  aria-haspopup="menu"
                  aria-expanded={moreOpen}
                  onClick={() => setMoreOpen((v) => !v)}
                >
                  <svg viewBox="0 0 24 24" fill="currentColor" className="h-4 w-4" aria-hidden>
                    <circle cx="5" cy="12" r="1.8" />
                    <circle cx="12" cy="12" r="1.8" />
                    <circle cx="19" cy="12" r="1.8" />
                  </svg>
                  {state.goal && (
                    <span className="absolute top-0.5 right-0.5 size-1.5 rounded-full bg-ok" aria-hidden />
                  )}
                </button>
                <PopupPanel
                  open={moreOpen}
                  anchor={moreBtnRef.current}
                  onClose={() => setMoreOpen(false)}
                  placement="bottom-end"
                  offset={6}
                  className="min-w-44"
                >
                  {currentSessionId && (
                    <button
                      type="button"
                      role="menuitem"
                      className={`${MORE_ITEM} ${idCopied ? 'text-ok hover:text-ok' : ''}`}
                      title={`${isCodex ? 'thread id' : 'session id'}：${currentSessionId}（点击复制完整 ID）`}
                      onClick={() => {
                        void copyText(currentSessionId).then((ok) => {
                          if (!ok) {
                            setMoreOpen(false)
                            pushSystem(`⚠ 复制失败，请手动复制：${currentSessionId}`, 'error')
                            return
                          }
                          setIdCopied(true)
                          setTimeout(() => {
                            setIdCopied(false)
                            setMoreOpen(false)
                          }, 900)
                        })
                      }}
                    >
                      {idCopied ? '✓ 已复制' : `⧉ ${currentSessionId.slice(0, 8)}…`}
                    </button>
                  )}
                  {isExisting && (
                    <button
                      type="button"
                      role="menuitem"
                      className={MORE_ITEM}
                      title="会话详情：context 用量 / MCP 状态 / 设置"
                      onClick={() => {
                        setMoreOpen(false)
                        setDetailOpen((v) => !v)
                        // codex 无 get_context_usage 对应物，默认落在 MCP 状态上
                        if (!detailOpen) runQuery(isCodex ? 'mcp_status' : 'get_context_usage', isCodex ? 'MCP 状态' : 'context 用量')
                      }}
                    >
                      ▤ 详情
                    </button>
                  )}
                  {(!isCodex || state.sessionId) && (
                    <button
                      type="button"
                      role="menuitem"
                      className={`${MORE_ITEM} ${state.goal ? 'text-ok hover:text-ok' : ''}`}
                      title={
                        state.goal
                          ? `当前目标：${state.goal.condition}（点击管理）`
                          : '设定目标：agent 会持续工作直到条件达成（claude /goal · codex thread/goal）'
                      }
                      onClick={() => {
                        setMoreOpen(false)
                        setGoalDraft(state.goal?.condition ?? '')
                        setGoalOpen((v) => !v)
                      }}
                    >
                      {state.goal
                        ? `◎ ${state.goal.condition.slice(0, 16)}${state.goal.condition.length > 16 ? '…' : ''}`
                        : '◎ 目标'}
                    </button>
                  )}
                  {isExisting && !isCodex && (
                    <button
                      type="button"
                      role="menuitem"
                      className={MORE_ITEM}
                      title="分叉当前会话：新分支携带全部历史，原会话保持不动"
                      onClick={() => {
                        setMoreOpen(false)
                        sockRef.current?.send({ kind: 'branch' })
                      }}
                    >
                      ⎇ 分叉
                    </button>
                  )}
                  {isExisting && (
                    <button
                      type="button"
                      role="menuitem"
                      className={`${MORE_ITEM} disabled:opacity-40`}
                      disabled={handoffBusy}
                      title="让另一个 agent 接续本目录的工作（源会话 fork 自写简报，目标会话带简报进场）"
                      onClick={() => {
                        setMoreOpen(false)
                        const toBackend = isCodex ? 'claude' : 'codex'
                        setHandoffBusy(true)
                        startHandoff(session.key, toBackend)
                          .catch((e) => pushSystem(`⚠ 接力失败: ${e instanceof Error ? e.message : e}`, 'error'))
                          .finally(() => setHandoffBusy(false))
                      }}
                    >
                      {handoffBusy ? '接力中…' : `⇄ 接力给${isCodex ? ' Claude' : ' Codex'}`}
                    </button>
                  )}
                </PopupPanel>
              </>
            )}
          </div>
          {usageLine && (
            <div className="mt-1 font-mono text-[10px] tracking-wide text-faint/80">{usageLine}</div>
          )}
          {goalOpen && (
            <div className="mt-2 rounded-[14px] bg-surface2/80 p-2.5 backdrop-blur-xl">
              <div className="mb-1.5 flex items-center justify-between">
                <span className="font-mono text-[10px] tracking-wide text-faint">
                  ◎ 会话目标{state.goal ? '（进行中）' : ''}——agent 会持续工作直到条件达成
                </span>
                <button className="font-mono text-[10px] text-faint hover:text-muted" onClick={() => setGoalOpen(false)}>
                  ✕
                </button>
              </div>
              {state.goal && (
                <div className="mb-1.5 font-mono text-[11px] leading-relaxed text-ok">
                  当前：{state.goal.condition}
                  {state.goal.tokensUsed != null && (
                    <span className="text-faint"> · {state.goal.tokensUsed} tok</span>
                  )}
                </div>
              )}
              <div className="flex gap-1.5">
                <input
                  className="min-w-0 flex-1 rounded-full bg-bg/60 px-3 py-1.5 font-mono text-[11px] text-ink outline-none placeholder:text-faint/60"
                  placeholder={isCodex ? '如：迁移完所有调用点并通过测试' : '如：test/auth 全部通过且 lint 干净'}
                  value={goalDraft}
                  onChange={(e) => setGoalDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && goalDraft.trim()) {
                      sendGoal(goalDraft.trim())
                      setGoalOpen(false)
                    }
                  }}
                />
                <button
                  className="shrink-0 rounded-full bg-ink px-3 py-1.5 font-mono text-[11px] text-bg disabled:opacity-40"
                  disabled={!goalDraft.trim()}
                  onClick={() => {
                    if (!goalDraft.trim()) return
                    sendGoal(goalDraft.trim())
                    setGoalOpen(false)
                  }}
                >
                  设定
                </button>
                {state.goal && (
                  <button
                    className="shrink-0 rounded-full px-3 py-1.5 font-mono text-[11px] text-accent hover:bg-accent/10"
                    onClick={() => {
                      sendGoal()
                      setGoalOpen(false)
                    }}
                  >
                    清除
                  </button>
                )}
              </div>
            </div>
          )}
        </div>

        {/* 接力链导航条：仅在当前会话参与血缘时出现 */}
        {lineage && (
          <div className="flex items-center gap-1.5 overflow-x-auto px-3 py-1.5 font-mono text-[10px]">
            <span className="shrink-0 text-faint">⇄ 接力链:</span>
            {lineage.records
              .map((r) => {
                const fromKey = r.fromResolvedKey ?? r.fromKey
                const toKey = r.toResolvedKey ?? r.toKey
                const node = (k: string, backend: 'claude' | 'codex') => {
                  const info = lineage.nodes[k]
                  const current = k === session.key
                  return (
                    <button
                      key={k}
                      disabled={!info}
                      onClick={() => info && props.onNavigate?.(info)}
                      className={`flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 ${
                        current
                          ? 'bg-surface2 text-ink'
                          : 'text-faint hover:text-muted'
                      }`}
                      title={k}
                    >
                      {backend === 'codex' ? <CodexMark size={10} /> : <ClaudeMark className="h-2.5 w-2.5" />}
                      {new Date(r.at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}
                    </button>
                  )
                }
                return (
                  <span key={r.id} className="flex shrink-0 items-center gap-1.5">
                    {node(fromKey, r.fromBackend)}
                    <span className="text-faint/60">→</span>
                    {node(toKey, r.toBackend)}
                  </span>
                )
              })}
          </div>
        )}

        {/* 后台任务 Chips 已并入右侧「后台任务」面板（运行中卡片上有停止按钮） */}

        {/* 会话详情抽屉 */}
        {detailOpen && (
          <div className="px-3 py-2">
            <div className="mb-1.5 flex items-center gap-2 font-mono text-[11px]">
              <span className="text-muted">{detailTitle}</span>
              {/* codex 只有 mcp_status 有对应物（mcpServerStatus/list）；context/设置是 claude 控制请求 */}
              {(isCodex ? (['mcp_status'] as const) : (['get_context_usage', 'mcp_status', 'get_settings'] as const)).map((q) => (
                <button
                  key={q}
                  className="rounded-full bg-surface px-2.5 py-1 text-[10px] text-faint hover:text-ink"
                  onClick={() =>
                    runQuery(q, q === 'get_context_usage' ? 'context 用量' : q === 'mcp_status' ? 'MCP 状态' : '设置')
                  }
                >
                  {q === 'get_context_usage' ? 'context' : q === 'mcp_status' ? 'MCP' : '设置'}
                </button>
              ))}
              <button className="ml-auto text-faint hover:text-muted" onClick={() => setDetailOpen(false)}>
                ✕
              </button>
            </div>
            {detailTitle === 'MCP 状态' && !isCodex && mcpServers ? (
              /* claude MCP 管理面板：状态 + 重连/启停（toggle 持久化到 settings，与 TUI 同语义） */
              <div className="max-h-56 overflow-auto rounded-[14px] bg-surface p-2.5">
                {mcpServers.length === 0 && (
                  <div className="py-1 font-mono text-[10px] text-faint">无 MCP 服务器（在 claude 配置里添加后出现）</div>
                )}
                {mcpServers.map((srv) => {
                  const meta =
                    srv.status === 'connected'
                      ? { dot: 'bg-ok', label: '已连接' }
                      : srv.status === 'failed'
                        ? { dot: 'bg-danger', label: '失败' }
                        : srv.status === 'disabled'
                          ? { dot: 'bg-faint', label: '已禁用' }
                          : { dot: 'bg-wait', label: srv.status }
                  const configLine = srv.config?.url
                    ? srv.config.url
                    : srv.config?.command
                      ? `${srv.config.command} ${(srv.config.args ?? []).join(' ')}`.trim()
                      : (srv.config?.type ?? '')
                  const reconnecting = mcpBusy === `${srv.name}:mcp_reconnect`
                  const toggling = mcpBusy === `${srv.name}:mcp_toggle`
                  return (
                    <div key={srv.name} className="flex items-center gap-2 py-1">
                      <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${meta.dot}`} />
                      <div className="min-w-0 flex-1">
                        <div className="font-mono text-[11px] text-ink">
                          {srv.name}
                          <span className="text-faint">
                            {' '}
                            {meta.label}
                            {srv.status === 'connected' && srv.tools ? ` · ${srv.tools.length} 工具` : ''}
                            {srv.scope ? ` · ${srv.scope}` : ''}
                          </span>
                        </div>
                        {configLine && <div className="truncate font-mono text-[10px] text-faint">{configLine}</div>}
                        {srv.error && <div className="truncate font-mono text-[10px] text-danger">{srv.error}</div>}
                      </div>
                      <button
                        className="shrink-0 rounded-full bg-surface2 px-2.5 py-1 font-mono text-[10px] text-faint hover:text-ink disabled:opacity-40"
                        disabled={!!mcpBusy || srv.status === 'disabled'}
                        title="重新连接（mcp_reconnect）"
                        onClick={() => mcpAction(srv.name, 'mcp_reconnect')}
                      >
                        {reconnecting ? '…' : '重连'}
                      </button>
                      <button
                        className="shrink-0 rounded-full bg-surface2 px-2.5 py-1 font-mono text-[10px] text-faint hover:text-ink disabled:opacity-40"
                        disabled={!!mcpBusy}
                        title={srv.status === 'disabled' ? '启用并连接（写入 settings）' : '禁用并断开（写入 settings）'}
                        onClick={() => mcpAction(srv.name, 'mcp_toggle', srv.status === 'disabled')}
                      >
                        {toggling ? '…' : srv.status === 'disabled' ? '启用' : '禁用'}
                      </button>
                    </div>
                  )
                })}
              </div>
            ) : detailTitle === 'context 用量' && !isCodex && contextData ? (
              /* claude context 结构化：总量条 + 分类占比（deferred 类别淡显） */
              <div className="max-h-56 overflow-auto rounded-[14px] bg-surface p-2.5">
                <div className="mb-1.5 flex items-baseline justify-between font-mono text-[11px] text-ink">
                  <span>
                    {fmtTokens(contextData.totalTokens)} / {fmtTokens(contextData.maxTokens)} tok ·{' '}
                    {contextData.percentage.toFixed(1)}%
                  </span>
                  {contextData.model && (
                    <span className="text-[10px] text-faint">
                      {modelNames?.[contextData.model]?.name ?? contextData.model}
                    </span>
                  )}
                </div>
                <div className="mb-2 h-1 overflow-hidden rounded-full bg-surface2">
                  <div
                    className="h-full bg-ink/60"
                    style={{ width: `${Math.min(100, contextData.percentage)}%` }}
                  />
                </div>
                {contextData.categories.map((c) => (
                  <div key={c.name} className={`flex items-center gap-2 py-0.5 ${c.isDeferred ? 'opacity-50' : ''}`}>
                    <span className="w-28 shrink-0 truncate font-mono text-[10px] text-muted" title={c.name}>
                      {c.name}
                    </span>
                    <div className="h-1 flex-1 overflow-hidden rounded-full bg-surface2">
                      <div
                        className={`h-full ${c.isDeferred ? 'bg-faint' : 'bg-muted'}`}
                        style={{
                          width: `${Math.min(100, (c.tokens / Math.max(1, contextData.maxTokens)) * 100)}%`,
                        }}
                      />
                    </div>
                    <span className="w-12 shrink-0 text-right font-mono text-[10px] text-faint">
                      {fmtTokens(c.tokens)}
                    </span>
                  </div>
                ))}
              </div>
            ) : detailTitle === '设置' && !isCodex && settingsData ? (
              /* claude 设置轻结构：生效值 + 来源概览；全量设置不枚举，原始 JSON 折叠兜底 */
              <div className="max-h-56 overflow-auto rounded-[14px] bg-surface p-2.5">
                {settingsData.applied && (
                  <div className="mb-1.5 font-mono text-[11px] text-ink">
                    当前生效：
                    <span className="text-muted">
                      {modelNames?.[settingsData.applied.model ?? '']?.name ?? settingsData.applied.model ?? 'default'}
                    </span>
                    <span className="text-faint"> · effort {settingsData.applied.effort ?? '默认'}</span>
                  </div>
                )}
                {(settingsData.sources ?? []).map((s) => (
                  <div key={s.source} className="flex items-center gap-2 py-0.5 font-mono text-[10px]">
                    <span className="text-muted">{s.source}</span>
                    <span className="text-faint">{Object.keys(s.settings ?? {}).length} 项</span>
                  </div>
                ))}
                <details className="mt-1.5">
                  <summary className="cursor-pointer font-mono text-[10px] text-faint hover:text-muted">
                    原始 JSON
                  </summary>
                  <pre className="mt-1 max-h-40 overflow-auto rounded-[10px] bg-bg/60 p-2 font-mono text-[10px] whitespace-pre-wrap text-muted">
                    {detailContent}
                  </pre>
                </details>
              </div>
            ) : (
              <pre className="max-h-56 overflow-auto rounded-[14px] bg-surface p-2.5 font-mono text-[10px] whitespace-pre-wrap text-muted">
                {detailContent}
              </pre>
            )}
          </div>
        )}
      </div>

      {showRewind && (
        <RewindPicker
          targets={rewindTargets}
          mode={isCodex ? 'codex' : 'claude'}
          onClose={() => setShowRewind(false)}
          onRewindFiles={(uuid) => {
            sockRef.current?.send({ kind: 'control', subtype: 'rewind_files', extra: { user_message_id: uuid } })
            pushSystem('↩ 已请求回滚文件')
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
      <div className="absolute inset-x-0 bottom-0 z-30 px-3 pb-3 pt-2">
        <div className="mx-auto max-w-3xl">
          {slashHints.length > 0 && (
            <div className="mb-2 rounded-[14px] bg-surface2/85 p-1 shadow-[0_16px_40px_-12px_rgba(0,0,0,0.5)] backdrop-blur-xl">
              {/* 完整清单可滚动（CLI initialize 握手报告多少就列多少），自有命令置顶；键盘导航时高亮行跟随滚动 */}
              <div ref={slashScrollRef} className="max-h-60 overflow-y-auto">
                {slashHints.map((c, i) => (
                  <button
                    key={c.name}
                    className={`flex w-full items-center gap-2 rounded-[10px] px-2.5 py-1.5 text-left ${
                      i === slashActive ? 'bg-surface' : 'hover:bg-surface'
                    }`}
                    onMouseEnter={() => setSlashIdx(i)}
                    onClick={() => {
                      setInput(`/${c.name} `)
                      setSlashIdx(0)
                      inputRef.current?.focus()
                    }}
                  >
                    <span className="font-mono text-[12px] text-ink">/{c.name}</span>
                    {c.desc && <span className="truncate text-xs text-faint">{c.desc}</span>}
                  </button>
                ))}
              </div>
              <div className="px-2.5 py-1 font-mono text-[9px] tracking-wide text-faint">
                {slashHints.length} 个命令 · ↑↓ 移动 · Tab 补全
                {input.trim() === '/' && ' · 继续输入可过滤'}
              </div>
            </div>
          )}
          <div className="relative">
            {/* ↓ 与输入块同列、贴在正上方；不放进磨砂块内，否则 backdrop 只能糊到父级内部 */}
            {!atBottom && (
              <button
                className="absolute bottom-full right-0 z-40 mb-2 grid h-9 w-9 place-items-center rounded-full bg-surface2/85 text-ink shadow-lg backdrop-blur-xl hover:bg-surface2"
                onClick={() => scrollToBottom(false)}
                title="回到底部"
                aria-label="回到底部"
              >
                ↓
              </button>
            )}
            <div className="rounded-[14px] bg-surface2/80 px-3 pb-2 pt-2.5 shadow-[0_16px_40px_-12px_rgba(0,0,0,0.5)] backdrop-blur-xl">
            {/* busy 时发送方式：插队（steer，下一边界被模型看到）/ 排队（queue，当前轮结束后） */}
            {busy && (
              <div className="mb-1.5 flex items-center gap-1.5 font-mono text-[10px]">
                <span className="text-faint">工作中，发送：</span>
                {(['steer', 'queue'] as const).map((m) => (
                  <button
                    key={m}
                    className={`rounded-full px-2.5 py-0.5 ${
                      sendMode === m ? 'bg-surface text-ink' : 'text-faint hover:text-muted'
                    }`}
                    onClick={() => setSendMode(m)}
                  >
                    {m === 'steer' ? '插队' : '排队'}
                  </button>
                ))}
                <span className="text-faint/70">
                  {sendMode === 'steer'
                    ? isCodex
                      ? '追加进当前轮'
                      : '打断当前并立即处理'
                    : '当前轮结束后自动开始'}
                </span>
              </div>
            )}
            {/* 待发送图片预览 */}
            {pendingImages.length > 0 && (
              <div className="mb-2 flex flex-wrap gap-2">
                {pendingImages.map((img, i) => (
                  <span key={i} className="relative">
                    <img src={imgPreviewSrc(img)} alt={img.name} className="h-14 w-14 rounded-[10px] object-cover" />
                    <button
                      className="absolute -right-1.5 -top-1.5 grid h-4 w-4 place-items-center rounded-full bg-accent text-[9px] leading-none text-white"
                      onClick={() => setPendingImages((prev) => prev.filter((_, j) => j !== i))}
                    >
                      ✕
                    </button>
                  </span>
                ))}
              </div>
            )}
            <input
              ref={fileInputRef}
              type="file"
              accept="image/jpeg,image/png,image/gif,image/webp"
              multiple
              className="hidden"
              onChange={(e) => {
                pickImages(e.target.files)
                e.target.value = ''
              }}
            />
            <textarea
              ref={inputRef}
              className="max-h-[200px] min-h-[1.5rem] w-full resize-none overflow-hidden bg-transparent px-1 text-[15px] leading-snug text-ink outline-none placeholder:text-faint"
              rows={1}
              placeholder={busy ? '工作中…' : 'ᕕ( ◠ڼ◠ )ᕗ'}
              value={input}
              onChange={(e) => {
                setInput(e.target.value)
                setSlashIdx(0)
              }}
              onKeyDown={(e) => {
                // 斜杠命令面板打开时的键盘导航
                if (slashHints.length > 0) {
                  if (e.key === 'ArrowDown') {
                    e.preventDefault()
                    setSlashIdx((i) => Math.min(i + 1, slashHints.length - 1))
                    return
                  }
                  if (e.key === 'ArrowUp') {
                    e.preventDefault()
                    setSlashIdx((i) => Math.max(i - 1, 0))
                    return
                  }
                  if (e.key === 'Tab') {
                    e.preventDefault()
                    setInput(`/${slashHints[slashActive].name} `)
                    setSlashIdx(0)
                    return
                  }
                  if (e.key === 'Escape') {
                    e.preventDefault()
                    setInput('')
                    setSlashIdx(0)
                    return
                  }
                }
                if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault()
                  // 输入还是高亮命令的真前缀时先补全不发送；完整命令名（如 /compact）才直接发送
                  const trimmed = input.trim()
                  const active = slashHints[slashActive]
                  if (slashHints.length > 0 && active && `/${active.name}` !== trimmed) {
                    setInput(`/${active.name} `)
                    setSlashIdx(0)
                    return
                  }
                  send()
                }
              }}
            />
            <div className="mt-1 flex min-w-0 items-center gap-1.5">
              <div className="min-w-0 flex-1">
              {cfg && !isCodex && (
                <StatusPill
                  cfg={cfg}
                  model={initInfo.model}
                  permissionMode={permMode}
                  effort={effort}
                  modelNames={modelNames}
                  onPanelOpen={loadModelNames}
                  onSetModel={(m) => {
                    setInitInfo((prev) => ({ ...prev, model: m }))
                    sockRef.current?.send({ kind: 'control', subtype: 'set_model', extra: { model: m } })
                  }}
                  onSetMode={handleSetMode}
                  onSetEffort={handleSetEffort}
                />
              )}
              {isCodex && codexModels && codexModels.length > 0 && (
                <StatusPill
                  cfg={codexCfg}
                  model={codexModelId}
                  permissionMode={codexModeOf(permMode ?? state.permissionMode)}
                  effort={effort ?? state.effort ?? codexCurrentModel?.defaultEffort}
                  effortLevels={codexEffortLevels}
                  onSetModel={(m) => {
                    sockRef.current?.send({ kind: 'control', subtype: 'set_model', extra: { model: m } })
                  }}
                  onSetMode={handleSetMode}
                  onSetEffort={handleSetEffort}
                />
              )}
              </div>
              {/* 上下文窗口占用环：首个 API 应答/首个 turn 前（state.context 缺省）不渲染 */}
              <ContextRing
                backend={isCodex ? 'codex' : 'claude'}
                context={state.context}
                usage={state.usage}
                modelLabel={
                  isCodex
                    ? (codexCurrentModel?.label ?? codexModelId)
                    : (modelNames?.[initInfo.model ?? '']?.name ?? initInfo.model)
                }
                onOpenFullDetail={
                  !isCodex && isExisting
                    ? () => {
                        setDetailOpen(true)
                        runQuery('get_context_usage', 'context 用量')
                      }
                    : undefined
                }
              />
              <button
                type="button"
                className="grid h-8 w-8 shrink-0 place-items-center rounded-full text-muted transition-colors hover:bg-surface hover:text-ink"
                title="添加图片（jpg/png/gif/webp，≤5MB）"
                aria-label="添加图片"
                onClick={() => fileInputRef.current?.click()}
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4" aria-hidden="true">
                  <rect x="3" y="3" width="18" height="18" rx="2" />
                  <circle cx="8.5" cy="8.5" r="1.5" />
                  <path d="m21 15-5-5L5 21" />
                </svg>
              </button>
              {busy ? (
                <button
                  type="button"
                  className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-accent text-white transition-opacity hover:opacity-85"
                  onClick={() => sockRef.current?.send({ kind: 'control', subtype: 'interrupt' })}
                  title="中断当前回合"
                  aria-label="中断当前回合"
                >
                  <svg viewBox="0 0 24 24" fill="currentColor" className="h-4 w-4" aria-hidden="true">
                    <rect x="5" y="5" width="14" height="14" rx="3" />
                  </svg>
                </button>
              ) : (
                <button
                  type="button"
                  className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-ink text-bg transition-opacity hover:opacity-85 disabled:pointer-events-none disabled:opacity-25"
                  disabled={(!input.trim() && pendingImages.length === 0) || !connected}
                  onClick={send}
                  title="发送"
                  aria-label="发送"
                >
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4" aria-hidden="true">
                    <path d="M12 19V5" />
                    <path d="m5 12 7-7 7 7" />
                  </svg>
                </button>
              )}
            </div>
            </div>
          </div>
        </div>
      </div>
      </div>
      <TasksPanel
        open={tasksOpen}
        onClose={() => setTasksOpen(false)}
        tasks={tasks}
        onStop={(taskId) => sockRef.current?.send({ kind: 'control', subtype: 'stop_task', extra: { task_id: taskId } })}
      />
    </div>
  )
}
