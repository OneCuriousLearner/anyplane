import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import type { ArchivedEntry, BackendName, InboxApproval, SessionInfo } from '@anyplane/protocol'
import {
  apiFetch,
  archiveSession,
  createSession,
  fetchArchived,
  fetchSessions,
  makeSessionInfo,
  postJson,
  restoreSession,
} from '../lib/api'
import { inboxSubscribe } from '../lib/inboxBus'
import { currentPushEndpoint, pushSupported, subscribePush, unsubscribePush } from '../lib/push'
import { BellIcon } from '../components/BellIcon'
import { AnyPlaneMark } from '../components/AnyPlaneMark'
import { BackendStatusCard } from '../components/BackendStatusCard'
import { NativeNotifyBanner } from '../components/NativeNotifyBanner'
import {
  getNativeBridgeStatus,
  requestBatteryExemptionNav,
  subscribeNativeBridge,
} from '../lib/nativeBridge'
import { getThemeChoice, setThemeChoice, toggleTheme, type ThemeChoice } from '../lib/theme'
import { ClaudeMark } from '../components/ClaudeMark'
import { CodexMark } from '../components/CodexMark'
import { NotifyMenu } from '../components/NotifyMenu'
import { SessionGroupList } from '../components/SessionGroupList'
import { SessionRowMenu, type SessionMenuAnchor } from '../components/SessionRowMenu'
import { IconBtn, PlusIcon, timeAgo, TrashIcon } from '../components/listChrome'
import { DirPicker } from './DirPicker'

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
  /** 轮询发现选中行的更新字段（AI 标题/改名）时上报，由 App 合并回选中快照 */
  onSyncSelected?: (s: SessionInfo) => void
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
  const nativeBridge = useSyncExternalStore(subscribeNativeBridge, getNativeBridgeStatus)
  const nativeAndroid = nativeBridge.active && nativeBridge.platform === 'android'
  // 主题长按菜单：timer 计时 500ms 长按，long 标记吞掉随后那次 click
  const [themeMenuOpen, setThemeMenuOpen] = useState(false)
  const themeTimer = useRef<number | undefined>(undefined)
  const themeLong = useRef(false)
  const [view, setView] = useState<'active' | 'archived'>('active')
  const [archived, setArchived] = useState<ArchivedEntry[]>([])
  const [collapsed, setCollapsed] = useState(loadCollapsed)
  /** 二级菜单：打开的会话 + 锚点元素；null 表示无 */
  const [menu, setMenu] = useState<SessionMenuAnchor | null>(null)
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

  // 全局收件箱：审批队列 + 完成/错误通知（单例总线，与原生桥共用一条连接）
  useEffect(() => {
    const unsubscribe = inboxSubscribe((ev) => {
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
    return unsubscribe
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
    apiFetch('/api/push/public-key')
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
      const r = await postJson('/api/push/test', {})
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

  /** 轮询在途守卫：服务端偶发慢响应（>10s）时，上一个请求未回来新周期又发出——
   *  慢的旧响应后至会把新列表覆盖成旧快照（刚建的会话瞬消失/归档的会话瞬复活）。
   *  超时兜底必须有：裸 fetch 无 AbortSignal，挂死的响应（TCP 不返回）会让守卫
   *  卡死、轮询与手动刷新全部静默停摆——race 超时即可复位（底层 fetch 随它去） */
  const refreshingRef = useRef(false)
  /** 选中项同步的 ref 桥：10s interval 闭包捕获的是首轮 props，key 与回调都要读最新 */
  const syncRef = useRef<{ key?: string; cb?: (s: SessionInfo) => void }>({})
  syncRef.current = { key: props.selectedKey, cb: props.onSyncSelected }
  const refresh = () => {
    if (refreshingRef.current) return
    refreshingRef.current = true
    const timeout = new Promise<never>((_, rej) => setTimeout(() => rej(new Error('refresh timeout')), 15_000))
    Promise.race([fetchSessions(), timeout])
      .then((list) => {
        setSessions(list)
        // 选中行的标题变化（AI 标题落盘 / /rename）借轮询写回顶栏——
        // selected 是点进去那一刻的快照，不同步的话标题永远定格
        const { key, cb } = syncRef.current
        const cur = key ? list.find((s) => s.key === key) : undefined
        if (cur && cb) cb(cur)
      })
      .catch(() => {}) // 401 由 App 令牌门接管；超时下一轮重试
      .finally(() => {
        refreshingRef.current = false
        setLoading(false)
      })
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

  // 按项目目录分组（cwd 缺失时回退 slug）；分组时顺带记录该组的 git 分支与 worktree 归属
  const groups = useMemo(() => {
    const m = new Map<string, { list: SessionInfo[]; branch?: string; worktreeOf?: string }>()
    for (const s of sessions) {
      const g = s.cwd ?? s.slug
      let e = m.get(g)
      if (!e) m.set(g, (e = { list: [] }))
      e.list.push(s)
      e.branch ??= s.gitBranch
      e.worktreeOf ??= s.worktreeOf
    }
    return m
  }, [sessions])

  const startNew = async (cwd: string, backend: BackendName) => {
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
                  <button type="button"
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
      <NotifyMenu
        open={notifyMenuOpen}
        onClose={() => setNotifyMenuOpen(false)}
        notify={notify}
        onToggleNotify={() => void toggleNotify()}
        pushSupported={pushSupported()}
        pushEndpoint={pushEndpoint}
        pushBusy={pushBusy}
        onTogglePush={() => void togglePush()}
        nativeAndroid={nativeAndroid}
        onBattery={() => {
          requestBatteryExemptionNav()
          setNotifyMenuOpen(false)
        }}
        pushWebhooks={pushWebhooks}
        pushTestBusy={pushTestBusy}
        onTestPush={() => void sendTestPush()}
      />

      {/* 会话流：顶栏高 58px（pt-4 + 32 + pb-2.5）。顶部用占位 div 避让（不用容器 padding——
          否则分组头 sticky top 相对含 padding 的 scrollport 计算，会把分组头推过首行） */}
      <div className="flex-1 overflow-y-auto px-2 pb-3">
        <div className="h-[58px] shrink-0" aria-hidden />
        {/* 原生壳权限/桥异常横幅（浏览器渲染 null）。必须在滚动流内、顶栏占位之后：
            顶栏是 absolute 悬浮层，横幅放它外面会被压住并把列表整体下顶（实机踩坑） */}
        <NativeNotifyBanner />
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
                  <button type="button"
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
        {/* 登录状态卡：双后端都可用时自隐藏；空列表（首次上手）常显 */}
        <BackendStatusCard alwaysShow={!loading && sessions.length === 0} />
        {loading && <p className="p-4 font-mono text-xs text-faint">加载中…</p>}
        {!loading && sessions.length === 0 && (
          <div className="p-4 text-sm text-muted">
            <p>还没有会话。</p>
            <p className="mt-1 text-xs text-faint">点右上角 + 新建会话，从文件系统选择项目目录即可开始。</p>
          </div>
        )}
        <SessionGroupList
          groups={groups}
          collapsed={collapsed}
          onToggleCollapse={(cwd) => {
            setCollapsed((prev) => {
              const next = new Set(prev)
              if (next.has(cwd)) next.delete(cwd)
              else next.add(cwd)
              localStorage.setItem(COLLAPSE_KEY, JSON.stringify([...next]))
              return next
            })
          }}
          selectedKey={props.selectedKey}
          onSelect={props.onSelect}
          menuKey={menu?.session.key ?? null}
          onMenu={setMenu}
        />
        </>
        )}
      </div>

      {pickerOpen && (
        <DirPicker sessions={sessions} onStart={startNew} onClose={() => setPickerOpen(false)} />
      )}

      <SessionRowMenu
        menu={menu}
        onClose={() => setMenu(null)}
        onRenamed={refresh}
        onArchive={doArchive}
        showToast={showToast}
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
