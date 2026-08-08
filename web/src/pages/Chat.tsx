import { useEffect, useRef, useState } from 'react'
import { fetchConfig, fetchHistory, type ServerConfigInfo, type SessionInfo } from '../lib/api'
import { SessionSocket, type CliMsg, type ServerEvent, type SessionState } from '../lib/ws'
import { ControlsBar } from '../components/ControlsBar'
import { ApprovalCard } from '../components/ApprovalCard'
import { RewindPicker } from '../components/RewindPicker'
import { MessageView } from '../components/MessageView'
import { Markdown } from '../components/Markdown'
import { ClaudeMark } from '../components/ClaudeMark'
import { nextId, toolResultText, type Block, type ChatMsg } from '../lib/blocks'

const FALLBACK_COMMANDS = ['compact', 'context', 'rewind', 'btw']
const COMMAND_DESC: Record<string, string> = {
  compact: '压缩上下文',
  context: '查看上下文占用',
  rewind: '回滚到之前的消息',
  btw: '侧问（不污染主会话）',
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

export function Chat(props: { session: SessionInfo; onBack: () => void }) {
  const { session } = props
  const [messages, setMessages] = useState<ChatMsg[]>([])
  const [input, setInput] = useState('')
  const [state, setState] = useState<SessionState>({ spawned: false, busy: false })
  const [connected, setConnected] = useState(false)
  const [approvals, setApprovals] = useState<Approval[]>([])
  const [cfg, setCfg] = useState<ServerConfigInfo>()
  const [showRewind, setShowRewind] = useState(false)
  const [btwPending, setBtwPending] = useState<string | undefined>()
  const [draft, setDraft] = useState<Draft | null>(null)
  const [phase, setPhase] = useState<string>()
  const [initInfo, setInitInfo] = useState<{ model?: string; slashCommands?: string[] }>({})
  const [permMode, setPermMode] = useState<string>()
  const sockRef = useRef<SessionSocket | undefined>(undefined)
  const bottomRef = useRef<HTMLDivElement>(null)

  // ref 镜像：事件处理器在 React 渲染外触发，直接基于 ref 计算，避免过期闭包/updater 双重调用
  const messagesRef = useRef<ChatMsg[]>([])
  const draftRef = useRef<Draft | null>(null)
  const pendingResultsRef = useRef(new Map<string, { text: string; isError: boolean }>())

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

  const isExisting = session.key.startsWith('s|')

  // ---------- 历史加载 ----------
  useEffect(() => {
    setMsgs(() => [])
    if (!isExisting) return
    fetchHistory(session.slug, session.sessionId).then((hist) => {
      const out: ChatMsg[] = []
      // tool_use → tool_result 配对（历史里分处两条消息）
      const pair = (toolUseId: string | undefined, text: string, isError: boolean) => {
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
      for (const h of hist) {
        if (h.isMeta) continue
        if (h.role === 'system' && h.subtype === 'compact_boundary') {
          out.push({ id: h.uuid ?? nextId(), role: 'system', systemKind: 'divider', compactMeta: h.compactMeta, blocks: [] })
          continue
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
        if (blocks.length > 0) out.push({ id: h.uuid ?? nextId(), role: h.role, blocks, rewindable: h.rewindable })
        for (const r of stray) pushInto(out, r)
      }
      setMsgs(() => out)
    })
    function pushInto(out: ChatMsg[], r: { text: string; isError: boolean }) {
      out.push({
        id: nextId(),
        role: 'system',
        systemKind: r.isError ? 'error' : 'info',
        blocks: [{ kind: 'text', text: r.text.slice(0, 500) }],
      })
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
    fetchConfig().then(setCfg)
    const sock = new SessionSocket(
      session.key,
      (ev: ServerEvent) => {
        switch (ev.kind) {
          case 'status':
            setState(ev.state)
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
            setBtwPending(ev.question)
            break
          case 'btw_result':
            setBtwPending(undefined)
            pushSystem(`💬 侧问：${ev.question}\n${ev.ok ? ev.text : `⚠ ${ev.text}`}`, ev.ok ? 'info' : 'error')
            break
          case 'rewound':
            setMsgs((prev) => {
              const idx = prev.findIndex((m) => m.id === ev.userMessageId)
              const base = idx >= 0 ? prev.slice(0, idx + 1) : prev
              return [...base, { id: nextId(), role: 'system', blocks: [{ kind: 'text', text: '↩ 对话已回滚' }] }]
            })
            break
          case 'cli':
            handleCli(ev.msg)
            break
        }
      },
      setConnected,
    )
    sockRef.current = sock
    sock.send({ kind: 'attach' })
    return () => sock.close()
  }, [session.key])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, approvals, draft])

  // ---------- 发送 ----------
  const send = () => {
    const text = input.trim()
    if (!text || !sockRef.current) return
    if (text === '/rewind') {
      setShowRewind(true)
      setInput('')
      return
    }
    if (text.startsWith('/btw')) {
      const q = text.slice(4).trim()
      if (q) sockRef.current.send({ kind: 'btw', question: q })
      else pushSystem('用法：/btw <问题>')
      setInput('')
      return
    }
    pushMsg({ id: nextId(), role: 'user', blocks: [{ kind: 'text', text }] })
    sockRef.current.send({ kind: 'user', text })
    setInput('')
  }

  const rewindTargets = messages
    .filter((m) => m.role === 'user' && m.id.includes('-') && m.rewindable !== false)
    .map((m) => ({ uuid: m.id, text: m.blocks.find((b) => b.kind === 'text')?.text ?? '' }))

  const cmdList = initInfo.slashCommands?.length ? initInfo.slashCommands : FALLBACK_COMMANDS
  const slashHints =
    input.startsWith('/') && !input.includes(' ') ? cmdList.filter((c) => `/${c}`.startsWith(input.trim())).slice(0, 6) : []

  const busy = state.busy
  const statusLine = !connected
    ? '连接中…'
    : phase
      ? `${PHASE_LABEL[phase] ?? phase}…`
      : busy
        ? '工作中'
        : state.exited
          ? '进程已退出'
          : '已连接'

  return (
    <div className="flex h-full flex-col bg-bg text-ink">
      {/* 顶栏 */}
      <div className="flex items-center gap-2 border-b border-line bg-surface px-3 py-2">
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
            {initInfo.model && <span className="text-line">│</span>}
            {initInfo.model && <span className="truncate">{initInfo.model}</span>}
            {permMode && <span className="text-line">│</span>}
            {permMode && <span>{permMode}</span>}
          </div>
        </div>
      </div>

      {cfg && <ControlsBar cfg={cfg} sock={() => sockRef.current} busy={busy} />}

      {/* 消息抄本 */}
      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl px-3 py-3 md:px-6">
          {messages.map((m, i) => (
            <MessageView
              key={m.id}
              msg={m}
              compact={m.role !== 'system' && messages[i - 1]?.role === m.role}
            />
          ))}

          {/* 流式草稿 */}
          {draft && draft.blocks.length > 0 && (
            <div className="my-3 flex gap-2.5">
              <span className="mt-0.5 flex w-5 shrink-0 justify-center select-none">
                <ClaudeMark className="mt-0.5 h-3.5 w-3.5 opacity-70" />
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
          {btwPending && (
            <div className="my-2 animate-pulse pl-7 font-mono text-[11px] text-accent-soft">💬 侧问中：{btwPending}</div>
          )}

          {approvals.map((a) => (
            <ApprovalCard
              key={a.requestId}
              approval={a}
              onDecision={(decision) => sockRef.current?.send({ kind: 'approval', requestId: a.requestId, decision })}
            />
          ))}
          <div ref={bottomRef} />
        </div>
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
        />
      )}

      {/* 输入区 */}
      <div className="border-t border-line bg-surface p-3">
        {slashHints.length > 0 && (
          <div className="mb-2 rounded border border-line bg-surface2/60 p-1">
            {slashHints.map((c) => (
              <button
                key={c}
                className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left hover:bg-surface2"
                onClick={() => setInput(`/${c} `)}
              >
                <span className="font-mono text-[12px] text-accent-soft">/{c}</span>
                {COMMAND_DESC[c] && <span className="text-xs text-faint">{COMMAND_DESC[c]}</span>}
              </button>
            ))}
          </div>
        )}
        <div className="mx-auto flex max-w-3xl gap-2">
          <textarea
            className="max-h-32 flex-1 resize-none rounded border border-line bg-bg px-3 py-2 text-sm outline-none placeholder:text-faint focus:border-accent/60"
            rows={1}
            placeholder="发送消息…（/ 开头出命令提示）"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault()
                send()
              }
            }}
          />
          <button
            className="rounded bg-accent px-4 text-sm font-medium text-bg hover:bg-accent-soft disabled:opacity-30"
            onClick={send}
            disabled={!input.trim()}
          >
            发送
          </button>
        </div>
      </div>
    </div>
  )
}
