import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
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

/** 选中态写入 URL（#s=<key>，与 sw.js 深链同编码）；undefined 清回无 hash 路径 */
function writeHash(key: string | undefined, replace: boolean): void {
  const url = key ? `#s=${encodeURIComponent(key)}` : location.pathname + location.search
  history[replace ? 'replaceState' : 'pushState'](null, '', url)
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

  // hash 路由：选中态镜像到 #s=<key>，刷新/分享链接直达当前会话（原深链消费即弃，
  // 刷新就回列表）。selected 是唯一状态源，hash 是它的持久化投影 + 后退/前进入口。
  // 用户主动选择 pushState（后退 = 回列表）；会话内导航（/clear 重键、fork、handoff）
  // replaceState——旧 key 已死，不该留在历史里复活。
  const selectSession = (s: SessionInfo | undefined, opts?: { replace?: boolean }) => {
    setSelected(s)
    writeHash(s?.key, opts?.replace ?? false)
  }

  // 后退/前进：hashchange 只由浏览器导航（或直接改 location.hash）触发，
  // pushState/replaceState 不触发——不会与 selectSession 循环
  const selectedRef = useRef(selected)
  selectedRef.current = selected
  useEffect(() => {
    const onHash = () => {
      const key = deepLinkKey()
      if (!key) {
        setSelected(undefined)
        return
      }
      if (selectedRef.current?.key === key) return // 已在目标会话（selectSession 后的历史项回退）
      // 列表里找全量信息；找不到按 key 构造最小 SessionInfo（s|/x|/b| 可纯 key 构造，
      // 归档会话/深链直达靠它）；n|/xn| 新会话不可构造——清掉无效 hash 回列表
      fetchSessions()
        .then((list) => {
          if (deepLinkKey() !== key) return // fetch 期间用户又导航了，以最新 hash 为准
          const target = list.find((s) => s.key === key) ?? sessionFromKey(key)
          if (target) setSelected(target)
          else history.replaceState(null, '', location.pathname + location.search)
        })
        .catch(() => {})
    }
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])

  // 深链引导：启动时读 #s=<key>（推送通知点击直达 / 刷新恢复），选中后 hash 保留
  useEffect(() => {
    const key = deepLinkKey()
    if (!key) return
    fetchSessions()
      .then((list) => {
        const found = list.find((s) => s.key === key)
        const target = found ?? sessionFromKey(key)
        if (target) {
          setSelected(target)
        } else {
          // n|/xn| 新会话或已删除的 key：不可恢复，清掉无效 hash
          history.replaceState(null, '', location.pathname + location.search)
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
        <SessionList selectedKey={selected?.key} onSelect={(s) => selectSession(s)} />
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
          <Chat
            session={selected}
            onBack={() => selectSession(undefined)}
            onNavigate={(s) => selectSession(s, { replace: true })}
          />
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
