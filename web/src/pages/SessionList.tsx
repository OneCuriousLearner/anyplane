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
import { ClaudeMark } from '../components/ClaudeMark'
import { CodexMark } from '../components/CodexMark'
import { ConfirmDialog, PromptDialog } from '../components/Dialogs'
import { PopupPanel } from '../components/PopupPanel'
import { DirPicker } from './DirPicker'

const STATUS_META: Record<SessionInfo['status'], { cls: string; label: string }> = {
  busy: { cls: 'bg-busy animate-pulse', label: '工作中' },
  idle: { cls: 'bg-ok', label: '空闲' },
  waiting: { cls: 'bg-wait', label: '等待输入' },
  offline: { cls: 'bg-faint', label: '离线' },
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

/** 桌面通知开关：localStorage 持久；浏览器授权后在页面隐藏时推送 */
const NOTIFY_KEY = 'cc-remote-notify'
/** 按项目目录折叠的分组，cwd 字符串数组 */
const COLLAPSE_KEY = 'cc-remote-collapsed-groups'

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
      new Notification(title, { body, tag: 'cc-remote-inbox' })
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
    <div className="flex h-full flex-col bg-surface text-ink">
      {/* 报头 */}
      <div className="border-b border-line bg-surface2 px-4 pb-3 pt-4">
        <div className="flex items-baseline justify-between">
          <h1 className="flex items-center gap-2 font-mono text-sm tracking-widest text-ink/80 uppercase">
            <ClaudeMark className="h-4 w-4" />
            cc-remote
          </h1>
          <div className="flex items-center gap-2">
            <div>
              <button
                className={`relative flex items-center rounded border px-2 py-1 ${
                  notify || pushEndpoint ? 'border-accent/60 text-accent-soft' : 'border-line text-faint'
                }`}
                title="通知设置"
                onClick={() => setNotifyMenuOpen((v) => !v)}
              >
                <BellIcon className="h-3.5 w-3.5" active={notify || !!pushEndpoint} />
                {approvals.length > 0 && (
                  <span className="absolute -right-1.5 -top-1.5 rounded-full bg-danger px-1 text-[9px] leading-4 text-white">
                    {approvals.length}
                  </span>
                )}
              </button>
              {notifyMenuOpen &&
                // portal 到 body + 从视口左边框起绘：侧栏很窄时绝对定位会探出屏幕左缘
                createPortal(
                  <>
                    {/* 点击空白处关闭 */}
                    <div className="fixed inset-0 z-40" onClick={() => setNotifyMenuOpen(false)} />
                    <div className="fixed left-2 right-2 top-2 z-50 mx-auto max-w-sm rounded-md border border-line bg-surface p-2 shadow-xl">
                    <div className="px-1 pb-1.5 font-mono text-[10px] tracking-widest text-faint uppercase">
                      通知
                    </div>
                    {/* 页内通知：页面隐藏时用 Notification API */}
                    <button
                      className="flex w-full items-center gap-2 rounded px-1.5 py-1.5 text-left hover:bg-surface2"
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
                      className="flex w-full items-center gap-2 rounded px-1.5 py-1.5 text-left hover:bg-surface2 disabled:opacity-50"
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
                    <div className="flex w-full items-center gap-2 rounded px-1.5 py-1.5">
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
                      className="flex w-full items-center gap-2 rounded px-1.5 py-1.5 text-left hover:bg-surface2 disabled:opacity-50"
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
            </div>
            <button
              className="rounded border border-accent/60 px-2.5 py-1 font-mono text-xs text-accent-soft hover:bg-accent/10"
              onClick={() => setPickerOpen(true)}
            >
              + 新会话
            </button>
          </div>
        </div>
        <p className="mt-1 text-xs text-muted">Claude Code Claw</p>
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
        {view === 'archived' ? (
          <div className="p-2">
            {archived.length === 0 && <p className="p-4 font-mono text-xs text-faint">回收站为空</p>}
            {archived.map((e) => (
              <div key={e.key} className="mb-2 rounded border border-line bg-surface2/40 p-3">
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
                    className="ml-auto shrink-0 rounded border border-line px-2 py-0.5 font-mono text-[10px] text-muted hover:bg-surface2 hover:text-ink"
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
            <p className="mt-1 text-xs text-faint">点「+ 新会话」，从文件系统选择项目目录即可开始。</p>
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
              className="sticky top-0 z-10 flex w-full items-center gap-2 border-y border-line/60 bg-surface2/95 px-4 py-1.5 text-left font-mono text-[11px] tracking-wide text-ink/70 backdrop-blur hover:bg-surface2"
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
              <span className="w-3 shrink-0 text-muted">{folded ? '▸' : '▾'}</span>
              <span className="truncate">{cwd}</span>
              {group.branch && <span className="ml-auto shrink-0 text-muted">⎇ {group.branch}</span>}
            </button>
            {!folded && group.list.map((s) => {
              const st =
                STATUS_META[
                  s.managed.waiting ? 'waiting' : s.managed.busy ? 'busy' : s.managed.spawned ? 'idle' : s.status
                ] ?? STATUS_META.offline
              const active = props.selectedKey === s.key
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
                  className={`group block w-full cursor-pointer border-b border-line/40 px-4 py-3 text-left transition-colors hover:bg-surface2/60 ${
                    active ? 'bg-surface2/80 shadow-[inset_2px_0_0_var(--color-accent)]' : ''
                  }`}
                >
                  <div className="flex items-center gap-2">
                    <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${st.cls}`} />
                    <span className="truncate text-sm">{s.title ?? s.sessionId.slice(0, 8)}</span>
                    <span className="ml-auto shrink-0 font-mono text-[10px] text-faint">
                      {timeAgo(s.mtime)}
                    </span>
                    <button
                      type="button"
                      className="flex h-[15px] w-[15px] shrink-0 items-center justify-center overflow-hidden rounded transition-colors hover:bg-surface2"
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
                  <div className="mt-1 flex items-center gap-1.5 pl-3.5 font-mono text-[11px] text-faint">
                    <span className="shrink-0">{st.label}</span>
                    {s.lastPrompt && (
                      <>
                        <span className="text-line">│</span>
                        <span className="truncate">{s.lastPrompt}</span>
                      </>
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

      {/* 底栏：活跃 / 回收站切换 */}
      <div className="flex border-t border-line font-mono text-[11px]">
        {(['active', 'archived'] as const).map((v) => (
          <button
            key={v}
            className={`flex-1 py-2 ${view === v ? 'bg-surface2 text-ink' : 'text-faint hover:text-muted'}`}
            onClick={() => setView(v)}
          >
            {v === 'active' ? '会话' : '回收站'}
          </button>
        ))}
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
          className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-[12px] text-muted transition-colors hover:bg-surface2/60 hover:text-ink"
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
          className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-[12px] text-muted transition-colors hover:bg-surface2/60 hover:text-danger"
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
            className={`fixed bottom-4 right-4 z-[60] max-w-xs rounded-md border px-3 py-2 text-xs shadow-lg ${
              toast.kind === 'ok'
                ? 'border-ok/50 bg-surface2 text-ok'
                : 'border-danger/50 bg-surface2 text-danger'
            }`}
          >
            {toast.text}
          </div>,
          document.body,
        )}
    </div>
  )
}
