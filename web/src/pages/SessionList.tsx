import { useEffect, useRef, useState } from 'react'
import { createSession, fetchSessions, renameSession, type SessionInfo } from '../lib/api'
import { InboxSocket, type InboxApproval } from '../lib/inbox'
import { ClaudeMark } from '../components/ClaudeMark'
import { CodexMark } from '../components/CodexMark'
import { DirPicker } from './DirPicker'

const STATUS_META: Record<SessionInfo['status'], { cls: string; label: string }> = {
  busy: { cls: 'bg-busy animate-pulse', label: '工作中' },
  idle: { cls: 'bg-ok', label: '空闲' },
  waiting: { cls: 'bg-wait', label: '等待输入' },
  offline: { cls: 'bg-faint', label: '离线' },
}

function timeAgo(ms: number): string {
  const s = Math.floor((Date.now() - ms) / 1000)
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m`
  if (s < 86400) return `${Math.floor(s / 3600)}h`
  return `${Math.floor(s / 86400)}d`
}

/** 桌面通知开关：localStorage 持久；浏览器授权后在页面隐藏时推送 */
const NOTIFY_KEY = 'cc-remote-notify'

export function SessionList(props: {
  selectedKey?: string
  onSelect: (s: SessionInfo) => void
}) {
  const [sessions, setSessions] = useState<SessionInfo[]>([])
  const [loading, setLoading] = useState(true)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [approvals, setApprovals] = useState<InboxApproval[]>([])
  const [notify, setNotify] = useState(() => localStorage.getItem(NOTIFY_KEY) === '1')
  const sessionsRef = useRef(sessions)
  sessionsRef.current = sessions
  const notifyRef = useRef(notify)
  notifyRef.current = notify

  const titleOf = (key: string): string => {
    const s = sessionsRef.current.find((x) => x.key === key)
    return s?.title ?? s?.cwd ?? key.slice(0, 24)
  }

  const pushNotify = (title: string, body: string) => {
    if (!notifyRef.current || !('Notification' in window)) return
    if (Notification.permission !== 'granted' || !document.hidden) return
    try {
      new Notification(title, { body, tag: 'cc-remote-inbox' })
    } catch {}
  }

  // 全局收件箱：审批队列 + 完成/错误通知
  useEffect(() => {
    const sock = new InboxSocket((ev) => {
      switch (ev.type) {
        case 'snapshot':
          setApprovals(ev.approvals)
          break
        case 'approval':
          setApprovals((prev) => (prev.some((a) => a.requestId === ev.requestId) ? prev : [...prev, ev]))
          pushNotify(`⏸ 需要审批：${titleOf(ev.key)}`, `${ev.toolName} 等待你的决定`)
          break
        case 'approval_resolved':
          setApprovals((prev) => prev.filter((a) => a.requestId !== ev.requestId))
          break
        case 'done':
          if (ev.ok) pushNotify(`✓ 完成：${titleOf(ev.key)}`, '会话本轮工作已收尾')
          break
        case 'error':
          pushNotify(`⚠ 出错：${titleOf(ev.key)}`, ev.message.slice(0, 120))
          break
      }
    })
    return () => sock.close()
  }, [])

  // 标题角标：待审批数
  useEffect(() => {
    document.title = approvals.length > 0 ? `(${approvals.length}) cc-remote` : 'cc-remote'
    return () => {
      document.title = 'cc-remote'
    }
  }, [approvals.length])

  const toggleNotify = async () => {
    if (notify) {
      setNotify(false)
      localStorage.setItem(NOTIFY_KEY, '0')
      return
    }
    if ('Notification' in window && Notification.permission === 'default') {
      await Notification.requestPermission()
    }
    const granted = !('Notification' in window) || Notification.permission === 'granted'
    setNotify(granted)
    localStorage.setItem(NOTIFY_KEY, granted ? '1' : '0')
  }

  const refresh = () => {
    fetchSessions()
      .then(setSessions)
      .catch(() => {}) // 401 由 App 令牌门接管
      .finally(() => setLoading(false))
  }
  useEffect(() => {
    refresh()
    const t = setInterval(refresh, 10_000)
    return () => clearInterval(t)
  }, [])

  // 按项目目录分组
  const groups = new Map<string, SessionInfo[]>()
  for (const s of sessions) {
    const g = s.cwd ?? s.slug
    if (!groups.has(g)) groups.set(g, [])
    groups.get(g)!.push(s)
  }

  const startNew = async (cwd: string, backend: 'claude' | 'codex') => {
    const { key, slug } = await createSession(cwd, backend)
    setPickerOpen(false)
    props.onSelect({
      key,
      slug,
      sessionId: 'new',
      cwd,
      backend,
      mtime: Date.now(),
      sizeBytes: 0,
      status: 'offline',
      managed: { spawned: false, busy: false, clients: 0 },
    })
  }

  return (
    <div className="flex h-full flex-col bg-surface text-ink">
      {/* 报头 */}
      <div className="border-b border-line px-4 pb-3 pt-4">
        <div className="flex items-baseline justify-between">
          <h1 className="flex items-center gap-2 font-mono text-sm tracking-widest text-muted uppercase">
            <ClaudeMark className="h-4 w-4" />
            cc-remote
          </h1>
          <div className="flex items-center gap-2">
            <button
              className={`relative rounded border px-2 py-1 font-mono text-xs ${
                notify ? 'border-accent/60 text-accent-soft' : 'border-line text-faint'
              }`}
              title={notify ? '桌面通知已开启（页面隐藏时推送）' : '开启桌面通知'}
              onClick={toggleNotify}
            >
              🔔
              {approvals.length > 0 && (
                <span className="absolute -right-1.5 -top-1.5 rounded-full bg-danger px-1 text-[9px] leading-4 text-white">
                  {approvals.length}
                </span>
              )}
            </button>
            <button
              className="rounded border border-accent/60 px-2.5 py-1 font-mono text-xs text-accent-soft hover:bg-accent/10"
              onClick={() => setPickerOpen(true)}
            >
              + 新会话
            </button>
          </div>
        </div>
        <p className="mt-1 text-xs text-faint">Claude Code Claw</p>
      </div>

      {/* 待审批收件箱：点击直达会话 */}
      {approvals.length > 0 && (
        <div className="border-b border-wait/40 bg-wait/10 px-4 py-2">
          {approvals.map((a) => (
            <button
              key={a.requestId}
              className="flex w-full items-center gap-2 py-1 text-left font-mono text-[11px] text-wait hover:text-ink"
              onClick={() => {
                const s = sessions.find((x) => x.key === a.key)
                if (s) props.onSelect(s)
              }}
            >
              <span className="animate-pulse">⏸</span>
              <span className="truncate">{titleOf(a.key)}</span>
              <span className="shrink-0 text-faint">{a.toolName}</span>
            </button>
          ))}
        </div>
      )}

      <div className="flex-1 overflow-y-auto">
        {loading && <p className="p-4 font-mono text-xs text-faint">加载中…</p>}
        {!loading && sessions.length === 0 && (
          <div className="p-4 text-sm text-muted">
            <p>还没有会话。</p>
            <p className="mt-1 text-xs text-faint">点「+ 新会话」，从文件系统选择项目目录即可开始。</p>
          </div>
        )}
        {[...groups.entries()].map(([cwd, list]) => {
          const branch = list.find((s) => s.gitBranch)?.gitBranch
          const nClaude = list.filter((s) => s.backend !== 'codex').length
          const nCodex = list.length - nClaude
          return (
          <div key={cwd}>
            <div className="sticky top-0 flex items-center gap-2 border-y border-line/60 bg-surface/95 px-4 py-1.5 font-mono text-[11px] tracking-wide text-muted backdrop-blur">
              <span className="truncate">{cwd}</span>
              {branch && <span className="shrink-0 text-faint">⎇ {branch}</span>}
              <span className="ml-auto flex shrink-0 gap-1.5 text-[10px] text-faint">
                {nClaude > 0 && <span className="text-accent-soft/80">CC {nClaude}</span>}
                {nCodex > 0 && <span className="text-sky-300/80">CX {nCodex}</span>}
              </span>
            </div>
            {list.map((s) => {
              const st =
                STATUS_META[
                  s.managed.waiting ? 'waiting' : s.managed.busy ? 'busy' : s.managed.spawned ? 'idle' : s.status
                ] ?? STATUS_META.offline
              const active = props.selectedKey === s.key
              return (
                <button
                  key={s.key}
                  onClick={() => props.onSelect(s)}
                  className={`group block w-full border-b border-line/40 px-4 py-3 text-left transition-colors hover:bg-surface2/60 ${
                    active ? 'bg-surface2/80 shadow-[inset_2px_0_0_var(--color-accent)]' : ''
                  }`}
                >
                  <div className="flex items-center gap-2">
                    <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${st.cls}`} />
                    <span className="truncate text-sm">{s.title ?? s.sessionId.slice(0, 8)}</span>
                    <span
                      className="shrink-0 rounded px-0.5 font-mono text-[10px] text-faint/40 transition-colors hover:text-faint"
                      title="改名"
                      onClick={(e) => {
                        e.stopPropagation()
                        const title = prompt('会话名称', s.title ?? '')
                        if (title?.trim()) {
                          renameSession(s.key, title.trim()).then(refresh).catch((err) => alert(String(err)))
                        }
                      }}
                    >
                      ✎
                    </span>
                    <span className="flex h-[15px] w-[15px] shrink-0 items-center justify-center" title={s.backend === 'codex' ? 'Codex' : 'Claude'}>
                      {s.backend === 'codex' ? (
                        <CodexMark size={15} />
                      ) : (
                        <ClaudeMark className="h-[15px] w-[15px]" />
                      )}
                    </span>
                    <span className="ml-auto shrink-0 font-mono text-[10px] text-faint">
                      {timeAgo(s.mtime)}
                    </span>
                  </div>
                  <div className="mt-1 flex items-center gap-1.5 pl-3.5 font-mono text-[11px] text-faint">
                    <span className="shrink-0">{st.label}</span>
                    {s.lastPrompt && (
                      <>
                        <span className="text-line">│</span>
                        <span className="truncate">{s.lastPrompt}</span>
                      </>
                    )}
                  </div>
                </button>
              )
            })}
          </div>
          )
        })}
      </div>

      {pickerOpen && (
        <DirPicker sessions={sessions} onStart={startNew} onClose={() => setPickerOpen(false)} />
      )}
    </div>
  )
}
