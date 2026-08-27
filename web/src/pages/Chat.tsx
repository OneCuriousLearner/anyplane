import { useEffect, useMemo, useRef, useState } from 'react'
import { createSession, fetchCodexHistory, fetchCodexModels, fetchConfig, fetchHistory, fetchLineage, startHandoff, type CodexModelInfo, type HistoryMessage, type HistoryResponse, type LineageResponse, type ServerConfigInfo, type SessionInfo } from '../lib/api'
import { SessionSocket, type CliMsg, type ServerEvent, type SessionState } from '../lib/ws'
import { StatusPill, GLASS_BAR } from '../components/StatusPill'
import { ApprovalCard } from '../components/ApprovalCard'
import { RewindPicker } from '../components/RewindPicker'
import { MessageView } from '../components/MessageView'
import { Markdown } from '../components/Markdown'
import { ClaudeMark } from '../components/ClaudeMark'
import { ClaudeStar } from '../components/ClaudeStar'
import { CodexMark } from '../components/CodexMark'
import { PopupPanel } from '../components/PopupPanel'
import { nextId, rewindPreview, toolResultText, type Block, type ChatMsg } from '../lib/blocks'
import { isCodexKey, isExistingKey } from '../lib/key'
import { COMMAND_DESC, filterSlashHints, mergeSlashCommands, type SlashEntry } from '../lib/slashCommands'

const MORE_ITEM =
  'flex w-full items-center gap-2 rounded-md px-3 py-2 text-left font-mono text-[12px] text-muted transition-colors hover:bg-surface2/60 hover:text-ink'

interface Approval {
  requestId: string
  toolName: string
  input: unknown
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
  const [goalOpen, setGoalOpen] = useState(false)
  const [goalDraft, setGoalDraft] = useState('')
  const [moreOpen, setMoreOpen] = useState(false)
  const moreBtnRef = useRef<HTMLButtonElement>(null)
  const querySeq = useRef(0)
  const sockRef = useRef<SessionSocket | undefined>(undefined)
  const bottomRef = useRef<HTMLDivElement>(null)
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
      .then((r) => setLineage(r.records.length > 0 ? r : undefined))
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
      // sidechain（子代理内部消息）不进主抄本
      if (rec.parent_tool_use_id) return
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
      if (msg.isMeta || rec.parent_tool_use_id) return
      const content = msg.message?.content
      const blocks = Array.isArray(content) ? content : typeof content === 'string' ? [{ type: 'text', text: content }] : []
      const textBlocks: Block[] = []
      for (const c of blocks) {
        if (c?.type === 'tool_result') {
          pairToolResult(c.tool_use_id, toolResultText(c.content), c.is_error === true)
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
        case 'task_started':
          pushSystem(`⚙ 子代理启动：${String(rec.description ?? '')}`)
          break
        case 'task_notification': {
          const summary = typeof rec.summary === 'string' ? rec.summary : ''
          pushSystem(`⚙ 子代理完成${summary ? `：${summary.slice(0, 200)}` : ''}`)
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
            // 进程已退出时固化/清理未完成的流式草稿，避免半截内容悬挂
            if (ev.state.exited) {
              commitDraft()
              setPhase(undefined)
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
              props.onNavigate?.({
                key: ev.targetKey,
                slug: session.slug,
                sessionId: ev.branchOf,
                cwd: session.cwd,
                backend: 'claude',
                mtime: Date.now(),
                sizeBytes: 0,
                status: 'idle',
                managed: { spawned: false, busy: false, clients: 0 },
              })
              break
            }
            // codex 分叉回滚完成：原线程不动，跳到携带截断历史的新线程
            pushSystem('⎇ 已分叉：新会话携带所选消息之前的历史，原会话保持不动')
            setShowRewind(false)
            props.onNavigate?.({
              key: ev.targetKey,
              slug: 'codex',
              // codex 分叉路径服务端始终携带 targetSessionId（branchOf 不存在时）
              sessionId: ev.targetSessionId ?? '',
              cwd: session.cwd,
              backend: 'codex',
              mtime: Date.now(),
              sizeBytes: 0,
              status: 'idle',
              managed: { spawned: true, busy: false, clients: 0 },
            })
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
            props.onNavigate?.({
              key: ev.targetKey,
              slug: ev.toBackend === 'codex' ? 'codex' : session.slug,
              sessionId: 'new',
              cwd: session.cwd,
              backend: ev.toBackend,
              mtime: Date.now(),
              sizeBytes: 0,
              status: 'busy',
              managed: { spawned: true, busy: true, clients: 0 },
            })
            break
          }
          case 'handoff_error':
            pushSystem(`⚠ 接力失败: ${ev.message}`, 'error')
            break
          case 'query_result':
            setDetailContent(
              ev.ok
                ? JSON.stringify(ev.data, null, 2).slice(0, 8000)
                : `⚠ ${ev.error ?? '查询失败'}`,
            )
            break
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
            break
          }
          case 'moved': {
            // /clear 对话重置：进程已换新 sessionId 续跑，Hub 重键完毕——跳到新会话页
            //（旧 transcript 在磁盘原样保留，列表页可见）
            const parts = ev.targetKey.split('|')
            props.onNavigate?.({
              key: ev.targetKey,
              slug: parts[1] ?? session.slug,
              sessionId: ev.targetSessionId ?? 'new',
              cwd: session.cwd,
              backend: 'claude',
              mtime: Date.now(),
              sizeBytes: 0,
              status: 'idle',
              managed: { spawned: true, busy: false, clients: 0 },
            })
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
  const setGoal = (condition: string) => {
    if (isCodex) {
      sockRef.current?.send({ kind: 'control', subtype: 'set_goal', extra: { objective: condition } })
    } else {
      sockRef.current?.send({ kind: 'user', text: `/goal ${condition}` })
    }
    pushSystem(`◎ 已设定目标：${condition}`)
  }
  const clearGoal = () => {
    if (isCodex) {
      sockRef.current?.send({ kind: 'control', subtype: 'clear_goal' })
    } else {
      sockRef.current?.send({ kind: 'user', text: '/goal clear' })
    }
    pushSystem('◎ 已清除目标')
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
    if (text === '/rewind') {
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
    // /rewind 的官方别名
    if (text === '/checkpoint' || text === '/undo') {
      setShowRewind(true)
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
      else if (/^(clear|stop|off|reset|none|cancel)$/i.test(arg)) clearGoal()
      else setGoal(arg)
      setInput('')
      return
    }
    if (isCodex && /^\/review(\s|$)/.test(text)) {
      // codex review/start：无参审未提交改动，带参按自定义说明审（inline 在本线程跑）
      const instructions = text.slice(7).trim()
      sockRef.current.send({ kind: 'control', subtype: 'review', ...(instructions ? { extra: { instructions } } : {}) })
      pushSystem(instructions ? `🔍 审查中：${instructions}` : '🔍 审查未提交的改动中…')
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
          props.onNavigate?.({
            key,
            slug: 'codex',
            sessionId: 'new',
            cwd,
            backend: 'codex',
            mtime: Date.now(),
            sizeBytes: 0,
            status: 'offline',
            managed: { spawned: false, busy: false, clients: 0 },
          }),
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
  // cc-remote 自有命令置顶（中文描述优先于 CLI 同名命令），其后是 CLI 报告的完整清单
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
  const fmtTok = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n))
  const u = state.usage
  const usageLine =
    u && u.inputTokens + u.outputTokens > 0
      ? `tok ↑${fmtTok(u.inputTokens)} ↓${fmtTok(u.outputTokens)}` +
        (u.cacheReadTokens ? ` · cache ${fmtTok(u.cacheReadTokens)}` : '') +
        (u.reasoningTokens ? ` · rs ${fmtTok(u.reasoningTokens)}` : '')
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
    <div className="relative h-full overflow-clip bg-bg text-ink">
      {/* 消息抄本：占满整个视口，上下各留 ~100px 空区避让悬浮栏 */}
      <div ref={scrollRef} onScroll={onScroll} className="h-full overflow-y-auto">
        <div className="mx-auto max-w-3xl px-3 pb-[100px] pt-[120px] md:px-6">
          {messages.map((m, i) => (
            <MessageView
              key={m.id}
              msg={m}
              compact={m.role !== 'system' && messages[i - 1]?.role === m.role}
            />
          ))}

          {/* 流式草稿：移除 message 级 Claude 图标，按块分行；thinking/tool 块左栏圆点 */}
          {draft && draft.blocks.length > 0 && (
            <div className="my-3 flex flex-col">
              {draft.blocks.map((b) => {
                const dot = b.kind === 'thinking' || b.kind === 'tool'
                return (
                  <div key={b.idx} className="flex items-start gap-2.5">
                    <span
                      className={`flex w-5 shrink-0 justify-center select-none ${dot ? 'pt-[17px]' : ''}`}
                      aria-hidden="true"
                    >
                      {dot && <span className="block h-1.5 w-1.5 rounded-full bg-zinc-400/70" />}
                    </span>
                    <div className="min-w-0 flex-1">
                      {b.kind === 'tool' ? (
                        <div className="my-1.5 rounded-md border border-line bg-surface2/40 px-2.5 py-1.5 font-mono text-[12px]">
                          <span className="text-accent-soft">{b.name ?? '…'}</span>
                          <span className="ml-2 animate-pulse text-busy">…</span>
                        </div>
                      ) : b.kind === 'thinking' ? (
                        <div className="my-1.5 rounded-md border border-line/60 bg-surface2/30 px-2.5 py-1.5">
                          <span className="font-mono text-[11px] tracking-wide text-faint">思考</span>
                          <span className="ml-1 animate-pulse font-mono text-[11px] text-busy">进行中…</span>
                          {b.text && (
                            <div className="mt-1 max-h-48 overflow-y-auto text-[13px] leading-relaxed whitespace-pre-wrap text-muted">
                              {b.text}
                            </div>
                          )}
                        </div>
                      ) : (
                        <div className="relative">
                          <Markdown text={b.text} />
                          <span className="cc-cursor ml-0.5 inline-block h-3.5 w-[7px] bg-accent-soft align-text-bottom" />
                        </div>
                      )}
                    </div>
                  </div>
                )
              })}
              {draft.blocks.every((b) => b.kind !== 'text') && (
                <div className="flex items-start gap-2.5">
                  <span className="flex w-5 shrink-0" aria-hidden="true" />
                  <div className="min-w-0 flex-1">
                    <span className="cc-cursor inline-block h-3.5 w-[7px] bg-accent-soft" />
                  </div>
                </div>
              )}
            </div>
          )}

          {busy && !draft && <div className="my-2 animate-pulse pl-7 font-mono text-[11px] text-faint">✳ 生成中…</div>}

          {approvals.map((a) => (
            <ApprovalCard
              key={a.requestId}
              approval={a}
              onDecision={(decision) => sockRef.current?.send({ kind: 'approval', requestId: a.requestId, decision })}
            />
          ))}

          {/* 底部 100px 空位上方：后端徽标（忙碌旋转 / 空闲可点彩蛋） */}
          <div className="mt-4 ml-[30px] flex items-center gap-2.5">
            {isCodex ? (
              <CodexMark active={busy || Boolean(draft) || Boolean(phase)} size={28} />
            ) : (
              <ClaudeStar active={busy || Boolean(draft) || Boolean(phase)} size={28} />
            )}
          </div>
          <div ref={bottomRef} />
        </div>
      </div>

      {/* 顶栏 + 状态胶囊：同一块悬浮毛玻璃，避免两段玻璃割裂 */}
      <div className={`absolute inset-x-0 top-0 z-30 border-b border-line ${GLASS_BAR}`}>
        <div className="border-b border-line/60 px-3 py-2">
          <div className="flex items-center gap-2">
            <button
              className="rounded px-1.5 py-1 font-mono text-xs text-muted hover:bg-surface2 md:hidden"
              onClick={props.onBack}
            >
              ← 列表
            </button>
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-medium">{session.title ?? session.cwd ?? session.sessionId}</div>
              <div className="flex items-center gap-2 font-mono text-[10px] tracking-wide text-faint">
                <span className={connected ? 'text-ok' : 'text-danger'}>{connected ? '●' : '○'}</span>
                <span className={busy || phase ? 'animate-pulse text-busy' : ''}>{statusLine}</span>
              </div>
            </div>
            {(isExisting || !isCodex || state.sessionId) && (
              <>
                <button
                  ref={moreBtnRef}
                  type="button"
                  className={`relative flex h-7 w-7 shrink-0 items-center justify-center rounded border text-faint hover:text-muted ${
                    moreOpen ? 'border-accent/50 text-ink' : 'border-line'
                  }`}
                  title="更多"
                  aria-label="更多"
                  aria-haspopup="menu"
                  aria-expanded={moreOpen}
                  onClick={() => setMoreOpen((v) => !v)}
                >
                  <svg
                    viewBox="0 0 16 16"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.4"
                    strokeLinecap="round"
                    className="h-3.5 w-3.5"
                    aria-hidden
                  >
                    <path d="M2.5 4.25h11" />
                    <path d="M2.5 8h11" />
                    <path d="M2.5 11.75h11" />
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
                      详情
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
                      className={`${MORE_ITEM} text-accent-soft hover:text-accent-soft disabled:opacity-40`}
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
            <div className="mt-2 rounded border border-line bg-surface2/80 p-2">
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
                  className="min-w-0 flex-1 rounded border border-line bg-bg px-2 py-1 font-mono text-[11px] text-ink placeholder:text-faint/60"
                  placeholder={isCodex ? '如：迁移完所有调用点并通过测试' : '如：test/auth 全部通过且 lint 干净'}
                  value={goalDraft}
                  onChange={(e) => setGoalDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && goalDraft.trim()) {
                      setGoal(goalDraft.trim())
                      setGoalOpen(false)
                    }
                  }}
                />
                <button
                  className="shrink-0 rounded border border-ok/60 px-2 py-1 font-mono text-[11px] text-ok disabled:opacity-40"
                  disabled={!goalDraft.trim()}
                  onClick={() => {
                    if (!goalDraft.trim()) return
                    setGoal(goalDraft.trim())
                    setGoalOpen(false)
                  }}
                >
                  设定
                </button>
                {state.goal && (
                  <button
                    className="shrink-0 rounded border border-danger/60 px-2 py-1 font-mono text-[11px] text-danger"
                    onClick={() => {
                      clearGoal()
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

        {cfg && !isCodex && (
          <StatusPill
            cfg={cfg}
            model={initInfo.model}
            permissionMode={permMode}
            effort={effort}
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

        {/* 接力链导航条：仅在当前会话参与血缘时出现 */}
        {lineage && (
          <div className="flex items-center gap-1.5 overflow-x-auto border-t border-line/60 px-3 py-1.5 font-mono text-[10px]">
            <span className="shrink-0 text-faint">⇄ 接力链:</span>
            {lineage.records
              .slice()
              .sort((a, b) => a.at.localeCompare(b.at))
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
                      className={`flex shrink-0 items-center gap-1 rounded border px-1.5 py-0.5 ${
                        current
                          ? 'border-accent/60 bg-accent/15 text-accent-soft'
                          : 'border-line text-faint hover:text-muted'
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

        {/* 后台任务芯片：task_started → task_notification 之间的活动任务，可手动停止 */}
        {(state.activeTasks?.length ?? 0) > 0 && (
          <div className="flex flex-wrap gap-1.5 px-3 py-1.5">
            {state.activeTasks!.map((t) => (
              <span
                key={t.id}
                className="flex items-center gap-1.5 rounded border border-busy/40 bg-busy/10 px-2 py-0.5 font-mono text-[10px] text-busy"
                title={t.summary ?? t.description}
              >
                <span className="animate-pulse">●</span>
                <span className="max-w-48 truncate">{t.description || t.id}</span>
                {t.lastToolName && <span className="text-faint">· {t.lastToolName}</span>}
                <button
                  className="ml-0.5 text-danger hover:font-bold"
                  title="停止该后台任务"
                  onClick={() => sockRef.current?.send({ kind: 'control', subtype: 'stop_task', extra: { task_id: t.id } })}
                >
                  ✕
                </button>
              </span>
            ))}
          </div>
        )}

        {/* 会话详情抽屉 */}
        {detailOpen && (
          <div className="border-t border-line/60 px-3 py-2">
            <div className="mb-1.5 flex items-center gap-2 font-mono text-[11px]">
              <span className="text-muted">{detailTitle}</span>
              {/* codex 只有 mcp_status 有对应物（mcpServerStatus/list）；context/设置是 claude 控制请求 */}
              {(isCodex ? (['mcp_status'] as const) : (['get_context_usage', 'mcp_status', 'get_settings'] as const)).map((q) => (
                <button
                  key={q}
                  className="rounded border border-line px-1.5 py-0.5 text-[10px] text-faint hover:text-muted"
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
            <pre className="max-h-56 overflow-auto rounded bg-bg/60 p-2 font-mono text-[10px] whitespace-pre-wrap text-muted">
              {detailContent}
            </pre>
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

      {/* ↓ 必须与毛玻璃底栏同级：挂在带 backdrop-filter 的父级下时，子级只能模糊父级内部，看不到消息区 */}
      {!atBottom && (
        <button
          className="absolute bottom-20 right-4 z-40 rounded-md border border-line bg-bg/55 px-2.5 py-1.5 font-mono text-sm text-ink shadow-lg shadow-black/40 backdrop-blur-md hover:bg-bg/70"
          onClick={() => scrollToBottom(false)}
          title="回到底部"
        >
          ↓
        </button>
      )}

      {/* 输入区：Claude Code 式双横线提示符；底部下沉 8px 出视口 */}
      <div className={`absolute inset-x-0 -bottom-2 z-30 px-3 pb-5 pt-3 ${GLASS_BAR}`}>
        <div className="mx-auto max-w-3xl">
          {slashHints.length > 0 && (
            <div className="mb-2 rounded border border-line bg-surface2/60 p-1">
              {/* 完整清单可滚动（CLI initialize 握手报告多少就列多少），自有命令置顶；键盘导航时高亮行跟随滚动 */}
              <div ref={slashScrollRef} className="max-h-60 overflow-y-auto">
                {slashHints.map((c, i) => (
                  <button
                    key={c.name}
                    className={`flex w-full items-center gap-2 rounded px-2 py-1.5 text-left ${
                      i === slashActive ? 'bg-surface2' : 'hover:bg-surface2'
                    }`}
                    onMouseEnter={() => setSlashIdx(i)}
                    onClick={() => {
                      setInput(`/${c.name} `)
                      setSlashIdx(0)
                      inputRef.current?.focus()
                    }}
                  >
                    <span className="font-mono text-[12px] text-accent-soft">/{c.name}</span>
                    {c.desc && <span className="truncate text-xs text-faint">{c.desc}</span>}
                  </button>
                ))}
              </div>
              <div className="border-t border-line/60 px-2 py-1 font-mono text-[9px] tracking-wide text-faint">
                {slashHints.length} 个命令 · ↑↓ 移动 · Tab 补全
                {input.trim() === '/' && ' · 继续输入可过滤'}
              </div>
            </div>
          )}
          {/* busy 时发送方式：插队（steer，下一边界被模型看到）/ 排队（queue，当前轮结束后） */}
          {busy && (
            <div className="mb-1.5 flex items-center gap-1.5 font-mono text-[10px]">
              <span className="text-faint">工作中，发送：</span>
              {(['steer', 'queue'] as const).map((m) => (
                <button
                  key={m}
                  className={`rounded border px-1.5 py-0.5 ${
                    sendMode === m ? 'border-accent/60 bg-accent/15 text-accent-soft' : 'border-line text-faint hover:text-muted'
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
            <div className="mb-1.5 flex flex-wrap gap-2">
              {pendingImages.map((img, i) => (
                <span key={i} className="relative">
                  <img src={imgPreviewSrc(img)} alt={img.name} className="h-14 w-14 rounded border border-line object-cover" />
                  <button
                    className="absolute -right-1.5 -top-1.5 rounded-full bg-danger px-1 text-[10px] leading-4 text-white"
                    onClick={() => setPendingImages((prev) => prev.filter((_, j) => j !== i))}
                  >
                    ✕
                  </button>
                </span>
              ))}
            </div>
          )}
          <div
            className={`flex items-start gap-2 border-y px-1 py-2 transition-colors ${
              busy ? 'border-busy/50' : 'border-line focus-within:border-accent/50'
            }`}
          >
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
            <button
              type="button"
              className="mt-[1px] shrink-0 self-start text-faint transition-colors hover:text-accent-soft"
              title="添加图片（jpg/png/gif/webp，≤5MB）"
              aria-label="添加图片"
              onClick={() => fileInputRef.current?.click()}
            >
              <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none" aria-hidden="true">
                <rect x="1.25" y="2.25" width="13.5" height="11.5" rx="1.5" stroke="currentColor" strokeWidth="1.25" />
                <circle cx="5.25" cy="6" r="1.15" fill="currentColor" />
                <path d="M1.5 12.25 6 8.25l2.4 2.1 2.1-1.7 4 3.6" stroke="currentColor" strokeWidth="1.25" strokeLinejoin="round" />
              </svg>
            </button>
            <div className="flex min-w-0 flex-1 items-start gap-2">
              <span
                className={`mt-[1px] shrink-0 select-none font-mono text-sm leading-none ${
                  busy ? 'text-busy' : 'text-accent-soft'
                }`}
                aria-hidden="true"
              >
                ❯
              </span>
              <textarea
                ref={inputRef}
                className="max-h-[200px] min-h-[1.25rem] flex-1 resize-none overflow-hidden bg-transparent py-0 font-mono text-sm leading-snug text-ink outline-none placeholder:text-faint"
                rows={1}
                placeholder={busy ? '工作中…' : ''}
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
              {busy ? (
                <button
                  type="button"
                  className="mt-[1px] shrink-0 self-start font-mono text-sm leading-none text-danger transition-opacity hover:text-danger/80"
                  onClick={() => sockRef.current?.send({ kind: 'control', subtype: 'interrupt' })}
                  title="中断当前回合"
                  aria-label="中断当前回合"
                >
                  ■
                </button>
              ) : (
                <button
                  type="button"
                  className="mt-[1px] shrink-0 self-start font-mono text-sm leading-none text-accent-soft transition-opacity hover:text-accent disabled:pointer-events-none disabled:opacity-25"
                  disabled={(!input.trim() && pendingImages.length === 0) || !connected}
                  onClick={send}
                  title="发送"
                  aria-label="发送"
                >
                  ↑
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
