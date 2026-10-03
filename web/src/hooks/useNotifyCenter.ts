// 通知中心域：桌面通知开关、Web Push 订阅、webhook 通道数、测试通知、审批收件箱订阅、
// 标题角标、原生桥电池豁免入口。2026-10-03 complexity-patrol 轮从 pages/SessionList.tsx
// 逐字切出——该域自带变更节律（推送/权限反馈/原生桥），与会话列表核心互不渗透；
// 页面只经返回面接线（铃铛按钮 + NotifyMenu + 红点），零行为改动。

import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { InboxApproval } from '@anyplane/protocol'
import { apiFetch, postJson } from '../lib/api'
import { inboxSubscribe } from '../lib/inboxBus'
import {
  getNativeBridgeStatus,
  requestBatteryExemptionNav,
  subscribeNativeBridge,
} from '../lib/nativeBridge'
import { currentPushEndpoint, subscribePush, unsubscribePush } from '../lib/push'

/** 桌面通知开关：localStorage 持久；浏览器授权后在页面隐藏时推送 */
const NOTIFY_KEY = 'anyplane-notify'

export function useNotifyCenter(deps: {
  /** 轻量错误提示（替代 alert）：通知域各动作的人话反馈出口 */
  showToast: (text: string, kind?: 'ok' | 'err') => void
  /** 会话标题解析（通知文案用） */
  titleOf: (key: string) => string
}) {
  const [approvals, setApprovals] = useState<InboxApproval[]>([])
  const [notify, setNotify] = useState(() => localStorage.getItem(NOTIFY_KEY) === '1')
  /** 推送订阅状态：已订阅时为 push service endpoint */
  const [pushEndpoint, setPushEndpoint] = useState<string | null>(null)
  /** 服务端配置的 webhook 通道数（ntfy/Bark/Server酱，配置文件管理，只读展示） */
  const [pushWebhooks, setPushWebhooks] = useState(0)
  /** 测试通知发送中 */
  const [pushTestBusy, setPushTestBusy] = useState(false)
  const [pushBusy, setPushBusy] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const nativeBridge = useSyncExternalStore(subscribeNativeBridge, getNativeBridgeStatus)
  const nativeAndroid = nativeBridge.active && nativeBridge.platform === 'android'

  const notifyRef = useRef(notify)
  notifyRef.current = notify
  /** deps 的 ref 桥：收件箱订阅是 [] effect（单例总线只订一次），回调要读最新 deps */
  const depsRef = useRef(deps)
  depsRef.current = deps

  const pushNotify = (title: string, body: string) => {
    if (!notifyRef.current || !('Notification' in window)) return
    if (Notification.permission !== 'granted' || !document.hidden) return
    try {
      new Notification(title, { body, tag: 'anyplane-inbox' })
    } catch {}
  }

  // 全局收件箱：审批队列 + 完成/错误通知（单例总线，与原生桥共用一条连接）
  useEffect(() => {
    const unsubscribe = inboxSubscribe((ev) => {
      const { titleOf } = depsRef.current
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
    const { showToast } = depsRef.current
    if (notify) {
      setNotify(false)
      localStorage.setItem(NOTIFY_KEY, '0')
      return
    }
    if (!('Notification' in window)) {
      showToast('当前浏览器不支持桌面通知')
      return
    }
    // 权限被拒/挂起都要给人话反馈——静默停在「关」会以为开关坏了（走查问题 7）
    if (Notification.permission === 'denied') {
      showToast('浏览器拒绝了通知权限，请到地址栏站点设置开启')
      return
    }
    if (Notification.permission === 'default') {
      const result = await Notification.requestPermission().catch(() => 'denied' as const)
      if (result !== 'granted') {
        showToast('通知权限未开启（浏览器弹窗中被拒或关闭），可到地址栏站点设置修改')
        return
      }
    }
    setNotify(true)
    localStorage.setItem(NOTIFY_KEY, '1')
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
    const { showToast } = depsRef.current
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
    const { showToast } = depsRef.current
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

  /** 原生壳电池豁免引导（仅 Android 壳显示该入口）；收浮层与页内其他浮层同纪律 */
  const requestBattery = () => {
    requestBatteryExemptionNav()
    setMenuOpen(false)
  }

  return {
    approvals,
    menuOpen,
    setMenuOpen,
    notify,
    pushEndpoint,
    pushBusy,
    pushWebhooks,
    pushTestBusy,
    nativeAndroid,
    /** 铃铛高亮口径：页内通知开 或 已订阅推送（按钮 active 与 BellIcon 共用） */
    bellActive: notify || pushEndpoint !== null,
    toggleNotify,
    togglePush,
    sendTestPush,
    requestBattery,
  }
}
