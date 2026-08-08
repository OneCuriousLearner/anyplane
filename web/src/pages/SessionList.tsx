import { useEffect, useState } from 'react'
import { createSession, fetchSessions, type SessionInfo } from '../lib/api'

const STATUS_STYLE: Record<SessionInfo['status'], { dot: string; label: string }> = {
  busy: { dot: 'bg-green-500 animate-pulse', label: '工作中' },
  idle: { dot: 'bg-yellow-500', label: '空闲' },
  waiting: { dot: 'bg-blue-500', label: '等待输入' },
  offline: { dot: 'bg-zinc-500', label: '离线' },
}

function timeAgo(ms: number): string {
  const s = Math.floor((Date.now() - ms) / 1000)
  if (s < 60) return `${s}s 前`
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`
  if (s < 86400) return `${Math.floor(s / 3600)} 小时前`
  return `${Math.floor(s / 86400)} 天前`
}

export function SessionList(props: {
  selectedKey?: string
  onSelect: (s: SessionInfo) => void
}) {
  const [sessions, setSessions] = useState<SessionInfo[]>([])
  const [loading, setLoading] = useState(true)
  const [newCwd, setNewCwd] = useState('')
  const [showNew, setShowNew] = useState(false)

  const refresh = () => {
    fetchSessions()
      .then(setSessions)
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

  const startNew = async () => {
    const cwd = newCwd.trim()
    if (!cwd) return
    const { key, slug } = await createSession(cwd)
    setNewCwd('')
    setShowNew(false)
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
    <div className="flex h-full flex-col bg-zinc-900 text-zinc-100">
      <div className="flex items-center justify-between border-b border-zinc-700 px-4 py-3">
        <h1 className="text-lg font-semibold">会话</h1>
        <button
          className="rounded bg-sky-600 px-3 py-1 text-sm hover:bg-sky-500"
          onClick={() => setShowNew(!showNew)}
        >
          + 新会话
        </button>
      </div>

      {showNew && (
        <div className="border-b border-zinc-700 p-3">
          <input
            className="w-full rounded bg-zinc-800 px-3 py-2 text-sm outline-none placeholder:text-zinc-500"
            placeholder="项目目录，如 /home/you/proj 或 D:\proj"
            value={newCwd}
            onChange={(e) => setNewCwd(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && startNew()}
            list="recent-cwds"
          />
          <datalist id="recent-cwds">
            {[...groups.keys()].map((g) => (
              <option key={g} value={g} />
            ))}
          </datalist>
          <button
            className="mt-2 w-full rounded bg-sky-600 py-2 text-sm hover:bg-sky-500"
            onClick={startNew}
          >
            开始
          </button>
        </div>
      )}

      <div className="flex-1 overflow-y-auto">
        {loading && <p className="p-4 text-sm text-zinc-500">加载中…</p>}
        {!loading && sessions.length === 0 && (
          <p className="p-4 text-sm text-zinc-500">没有发现会话</p>
        )}
        {[...groups.entries()].map(([cwd, list]) => (
          <div key={cwd}>
            <div className="sticky top-0 bg-zinc-800/95 px-4 py-1.5 text-xs text-zinc-400 backdrop-blur">
              {cwd}
            </div>
            {list.map((s) => {
              const st = STATUS_STYLE[s.managed.busy ? 'busy' : s.status]
              return (
                <button
                  key={s.key}
                  onClick={() => props.onSelect(s)}
                  className={`block w-full px-4 py-3 text-left hover:bg-zinc-800 ${
                    props.selectedKey === s.key ? 'bg-zinc-800' : ''
                  }`}
                >
                  <div className="flex items-center gap-2">
                    <span className={`h-2 w-2 shrink-0 rounded-full ${st.dot}`} />
                    <span className="truncate text-sm">{s.title ?? s.sessionId.slice(0, 8)}</span>
                  </div>
                  <div className="mt-1 flex items-center gap-2 pl-4 text-xs text-zinc-500">
                    <span>{st.label}</span>
                    <span>·</span>
                    <span>{timeAgo(s.mtime)}</span>
                    {s.lastPrompt && (
                      <>
                        <span>·</span>
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
    </div>
  )
}
