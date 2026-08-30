import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  archiveSession,
  createSession,
  fetchArchived,
  fetchSessions,
  makeSessionInfo,
  renameSession,
  restoreSession,
  type ArchivedEntry,
  type SessionInfo,
} from '../lib/api'
import { InboxSocket, type InboxApproval } from '../lib/inbox'
import { currentPushEndpoint, pushSupported, subscribePush, unsubscribePush } from '../lib/push'
import { authHeaders } from '../lib/auth'
import { BellIcon } from '../components/BellIcon'
import { AnyPlaneMark } from '../components/AnyPlaneMark'
import { getThemeChoice, setThemeChoice, toggleTheme, type ThemeChoice } from '../lib/theme'
import { ClaudeMark } from '../components/ClaudeMark'
import { CodexMark } from '../components/CodexMark'
import { ConfirmDialog, PromptDialog } from '../components/Dialogs'
import { PopupPanel } from '../components/PopupPanel'
import { DirPicker } from './DirPicker'

const STATUS_META: Record<SessionInfo['status'], { cls: string; label: string }> = {
  busy: { cls: 'bg-busy', label: '工作中' },
  idle: { cls: 'bg-ok', label: '空闲' },
  waiting: { cls: 'bg-accent', label: '等待审批' },
  offline: { cls: 'bg-faint', label: '离线' },
}

/** 顶栏圆形图标按钮（双轨圆角制：控件一律全圆） */
function IconBtn(props: {
  title: string
  onClick: () => void
  accent?: boolean
  active?: boolean
  redDot?: boolean
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      title={props.title}
      aria-label={props.title}
      onClick={props.onClick}
      className={`relative grid h-8 w-8 shrink-0 place-items-center rounded-full transition-colors ${
        props.accent
          ? 'bg-ink text-bg'
          : props.active
            ? 'bg-surface2 text-ink'
            : 'bg-surface2 text-muted hover:text-ink'
      }`}
    >
      {props.children}
      {props.redDot && (
        <span className="absolute top-1 right-1 h-[7px] w-[7px] rounded-full bg-accent" aria-hidden />
      )}
    </button>
  )
}

function PlusIcon(props: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" className={props.className} aria-hidden>
      <path d="M12 5v14M5 12h14" />
    </svg>
  )
}

function TrashIcon(props: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={props.className} aria-hidden>
      <path d="M3 6h18" />
      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
      <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
    </svg>
  )
}

function BranchIcon(props: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={props.className} aria-hidden>
      <line x1="6" y1="3" x2="6" y2="15" />
      <circle cx="18" cy="6" r="3" />
      <circle cx="6" cy="18" r="3" />
      <path d="M18 9a9 9 0 0 1-9 9" />
    </svg>
  )
}

/** 通知菜单行内容：状态点 + 标题/描述 + 右侧操作文案（外壳 button/只读 div 由调用方定） */
function NotifyRow(props: { on: boolean; title: string; desc: string; action?: string }) {
  return (
    <>
      <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${props.on ? 'bg-ok' : 'bg-faint'}`} />
      <span className="min-w-0 flex-1">
        <span className="block font-mono text-[11px] text-ink">{props.title}</span>
        <span className="block text-[10px] leading-snug text-faint">{props.desc}</span>
      </span>
      {props.action && <span className="font-mono text-[10px] text-faint">{props.action}</span>}
    </>
  )
}

function timeAgo(ms: number): string {
  const s = Math.floor((Date.now() - ms) / 1000)
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m`
  if (s < 86400) return `${Math.floor(s / 3600)}h`
  return `${Math.floor(s / 86400)}d`
}

/** 分组标题用末级目录名（Windows / POSIX 都切）；hover 仍看完整路径 */
function dirBasename(path: string): string {
  return path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || path
}

/** 桌面通知开关：localStorage 持久；浏览器授权后在页面隐藏时推送 */
const NOTIFY_KEY = 'anyplane-notify'
/** 按项目目录折叠的分组，cwd 字符串数组 */
const COLLAPSE_KEY = 'anyplane-collapsed-groups'

function loadCollapsed(): Set<string> {
  try {
    const raw = JSON.parse(localStorage.getItem(COLLAPSE_KEY) ?? '[]') as unknown
    return new Set(Array.isArray(raw) ? raw.filter((x): x is string => typeof x === 'string') : [])
  } catch {
    return new Set()
  }
}

export function SessionList(props: {
  selectedKey?: string
  onSelect: (s: SessionInfo) => void
}) {
  const [sessions, setSessions] = useState<SessionInfo[]>([])
  const [loading, setLoading] = useState(true)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [approvals, setApprovals] = useState<InboxApproval[]>([])
  const [notify, setNotify] = useState(() => localStorage.getItem(NOTIFY_KEY) === '1')
  /** 推送订阅状态：已订阅时为 push service endpoint */
  const [pushEndpoint, setPushEndpoint] = useState<string | null>(null)
  /** 服务端配置的 webhook 通道数（ntfy/Bark/Server酱，配置文件管理，只读展示） */
  const [pushWebhooks, setPushWebhooks] = useState(0)
  /** 测试通知发送中 */
  const [pushTestBusy, setPushTestBusy] = useState(false)
  const [pushBusy, setPushBusy] = useState(false)
  const [notifyMenuOpen, setNotifyMenuOpen] = useState(false)
  // 主题长按菜单：timer 计时 500ms 长按，long 标记吞掉随后那次 click
  const [themeMenuOpen, setThemeMenuOpen] = useState(false)
  const themeTimer = useRef<number | undefined>(undefined)
  const themeLong = useRef(false)
  const [view, setView] = useState<'active' | 'archived'>('active')
  const [archived, setArchived] = useState<ArchivedEntry[]>([])
  const [collapsed, setCollapsed] = useState(loadCollapsed)
  /** 二级菜单：打开的会话 + 锚点元素；null 表示无 */
  const [menu, setMenu] = useState<{ session: SessionInfo; anchor: HTMLElement } | null>(null)
  /** 重命名弹窗目标 */
  const [renameTarget, setRenameTarget] = useState<{ session: SessionInfo; anchor: HTMLElement } | null>(null)
  /** 回收站确认弹窗目标 */
  const [archiveTarget, setArchiveTarget] = useState<{ session: SessionInfo; anchor: HTMLElement } | null>(null)
  /** 轻量错误提示（替代 alert） */
  const [toast, setToast] = useState<{ text: string; kind: 'ok' | 'err' } | null>(null)
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
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
      new Notification(title, { body, tag: 'anyplane-inbox' })
    } catch {}
  }

  // 二级菜单：Escape 关闭
  useEffect(() => {
    if (menu === null) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenu(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [menu])

  const showToast = (text: string, kind: 'ok' | 'err' = 'err') => {
    setToast({ text, kind })
    clearTimeout(toastTimerRef.current)
    toastTimerRef.current = setTimeout(() => setToast(null), 4000)
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
    document.title = approvals.length > 0 ? `(${approvals.length}) AnyPlane` : 'AnyPlane'
    return () => {
      document.title = 'AnyPlane'
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

  // 挂载时读取推送订阅现状与 webhook 通道数
  useEffect(() => {
    void currentPushEndpoint().then(setPushEndpoint)
    fetch('/api/push/public-key', { headers: authHeaders() })
      .then((r) => (r.ok ? r.json() : null))
      .then((j: { webhooks?: number } | null) => setPushWebhooks(j?.webhooks ?? 0))
      .catch(() => {})
  }, [])

  const togglePush = async () => {
    if (pushBusy) return
    setPushBusy(true)
    try {
      if (pushEndpoint) {
        await unsubscribePush()
        setPushEndpoint(null)
        showToast('已退订推送', 'ok')
      } else {
        const r = await subscribePush()
        if (r.ok) {
          setPushEndpoint(await currentPushEndpoint())
          showToast('推送已订阅：锁屏也能收到审批/完成通知', 'ok')
        } else {
          showToast(`订阅失败：${r.error}`, 'err')
        }
      }
    } finally {
      setPushBusy(false)
    }
  }

  /** 通道自检：向全部订阅 + webhook 通道发一条测试通知 */
  const sendTestPush = async () => {
    if (pushTestBusy) return
    setPushTestBusy(true)
    try {
      const r = await fetch('/api/push/test', {
        method: 'POST',
        headers: { ...authHeaders(), 'content-type': 'application/json' },
        body: '{}',
      })
      const j = (await r.json()) as { ok?: boolean; sent?: number; subscriptions?: number; webhooks?: number; error?: string }
      const total = (j.subscriptions ?? 0) + (j.webhooks ?? 0)
      if (r.ok && j.ok) {
        showToast(
          total === 0
            ? '尚无推送通道：先订阅或配置 webhook'
            : `测试通知已送达 ${j.sent}/${total} 个通道（订阅 ${j.subscriptions} · webhook ${j.webhooks}）`,
          total === 0 ? 'err' : 'ok',
        )
      } else {
        showToast(`发送失败：${j.error ?? r.status}`, 'err')
      }
    } catch {
      showToast('发送失败：网络错误', 'err')
    } finally {
      setPushTestBusy(false)
    }
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

  // 归档视图数据
  useEffect(() => {
    if (view !== 'archived') return
    fetchArchived()
      .then((r) => setArchived(r.entries))
      .catch(() => {})
  }, [view])

  const doArchive = (key: string) => {
    archiveSession(key)
      .then(() => {
        refresh()
        showToast('已放入回收站，可随时恢复', 'ok')
      })
      .catch((err) => showToast(String(err)))
  }
  const doRestore = (key: string) => {
    restoreSession(key)
      .then(() => fetchArchived().then((r) => setArchived(r.entries)))
      .then(() => {
        refresh()
        showToast('已恢复', 'ok')
      })
      .catch((err) => showToast(String(err)))
  }

  // 按项目目录分组（cwd 缺失时回退 slug）；分组时顺带记录该组的 git 分支
  const groups = useMemo(() => {
    const m = new Map<string, { list: SessionInfo[]; branch?: string }>()
    for (const s of sessions) {
      const g = s.cwd ?? s.slug
      let e = m.get(g)
      if (!e) m.set(g, (e = { list: [] }))
      e.list.push(s)
      e.branch ??= s.gitBranch
    }
    return m
  }, [sessions])

  const startNew = async (cwd: string, backend: 'claude' | 'codex') => {
    const { key, slug } = await createSession(cwd, backend)
    setPickerOpen(false)
    props.onSelect(makeSessionInfo({ key, slug, sessionId: 'new', cwd, backend, status: 'offline' }))
  }

  return (
    <div className="relative flex h-full flex-col text-ink">
      {/* 顶栏：悬浮磨砂横带，列表内容从其下方滚过 */}
      <header className="glass-bar absolute inset-x-0 top-0 z-20 flex items-center justify-between px-3.5 pb-2.5 pt-4">
        {/* 品牌标兼作主题切换：短按深浅互切，长按弹出三选（跟随系统/深色/浅色，lib/theme.ts）。
            切换纯 CSS 变量驱动，无需重渲染 */}
        <button
          type="button"
          title="切换深浅色（长按选择模式）"
          aria-label="切换深浅色，长按选择模式"
          className="ml-1 shrink-0 cursor-pointer text-ink transition-opacity select-none hover:opacity-70"
          onPointerDown={() => {
            themeLong.current = false
            window.clearTimeout(themeTimer.current)
            themeTimer.current = window.setTimeout(() => {
              themeLong.current = true
              setThemeMenuOpen(true)
            }, 500)
          }}
          onPointerUp={() => window.clearTimeout(themeTimer.current)}
          onPointerLeave={() => window.clearTimeout(themeTimer.current)}
          onPointerCancel={() => window.clearTimeout(themeTimer.current)}
          onContextMenu={(e) => e.preventDefault()}
          onClick={() => {
            // 长按松手也会派发 click，吞掉；只有干净短按才翻转深浅
            if (themeLong.current) {
              themeLong.current = false
              return
            }
            toggleTheme()
          }}
        >
          <AnyPlaneMark fullBleed className="h-6 w-6" />
        </button>
        <div className="flex items-center gap-2">
          <IconBtn
            title="通知设置"
            onClick={() => setNotifyMenuOpen((v) => !v)}
            active={notifyMenuOpen || notify || !!pushEndpoint}
            redDot={approvals.length > 0}
          >
            <BellIcon className="h-4 w-4" active={notify || !!pushEndpoint} />
          </IconBtn>
          <IconBtn
            title={view === 'archived' ? '返回会话列表' : '回收站'}
            active={view === 'archived'}
            onClick={() => setView((v) => (v === 'active' ? 'archived' : 'active'))}
          >
            <TrashIcon className="h-4 w-4" />
          </IconBtn>
          <IconBtn title="新会话" accent onClick={() => setPickerOpen(true)}>
            <PlusIcon className="h-4 w-4" />
          </IconBtn>
        </div>
      </header>
      {themeMenuOpen &&
        // portal 到 body：与通知菜单同理由（侧栏窄时防探出），位置锚定顶栏左下角
        createPortal(
          <>
            <div className="fixed inset-0 z-40" onClick={() => setThemeMenuOpen(false)} />
            <div className="fixed top-[56px] left-3 z-50 w-36 rounded-[14px] bg-surface2/85 p-1.5 shadow-[0_16px_40px_-12px_rgba(0,0,0,0.5)] backdrop-blur-xl">
              {(
                [
                  ['system', '跟随系统'],
                  ['dark', '深色模式'],
                  ['light', '浅色模式'],
                ] as [ThemeChoice, string][]
              ).map(([value, label]) => {
                const active = getThemeChoice() === value
                return (
                  <button
                    key={value}
                    className="flex w-full items-center gap-2 rounded-[10px] px-2.5 py-1.5 text-left text-xs hover:bg-surface"
                    onClick={() => {
                      setThemeChoice(value)
                      setThemeMenuOpen(false)
                    }}
                  >
                    <span
                      className={`h-1.5 w-1.5 shrink-0 rounded-full ${active ? 'bg-ink' : 'bg-transparent'}`}
                      aria-hidden="true"
                    />
                    <span className={active ? 'text-ink' : 'text-muted'}>{label}</span>
                  </button>
                )
              })}
            </div>
          </>,
          document.body,
        )}
      {notifyMenuOpen &&
        // portal 到 body + 从视口左边框起绘：侧栏很窄时绝对定位会探出屏幕左缘
        createPortal(
          <>
            {/* 点击空白处关闭 */}
            <div className="fixed inset-0 z-40" onClick={() => setNotifyMenuOpen(false)} />
            <div className="fixed left-2 right-2 top-2 z-50 mx-auto max-w-sm rounded-[14px] bg-surface2/85 p-2 shadow-[0_16px_40px_-12px_rgba(0,0,0,0.5)] backdrop-blur-xl">
              <div className="px-1 pb-1.5 font-mono text-[10px] tracking-widest text-faint uppercase">
                通知
              </div>
              {/* 页内通知：页面隐藏时用 Notification API */}
              <button
                className="flex w-full items-center gap-2 rounded-[10px] px-1.5 py-1.5 text-left hover:bg-surface"
                onClick={toggleNotify}
              >
                <NotifyRow
                  on={notify}
                  title="页内通知"
                  desc="页面在后台时弹桌面通知"
                  action={notify ? '开' : '关'}
                />
              </button>
              {/* Web Push：SW 离线可达，支持锁屏直接审批 */}
              <button
                className="flex w-full items-center gap-2 rounded-[10px] px-1.5 py-1.5 text-left hover:bg-surface disabled:opacity-50"
                onClick={togglePush}
                disabled={pushBusy || !pushSupported()}
              >
                <NotifyRow
                  on={!!pushEndpoint}
                  title={pushBusy ? '处理中…' : '推送通知'}
                  desc={
                    pushSupported()
                      ? pushEndpoint
                        ? '已订阅：锁屏可达，通知上可直接审批'
                        : '锁屏/杀掉页面也能收到，通知上可直接审批'
                      : '当前浏览器不支持（iOS 需先加到主屏幕）'
                  }
                  action={pushSupported() ? (pushEndpoint ? '退订' : '订阅') : undefined}
                />
              </button>
              {/* webhook 通道：配置文件管理（ntfy/Bark/Server酱），只读展示 */}
              <div className="flex w-full items-center gap-2 rounded-[10px] px-1.5 py-1.5">
                <NotifyRow
                  on={pushWebhooks > 0}
                  title="Webhook 通道"
                  desc={
                    pushWebhooks > 0
                      ? `已配置 ${pushWebhooks} 个（ntfy/Bark/Server酱）`
                      : '国内 Android 无 FCM 的出路，见 README 配置'
                  }
                  action={pushWebhooks > 0 ? `${pushWebhooks}` : undefined}
                />
              </div>
              {/* 通道自检：一键向全部通道发测试通知 */}
              <button
                className="flex w-full items-center gap-2 rounded-[10px] px-1.5 py-1.5 text-left hover:bg-surface disabled:opacity-50"
                onClick={sendTestPush}
                disabled={pushTestBusy}
              >
                <NotifyRow
                  on={false}
                  title={pushTestBusy ? '发送中…' : '测试通知'}
                  desc="向全部订阅与 webhook 通道各发一条"
                  action="发送"
                />
              </button>
            </div>
          </>,
          document.body,
        )}

      {/* 会话流：顶栏高 58px（pt-4 + 32 + pb-2.5）。顶部用占位 div 避让（不用容器 padding——
          否则分组头 sticky top 相对含 padding 的 scrollport 计算，会把分组头推过首行） */}
      <div className="flex-1 overflow-y-auto px-2 pb-3">
        <div className="h-[58px] shrink-0" aria-hidden />
        {view === 'archived' ? (
          <div>
            {archived.length === 0 && <p className="p-4 font-mono text-xs text-faint">回收站为空</p>}
            {archived.map((e) => (
              <div key={e.key} className="mx-1 mb-2 rounded-[14px] bg-surface p-3">
                <div className="flex items-center gap-2">
                  <span className="flex h-[15px] w-[15px] shrink-0 items-center justify-center overflow-hidden" aria-hidden="true">
                    {e.backend === 'codex' ? <CodexMark size={15} static /> : <ClaudeMark className="h-[15px] w-[15px]" />}
                  </span>
                  <span className="truncate text-sm">{e.title ?? e.lastPrompt?.slice(0, 30) ?? e.sessionId.slice(0, 8)}</span>
                  <span className="ml-auto shrink-0 font-mono text-[10px] text-faint">
                    {e.trashedAt ? timeAgo(Date.parse(e.trashedAt)) : e.mtime ? timeAgo(e.mtime) : ''}
                  </span>
                </div>
                <div className="mt-1.5 flex items-center gap-2 pl-6">
                  <span className="truncate font-mono text-[10px] text-faint">{e.cwd ?? e.slug}</span>
                  <button
                    className="ml-auto shrink-0 rounded-full bg-surface2 px-2.5 py-1 font-mono text-[10px] text-muted hover:text-ink"
                    onClick={() => doRestore(e.key)}
                  >
                    恢复
                  </button>
                </div>
              </div>
            ))}
          </div>
        ) : (
        <>
        {loading && <p className="p-4 font-mono text-xs text-faint">加载中…</p>}
        {!loading && sessions.length === 0 && (
          <div className="p-4 text-sm text-muted">
            <p>还没有会话。</p>
            <p className="mt-1 text-xs text-faint">点右上角 + 新建会话，从文件系统选择项目目录即可开始。</p>
          </div>
        )}
        {[...groups.entries()].map(([cwd, group]) => {
          const folded = collapsed.has(cwd)
          return (
          <div key={cwd}>
            <button
              type="button"
              aria-expanded={!folded}
              title={folded ? '展开分组' : '折叠分组'}
              className="glass-bar sticky top-[58px] z-10 flex w-full items-center gap-2 px-3 py-2 text-left text-muted"
              onClick={() => {
                setCollapsed((prev) => {
                  const next = new Set(prev)
                  if (next.has(cwd)) next.delete(cwd)
                  else next.add(cwd)
                  localStorage.setItem(COLLAPSE_KEY, JSON.stringify([...next]))
                  return next
                })
              }}
            >
              <svg
                className="h-3 w-3 shrink-0 text-[var(--caret)]"
                viewBox="0 0 8 8"
                aria-hidden="true"
              >
                {folded ? (
                  <path fill="currentColor" d="M2.2 1.2 L6.6 4 L2.2 6.8Z" />
                ) : (
                  <path fill="currentColor" d="M1.2 2.2 L6.8 2.2 L4 6.6Z" />
                )}
              </svg>
              <span className="truncate text-[15px] font-semibold" title={cwd}>{dirBasename(cwd)}</span>
              <span className="shrink-0 font-mono text-[11px] font-normal text-faint">{group.list.length}</span>
              {group.branch && (
                <span className="ml-auto flex shrink-0 items-center gap-1 font-mono text-[11px] font-normal text-faint">
                  <BranchIcon className="h-3 w-3" />
                  {group.branch}
                </span>
              )}
            </button>
            {!folded && group.list.map((s) => {
              const stKey = s.managed.waiting ? 'waiting' : s.managed.busy ? 'busy' : s.managed.spawned ? 'idle' : s.status
              const st = STATUS_META[stKey] ?? STATUS_META.offline
              const active = props.selectedKey === s.key
              const busyRow = stKey === 'busy'
              return (
                <div
                  key={s.key}
                  role="button"
                  tabIndex={0}
                  onClick={() => props.onSelect(s)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault()
                      props.onSelect(s)
                    }
                  }}
                  className={`group mx-1 mb-0.5 block w-[calc(100%-0.5rem)] cursor-pointer rounded-[14px] px-3 py-2.5 text-left transition-colors ${
                    busyRow ? 'wave-surface bg-surface' : 'hover:bg-surface'
                  } ${active ? 'bg-surface2' : ''}`}
                >
                  <div className="flex items-center gap-2.5">
                    <span className={`h-2 w-2 shrink-0 rounded-full ${st.cls}`} />
                    <span className="truncate text-[15px] font-semibold">{s.title ?? s.sessionId.slice(0, 8)}</span>
                    <span className="ml-auto shrink-0 font-mono text-[11px] text-faint">
                      {timeAgo(s.mtime)}
                    </span>
                    <button
                      type="button"
                      className="flex h-[18px] w-[18px] shrink-0 items-center justify-center overflow-hidden rounded-full transition-colors hover:bg-surface2"
                      title="更多操作"
                      aria-label={`会话操作：${s.title ?? s.sessionId.slice(0, 8)}`}
                      onClick={(e) => {
                        e.stopPropagation()
                        setMenu(menu?.session.key === s.key ? null : { session: s, anchor: e.currentTarget })
                      }}
                    >
                      {s.backend === 'codex' ? (
                        <CodexMark size={15} static />
                      ) : (
                        <ClaudeMark className="h-[15px] w-[15px]" />
                      )}
                    </button>
                  </div>
                  <div className="mt-1 flex items-center gap-1.5 pl-[18px] text-[12px]">
                    <span className={`shrink-0 font-medium ${stKey === 'waiting' ? 'text-accent' : 'text-muted'}`}>
                      {st.label}
                    </span>
                    {s.lastPrompt && (
                      <span className="truncate font-mono text-[11px] text-faint">{s.lastPrompt}</span>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
          )
        })}
        </>
        )}
      </div>

      {pickerOpen && (
        <DirPicker sessions={sessions} onStart={startNew} onClose={() => setPickerOpen(false)} />
      )}

      {/* 会话二级菜单：固定定位 + 玻璃子面板样式 */}
      <PopupPanel
        open={menu !== null}
        anchor={menu?.anchor ?? null}
        onClose={() => setMenu(null)}
        placement="bottom-end"
        offset={4}
        className="w-24"
      >
        <button
          type="button"
          role="menuitem"
          className="flex w-full items-center gap-2 rounded-[10px] px-3 py-2 text-left text-[12px] text-muted transition-colors hover:bg-surface hover:text-ink"
          onClick={() => {
            if (!menu) return
            setRenameTarget(menu)
            setMenu(null)
          }}
        >
          重命名
        </button>
        <button
          type="button"
          role="menuitem"
          className="flex w-full items-center gap-2 rounded-[10px] px-3 py-2 text-left text-[12px] text-muted transition-colors hover:bg-surface hover:text-accent"
          onClick={() => {
            if (!menu) return
            setArchiveTarget(menu)
            setMenu(null)
          }}
        >
          回收站
        </button>
      </PopupPanel>

      {/* 重命名弹窗 */}
      <PromptDialog
        open={renameTarget !== null}
        anchor={renameTarget?.anchor ?? null}
        title="重命名会话"
        initialValue={renameTarget?.session.title ?? renameTarget?.session.sessionId.slice(0, 8) ?? ''}
        onConfirm={(title) => {
          if (!renameTarget) return
          if (title.trim()) {
            renameSession(renameTarget.session.key, title.trim())
              .then(() => {
                refresh()
                showToast('已重命名', 'ok')
              })
              .catch((err) => showToast(String(err)))
          }
          setRenameTarget(null)
        }}
        onClose={() => setRenameTarget(null)}
      />

      {/* 回收站确认弹窗 */}
      <ConfirmDialog
        open={archiveTarget !== null}
        anchor={archiveTarget?.anchor ?? null}
        title="归档会话"
        message={`归档会话「${archiveTarget?.session.title ?? archiveTarget?.session.sessionId.slice(0, 8)}」？\n（进入回收站，随时可恢复）`}
        confirmLabel="归档"
        danger
        onConfirm={() => {
          if (!archiveTarget) return
          doArchive(archiveTarget.session.key)
          setArchiveTarget(null)
        }}
        onClose={() => setArchiveTarget(null)}
      />

      {/* 轻量提示（替代 alert）：portal 到 body，避免被祖先裁剪/遮挡 */}
      {toast &&
        createPortal(
          <div
            role="status"
            className={`fixed bottom-4 right-4 z-[60] max-w-xs rounded-full bg-surface2/85 px-4 py-2 text-xs shadow-lg backdrop-blur-xl ${
              toast.kind === 'ok' ? 'text-ok' : 'text-accent'
            }`}
          >
            {toast.text}
          </div>,
          document.body,
        )}
    </div>
  )
}
