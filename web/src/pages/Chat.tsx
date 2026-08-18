import { useEffect, useMemo, useRef, useState } from 'react'
import { fetchCodexHistory, fetchConfig, fetchHistory, startHandoff, type HistoryMessage, type ServerConfigInfo, type SessionInfo } from '../lib/api'
import { SessionSocket, type CliMsg, type ServerEvent, type SessionState } from '../lib/ws'
import { StatusPill, GLASS_BAR, type Effort } from '../components/StatusPill'
import { ApprovalCard } from '../components/ApprovalCard'
import { RewindPicker } from '../components/RewindPicker'
import { MessageView } from '../components/MessageView'
import { Markdown } from '../components/Markdown'
import { ClaudeMark } from '../components/ClaudeMark'
import { ClaudeStar } from '../components/ClaudeStar'
import { CodexMark } from '../components/CodexMark'
import { nextId, rewindPreview, toolResultText, type Block, type ChatMsg } from '../lib/blocks'

const FALLBACK_COMMANDS = ['compact', 'context', 'rewind', 'btw']
const COMMAND_DESC: Record<string, string> = {
  compact: '压缩上下文',
  context: '查看上下文占用',
  rewind: '回滚到之前的消息',
  btw: '侧问（临时分支会话）',
}

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
 */
function appendHistoryMsg(out: ChatMsg[], h: HistoryMessage): void {
  if (h.isMeta) return
  if (h.role === 'system' && h.subtype === 'compact_boundary') {
    out.push({ id: h.uuid ?? nextId(), role: 'system', systemKind: 'divider', compactMeta: h.compactMeta, blocks: [] })
    return
  }
  const pair = (toolUseId: string | undefined, text: string, isError: boolean): boolean => {
    if (!toolUseId) return false
    for (let mi = out.length - 1; mi >= 0; mi--) {
      const blocks = out[mi].blocks
      for (let bi = blocks.length - 1; bi >= 0; bi--) {
        const b = blocks[bi]
        if (b.kind === 'tool' && b.id === toolUseId) {
          blocks[bi] = { ...b, resultText: text, resultError: isError, pending: false }
          return true
        }
      }
    }
    return false
  }
  const blocks: Block[] = []
  const stray: { text: string; isError: boolean }[] = []
  for (const hb of h.blocks) {
    if (hb.kind === 'tool_use') {
      blocks.push({ kind: 'tool', id: hb.id ?? nextId(), name: hb.name ?? '?', input: hb.input })
    } else if (hb.kind === 'tool_result') {
      if (!pair(hb.id, hb.text ?? '', hb.isError === true)) stray.push({ text: hb.text ?? '', isError: hb.isError === true })
    } else {
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
  const [effort, setEffort] = useState<Effort>()
  const [handoffBusy, setHandoffBusy] = useState(false)
  const [detailOpen, setDetailOpen] = useState(false)
  const [detailTitle, setDetailTitle] = useState('')
  const [detailContent, setDetailContent] = useState('加载中…')
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

  const isCodex = session.key.startsWith('x|') || session.key.startsWith('xn|')
  const isExisting = session.key.startsWith('s|') || session.key.startsWith('x|')

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
        historyOffsetRef.current = resp.fileBytes
        const out: ChatMsg[] = []
        for (const h of resp.messages) appendHistoryMsg(out, h)
        setMsgs(() => out)
        // 从历史读取位置续订 transcript 追加（外部会话的实时更新）；socket 未 open 时会排队
        // codex 的实时流走 app-server 订阅（attach 即 resume），无 tailer
        if (!isCodex) sockRef.current?.send({ kind: 'tail_subscribe', from: resp.fileBytes })
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
            if (typeof ev.state.effort === 'string') setEffort(ev.state.effort as Effort)
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
          case 'tail_reset': {
            // 外部会话截断了 transcript（rewind / clear）：重载历史并用新偏移重新订阅
            setDraftBoth(null)
            pendingResultsRef.current.clear()
            fetchHistory(session.slug, session.sessionId)
              .then((resp) => {
                historyOffsetRef.current = resp.fileBytes
                const out: ChatMsg[] = []
                for (const h of resp.messages) appendHistoryMsg(out, h)
                setMsgs(() => out)
                sockRef.current?.send({ kind: 'tail_subscribe', from: resp.fileBytes })
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

  const send = () => {
    const text = input.trim()
    if (!text || !sockRef.current) return
    if (text === '/rewind') {
      if (isCodex) {
        pushSystem('Codex 会话暂不支持回滚（后续版本开放）')
        setInput('')
        return
      }
      setShowRewind(true)
      setInput('')
      return
    }
    if (text.startsWith('/btw')) {
      if (isCodex) {
        pushSystem('Codex 侧问将随接力功能一同开放')
        setInput('')
        return
      }
      const q = text.slice(4).trim()
      if (q) sockRef.current.send({ kind: 'btw', question: q })
      else pushSystem('用法：/btw <问题>')
      setInput('')
      return
    }
    // codex 的 /compact 走控制请求（thread/compact/start），不作为文本发给模型
    if (isCodex && text === '/compact') {
      sockRef.current.send({ kind: 'control', subtype: 'compact' })
      setInput('')
      return
    }
    pushMsg({ id: nextId(), role: 'user', blocks: [{ kind: 'text', text }] })
    sockRef.current.send({ kind: 'user', text })
    setInput('')
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

  // 优先 initialize 握手返回的命令（含描述），其次 init 消息的命令名，最后静态兜底
  const cmdEntries: Array<{ name: string; desc?: string }> = state.slashCommands?.length
    ? state.slashCommands.map((c) => ({ name: c.name, desc: c.description }))
    : (initInfo.slashCommands?.length ? initInfo.slashCommands : FALLBACK_COMMANDS).map((n) => ({
        name: n,
        desc: COMMAND_DESC[n],
      }))
  const slashHints =
    input.startsWith('/') && !input.includes(' ')
      ? cmdEntries.filter((c) => `/${c.name}`.startsWith(input.trim())).slice(0, 6)
      : []

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

          {/* 流式草稿 */}
          {draft && draft.blocks.length > 0 && (
            <div className="my-3 flex items-start gap-2.5">
              <span
                className={`flex w-5 shrink-0 justify-center select-none ${
                  draft.blocks[0]?.kind === 'text' ? 'pt-[4px]' : 'pt-[13px]'
                }`}
              >
                <ClaudeMark className="h-3.5 w-3.5 opacity-70" />
              </span>
              <div className="min-w-0 flex-1">
                {draft.blocks.map((b) => {
                  if (b.kind === 'tool') {
                    return (
                      <div
                        key={b.idx}
                        className="my-1.5 rounded-md border border-line bg-surface2/40 px-2.5 py-1.5 font-mono text-[12px]"
                      >
                        <span className="text-accent-soft">{b.name ?? '…'}</span>
                        <span className="ml-2 animate-pulse text-busy">…</span>
                      </div>
                    )
                  }
                  if (b.kind === 'thinking') {
                    return (
                      <div key={b.idx} className="my-1.5 rounded-md border border-line/60 bg-surface2/30 px-2.5 py-1.5">
                        <span className="font-mono text-[11px] tracking-wide text-faint">思考</span>
                        <span className="ml-1 animate-pulse font-mono text-[11px] text-busy">进行中…</span>
                        {b.text && (
                          <div className="mt-1 max-h-48 overflow-y-auto text-[13px] leading-relaxed whitespace-pre-wrap text-muted">
                            {b.text}
                          </div>
                        )}
                      </div>
                    )
                  }
                  return (
                    <div key={b.idx} className="relative">
                      <Markdown text={b.text} />
                      <span className="cc-cursor ml-0.5 inline-block h-3.5 w-[7px] bg-accent-soft align-text-bottom" />
                    </div>
                  )
                })}
                {draft.blocks.every((b) => b.kind !== 'text') && (
                  <span className="cc-cursor inline-block h-3.5 w-[7px] bg-accent-soft" />
                )}
              </div>
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
            {isExisting && (
              <button
                className="shrink-0 rounded border border-line px-2 py-1 font-mono text-[11px] text-faint hover:text-muted"
                title="会话详情：context 用量 / MCP 状态 / 设置"
                onClick={() => {
                  setDetailOpen((v) => !v)
                  if (!detailOpen) runQuery('get_context_usage', 'context 用量')
                }}
              >
                详情
              </button>
            )}
            {isExisting && (
              <button
                className="shrink-0 rounded border border-accent/60 px-2 py-1 font-mono text-[11px] text-accent-soft hover:bg-accent/10 disabled:opacity-40"
                disabled={handoffBusy}
                title="让另一个 agent 接续本目录的工作（源会话 fork 自写简报，目标会话带简报进场）"
                onClick={() => {
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
          </div>
          {usageLine && (
            <div className="mt-1 font-mono text-[10px] tracking-wide text-faint/80">{usageLine}</div>
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
            onSetMode={(m) => {
              setPermMode(m)
              sockRef.current?.send({ kind: 'control', subtype: 'set_permission_mode', extra: { mode: m } })
            }}
            onSetEffort={(e) => {
              setEffort(e)
              sockRef.current?.send({ kind: 'update_env', variables: { CLAUDE_CODE_EFFORT_LEVEL: e } })
            }}
          />
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
              {(['get_context_usage', 'mcp_status', 'get_settings'] as const).map((q) => (
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
              {slashHints.map((c) => (
                <button
                  key={c.name}
                  className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left hover:bg-surface2"
                  onClick={() => setInput(`/${c.name} `)}
                >
                  <span className="font-mono text-[12px] text-accent-soft">/{c.name}</span>
                  {c.desc && <span className="truncate text-xs text-faint">{c.desc}</span>}
                </button>
              ))}
            </div>
          )}
          <div
            className={`border-y px-1 py-2 transition-colors ${
              busy ? 'border-busy/50' : 'border-line focus-within:border-accent/50'
            }`}
          >
            <div className="flex items-start gap-2">
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
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                    e.preventDefault()
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
                  disabled={!input.trim() || !connected}
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
