import { useEffect, useState } from 'react'
import { createSession, fetchSessions, type SessionInfo } from '../lib/api'
import { ClaudeMark } from '../components/ClaudeMark'
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

export function SessionList(props: {
  selectedKey?: string
  onSelect: (s: SessionInfo) => void
}) {
  const [sessions, setSessions] = useState<SessionInfo[]>([])
  const [loading, setLoading] = useState(true)
  const [pickerOpen, setPickerOpen] = useState(false)

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

  const startNew = async (cwd: string) => {
    const { key, slug } = await createSession(cwd)
    setPickerOpen(false)
    props.onSelect({
      key,
      slug,
      sessionId: 'new',
      cwd,
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
          <button
            className="rounded border border-accent/60 px-2.5 py-1 font-mono text-xs text-accent-soft hover:bg-accent/10"
            onClick={() => setPickerOpen(true)}
          >
            + 新会话
          </button>
        </div>
        <p className="mt-1 text-xs text-faint">Claude Code Claw</p>
      </div>

      <div className="flex-1 overflow-y-auto">
        {loading && <p className="p-4 font-mono text-xs text-faint">加载中…</p>}
        {!loading && sessions.length === 0 && (
          <div className="p-4 text-sm text-muted">
            <p>还没有会话。</p>
            <p className="mt-1 text-xs text-faint">点「+ 新会话」，从文件系统选择项目目录即可开始。</p>
          </div>
        )}
        {[...groups.entries()].map(([cwd, list]) => (
          <div key={cwd}>
            <div className="sticky top-0 border-y border-line/60 bg-surface/95 px-4 py-1.5 font-mono text-[11px] tracking-wide text-muted backdrop-blur">
              {cwd}
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
                  className={`block w-full border-b border-line/40 px-4 py-3 text-left transition-colors hover:bg-surface2/60 ${
                    active ? 'bg-surface2/80 shadow-[inset_2px_0_0_var(--color-accent)]' : ''
                  }`}
                >
                  <div className="flex items-center gap-2">
                    <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${st.cls}`} />
                    <span className="truncate text-sm">{s.title ?? s.sessionId.slice(0, 8)}</span>
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
        ))}
      </div>

      {pickerOpen && (
        <DirPicker sessions={sessions} onStart={startNew} onClose={() => setPickerOpen(false)} />
      )}
    </div>
  )
}
