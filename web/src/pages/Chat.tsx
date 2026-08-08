import { useEffect, useRef, useState } from 'react'
import { fetchConfig, fetchHistory, type ServerConfigInfo, type SessionInfo } from '../lib/api'
import { SessionSocket, type CliMsg, type ServerEvent, type SessionState } from '../lib/ws'
import { ControlsBar } from '../components/ControlsBar'
import { ApprovalCard } from '../components/ApprovalCard'
import { RewindPicker } from '../components/RewindPicker'

const SLASH_COMMANDS = [
  { cmd: '/compact', desc: '压缩上下文' },
  { cmd: '/context', desc: '查看上下文占用' },
  { cmd: '/rewind', desc: '回滚到之前的消息' },
  { cmd: '/btw ', desc: '侧问（不污染主会话）' },
]

interface ChatMsg {
  id: string
  role: 'user' | 'assistant' | 'system'
  text: string
  tools?: string[]
  pending?: boolean
}

interface Approval {
  requestId: string
  toolName: string
  input: unknown
}

let msgSeq = 0
const nextId = () => `m${++msgSeq}`

/** 从 CLI 的 assistant/user 消息提取文本与工具调用 */
function extract(msg: CliMsg): { text: string; tools: string[] } | null {
  const content = msg.message?.content
  if (typeof content === 'string') return { text: content, tools: [] }
  if (!Array.isArray(content)) return null
  let text = ''
  const tools: string[] = []
  for (const c of content) {
    if (c?.type === 'text' && c.text) text += (text ? '\n' : '') + c.text
    else if (c?.type === 'thinking') text += (text ? '\n' : '') + `> 💭 ${String(c.thinking ?? '').slice(0, 500)}`
    else if (c?.type === 'tool_use') tools.push(String(c.name))
    else if (c?.type === 'tool_result') {
      const rc = c.content
      const rt = typeof rc === 'string' ? rc : Array.isArray(rc) ? rc.map((x) => x?.text ?? '').join('') : ''
      if (rt.trim()) text += (text ? '\n' : '') + `[工具结果] ${rt.slice(0, 300)}`
    }
  }
  if (!text.trim() && tools.length === 0) return null
  return { text: text.trim(), tools }
}

export function Chat(props: { session: SessionInfo; onBack: () => void }) {
  const { session } = props
  const [messages, setMessages] = useState<(ChatMsg & { rewindable?: boolean })[]>([])
  const [input, setInput] = useState('')
  const [state, setState] = useState<SessionState>({ spawned: false, busy: false })
  const [connected, setConnected] = useState(false)
  const [approvals, setApprovals] = useState<Approval[]>([])
  const [cfg, setCfg] = useState<ServerConfigInfo>()
  const [showRewind, setShowRewind] = useState(false)
  const [btwPending, setBtwPending] = useState<string | undefined>()
  const [draft, setDraft] = useState('')
  const sockRef = useRef<SessionSocket>()
  const bottomRef = useRef<HTMLDivElement>(null)

  const isExisting = session.key.startsWith('s|')

  // 加载历史
  useEffect(() => {
    setMessages([])
    if (isExisting) {
      fetchHistory(session.slug, session.sessionId).then((hist) =>
        setMessages(
          hist
            .filter((h) => !h.isMeta)
            .map((h) => ({
              id: h.uuid ?? nextId(),
              role: h.role,
              text: h.text,
              tools: h.toolUses?.map((t) => t.name),
              rewindable: h.rewindable,
            })),
        ),
      )
    }
  }, [session.key])

  // WS 连接
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
            setMessages((prev) => [...prev, { id: nextId(), role: 'system', text: `⚠️ ${ev.message}` }])
            break
          case 'btw_pending':
            setBtwPending(ev.question)
            break
          case 'btw_result':
            setBtwPending(undefined)
            setMessages((prev) => [
              ...prev,
              { id: nextId(), role: 'system', text: `💬 侧问：${ev.question}\n${ev.ok ? ev.text : `⚠️ ${ev.text}`}` },
            ])
            break
          case 'rewound':
            // 截断本地消息到回滚点
            setMessages((prev) => {
              const idx = prev.findIndex((m) => m.id === ev.userMessageId)
              const base = idx >= 0 ? prev.slice(0, idx + 1) : prev
              return [...base, { id: nextId(), role: 'system', text: '↩️ 对话已回滚' }]
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

  const handleCli = (msg: CliMsg) => {
    if (msg.type === 'stream_event') {
      // 流式增量：text_delta 拼入草稿气泡；message_stop 后由完整 assistant 消息接替
      const ev = (msg as Record<string, unknown>).event as
        | { type?: string; delta?: { type?: string; text?: string } }
        | undefined
      if (ev?.type === 'content_block_delta' && ev.delta?.type === 'text_delta' && ev.delta.text) {
        setDraft((d) => d + ev.delta!.text)
      } else if (ev?.type === 'message_stop') {
        // 保留草稿直到完整消息到达，避免闪烁
      }
      return
    }
    if (msg.type === 'control_response') {
      const resp = (msg as Record<string, unknown>).response as { subtype?: string; error?: string } | undefined
      if (resp?.subtype === 'error') {
        setMessages((prev) => [...prev, { id: nextId(), role: 'system', text: `⚠️ ${resp.error ?? '控制请求失败'}` }])
      }
      return
    }
    if (msg.type === 'assistant' || msg.type === 'user') {
      const ex = extract(msg)
      if (!ex) return
      // user 类型里纯 tool_result 已由 extract 标注；isMeta 消息跳过
      if (msg.type === 'user' && (msg as Record<string, unknown>).isMeta) return
      if (msg.type === 'assistant') setDraft('') // 完整消息到达，清掉草稿
      setMessages((prev) => [...prev, { id: msg.uuid ?? nextId(), role: msg.type as 'user' | 'assistant', text: ex.text, tools: ex.tools.length ? ex.tools : undefined }])
    } else if (msg.type === 'system' && msg.subtype === 'status') {
      // 模式/模型变更提示
      const status = (msg as Record<string, unknown>).status as Record<string, unknown> | undefined
      if (status) {
        const parts = Object.entries(status).map(([k, v]) => `${k}=${String(v)}`)
        setMessages((prev) => [...prev, { id: nextId(), role: 'system', text: `ℹ️ ${parts.join(' ')}` }])
      }
    } else if (msg.type === 'result') {
      setDraft('')
    }
  }

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, approvals, draft])

  const send = () => {
    const text = input.trim()
    if (!text || !sockRef.current) return
    // 斜杠命令拦截
    if (text === '/rewind') {
      setShowRewind(true)
      setInput('')
      return
    }
    if (text.startsWith('/btw')) {
      const q = text.slice(4).trim()
      if (q) sockRef.current.send({ kind: 'btw', question: q })
      else setMessages((prev) => [...prev, { id: nextId(), role: 'system', text: '用法：/btw <问题>' }])
      setInput('')
      return
    }
    // /compact、/context 及其他原样发送，由 CLI 处理
    setMessages((prev) => [...prev, { id: nextId(), role: 'user', text }])
    sockRef.current.send({ kind: 'user', text })
    setInput('')
  }

  const rewindTargets = messages
    .filter((m) => m.role === 'user' && m.id.includes('-') && m.rewindable !== false)
    .map((m) => ({ uuid: m.id, text: m.text }))

  const slashHints = input.startsWith('/') && !input.includes(' ')
    ? SLASH_COMMANDS.filter((c) => c.cmd.trim().startsWith(input.trim()))
    : input.trim() === '/'
      ? SLASH_COMMANDS
      : []

  return (
    <div className="flex h-full flex-col bg-zinc-950 text-zinc-100">
      {/* 顶栏 */}
      <div className="flex items-center gap-2 border-b border-zinc-800 px-3 py-2">
        <button className="rounded p-1 text-zinc-400 hover:bg-zinc-800 md:hidden" onClick={props.onBack}>
          ← 返回
        </button>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium">{session.title ?? session.cwd ?? session.sessionId}</div>
          <div className="text-xs text-zinc-500">
            {connected ? '🟢 已连接' : '🔴 连接中…'}
            {state.busy && ' · ⏳ 工作中'}
            {state.exited && ' · 进程已退出'}
          </div>
        </div>
      </div>

      {cfg && <ControlsBar cfg={cfg} sock={() => sockRef.current} busy={state.busy} />}

      {/* 消息流 */}
      <div className="flex-1 overflow-y-auto px-3 py-2">
        {messages.map((m) => (
          <div key={m.id} className={`my-2 flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
            <div
              className={`max-w-[85%] whitespace-pre-wrap rounded-lg px-3 py-2 text-sm md:max-w-[70%] ${
                m.role === 'user'
                  ? 'bg-sky-700'
                  : m.role === 'system'
                    ? 'bg-zinc-800 text-zinc-400 italic'
                    : 'bg-zinc-800'
              }`}
            >
              {m.tools && (
                <div className="mb-1 flex flex-wrap gap-1">
                  {m.tools.map((t, i) => (
                    <span key={i} className="rounded bg-zinc-700 px-1.5 py-0.5 text-xs text-amber-300">
                      🔧 {t}
                    </span>
                  ))}
                </div>
              )}
              {m.text}
            </div>
          </div>
        ))}
        {draft && (
          <div className="my-2 flex justify-start">
            <div className="max-w-[85%] whitespace-pre-wrap rounded-lg bg-zinc-800 px-3 py-2 text-sm md:max-w-[70%]">
              {draft}
              <span className="ml-1 inline-block h-3 w-1.5 animate-pulse bg-zinc-400" />
            </div>
          </div>
        )}
        {state.busy && !draft && <div className="my-2 text-xs text-zinc-500 animate-pulse">Claude 正在思考…</div>}
        {btwPending && <div className="my-2 text-xs text-sky-400 animate-pulse">侧问中：{btwPending}</div>}

        {approvals.map((a) => (
          <ApprovalCard
            key={a.requestId}
            approval={a}
            onDecision={(decision) => sockRef.current?.send({ kind: 'approval', requestId: a.requestId, decision })}
          />
        ))}
        <div ref={bottomRef} />
      </div>

      {showRewind && (
        <RewindPicker
          targets={rewindTargets}
          onClose={() => setShowRewind(false)}
          onRewindFiles={(uuid) => {
            sockRef.current?.send({ kind: 'control', subtype: 'rewind_files', extra: { user_message_id: uuid } })
            setMessages((prev) => [...prev, { id: nextId(), role: 'system', text: '↩️ 已请求回滚文件' }])
            setShowRewind(false)
          }}
          onRewindConversation={(uuid) => {
            sockRef.current?.send({ kind: 'rewind_conversation', userMessageId: uuid })
            setShowRewind(false)
          }}
        />
      )}

      {/* 输入区 */}
      <div className="border-t border-zinc-800 p-3">
        {slashHints.length > 0 && (
          <div className="mb-2 rounded bg-zinc-800 p-1">
            {slashHints.map((c) => (
              <button
                key={c.cmd}
                className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-zinc-700"
                onClick={() => setInput(c.cmd)}
              >
                <span className="text-sky-400">{c.cmd.trim()}</span>
                <span className="text-xs text-zinc-500">{c.desc}</span>
              </button>
            ))}
          </div>
        )}
        <div className="flex gap-2">
          <textarea
            className="max-h-32 flex-1 resize-none rounded bg-zinc-800 px-3 py-2 text-sm outline-none placeholder:text-zinc-500"
            rows={1}
            placeholder="发送消息…（/compact /context /rewind 也可用）"
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
            className="rounded bg-sky-600 px-4 text-sm hover:bg-sky-500 disabled:opacity-40"
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
