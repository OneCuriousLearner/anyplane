import { useEffect, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { SessionList } from './pages/SessionList'
import { Chat } from './pages/Chat'
import { AnyPlaneMark } from './components/AnyPlaneMark'
import { ClaudeMark } from './components/ClaudeMark'
import { ModeBadge } from './components/ModeBadge'
import { getToken, onAuthRequired, setToken } from './lib/auth'
import { fetchSessions, type SessionInfo } from './lib/api'
import { sessionFromKey } from './lib/key'

/** 推送通知深链：`/#s=<sessionKey>` 直达会话（SW notificationclick 写入） */
function deepLinkKey(): string | null {
  const m = location.hash.match(/^#s=(.+)$/)
  return m ? decodeURIComponent(m[1]) : null
}

const SIDEBAR_KEY = 'anyplane-sidebar-width'
const SIDEBAR_DEFAULT = 300
const SIDEBAR_MIN = 275
const SIDEBAR_MAX = 560

function clampSidebar(n: number): number {
  return Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, Math.round(n)))
}

function loadSidebarWidth(): number {
  const n = Number(localStorage.getItem(SIDEBAR_KEY))
  return Number.isFinite(n) ? clampSidebar(n) : SIDEBAR_DEFAULT
}

export default function App() {
  const [selected, setSelected] = useState<SessionInfo | undefined>()
  const [authNeeded, setAuthNeeded] = useState(false)
  const [sidebarW, setSidebarW] = useState(loadSidebarWidth)
  const [resizing, setResizing] = useState(false)

  useEffect(() => onAuthRequired(() => setAuthNeeded(true)), [])

  // 深链引导：启动时读 #s=<key>（推送通知点击直达），选中后清掉 hash
  useEffect(() => {
    const key = deepLinkKey()
    if (!key) return
    fetchSessions()
      .then((list) => {
        const found = list.find((s) => s.key === key)
        const target = found ?? sessionFromKey(key)
        if (target) {
          setSelected(target)
          history.replaceState(null, '', location.pathname)
        }
      })
      .catch(() => {})
  }, [])

  const persistWidth = (w: number) => {
    const next = clampSidebar(w)
    setSidebarW(next)
    localStorage.setItem(SIDEBAR_KEY, String(next))
  }

  const onResizeDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    e.preventDefault()
    e.currentTarget.setPointerCapture(e.pointerId)
    setResizing(true)
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
  }
  const onResizeMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!e.currentTarget.hasPointerCapture(e.pointerId)) return
    setSidebarW(clampSidebar(e.clientX))
  }
  const onResizeUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!e.currentTarget.hasPointerCapture(e.pointerId)) return
    e.currentTarget.releasePointerCapture(e.pointerId)
    setResizing(false)
    document.body.style.cursor = ''
    document.body.style.userSelect = ''
    persistWidth(e.clientX)
  }

  if (authNeeded) {
    return (
      <div className="flex h-dvh flex-col items-center justify-center gap-4 bg-bg px-6">
        {import.meta.env.DEV && <ModeBadge />}
        <AnyPlaneMark fullBleed className="h-10 w-10 opacity-40" />
        <div className="font-mono text-xs tracking-widest text-faint">需要访问令牌</div>
        <form
          className="flex w-full max-w-xs gap-2"
          onSubmit={(e) => {
            e.preventDefault()
            const input = new FormData(e.currentTarget).get('token')
            if (typeof input === 'string' && input.trim()) {
              setToken(input.trim())
              location.reload()
            }
          }}
        >
          <input
            name="token"
            type="password"
            defaultValue={getToken() ?? ''}
            placeholder="authToken"
            autoFocus
            className="min-w-0 flex-1 rounded-full bg-surface px-4 py-2 text-sm outline-none placeholder:text-faint focus:bg-surface2"
          />
          <button type="submit" className="rounded-full bg-ink px-4 py-2 text-sm text-bg">
            进入
          </button>
        </form>
        <div className="max-w-xs text-center text-xs text-faint">
          令牌在服务端的 anyplane.config.json（authToken）或 ANYPLANE_TOKEN 环境变量中配置
        </div>
      </div>
    )
  }

  return (
    <div
      className="h-dvh bg-bg md:grid md:grid-rows-[minmax(0,1fr)]"
      style={{ gridTemplateColumns: `${sidebarW}px minmax(0, 1fr)` }}
    >
      {import.meta.env.DEV && <ModeBadge />}
      {/* 移动端：选中后隐藏列表；桌面端：双栏常显，右缘可拖宽 */}
      <div className={`relative h-full bg-surface/40 ${selected ? 'hidden md:block' : 'block'}`}>
        <SessionList selectedKey={selected?.key} onSelect={setSelected} />
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="调整侧栏宽度"
          aria-valuenow={sidebarW}
          aria-valuemin={SIDEBAR_MIN}
          aria-valuemax={SIDEBAR_MAX}
          title="拖动调整宽度，双击恢复默认"
          className={`absolute inset-y-0 right-0 z-20 hidden w-1.5 cursor-col-resize touch-none md:block ${
            resizing ? 'bg-muted/50' : 'hover:bg-muted/30'
          }`}
          onPointerDown={onResizeDown}
          onPointerMove={onResizeMove}
          onPointerUp={onResizeUp}
          onPointerCancel={onResizeUp}
          onDoubleClick={() => persistWidth(SIDEBAR_DEFAULT)}
        />
      </div>
      <div className={`h-full min-w-0 ${selected ? 'block' : 'hidden md:block'}`}>
        {selected ? (
          <Chat session={selected} onBack={() => setSelected(undefined)} onNavigate={setSelected} />
        ) : (
          <div className="hidden h-full flex-col items-center justify-center gap-3 text-faint md:flex">
            <AnyPlaneMark className="h-10 w-10 text-ink/80 opacity-25" />
            <span className="font-mono text-xs tracking-widest">选择左侧会话，或新建一个</span>
          </div>
        )}
      </div>
    </div>
  )
}
