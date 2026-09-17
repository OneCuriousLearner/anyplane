// 原生壳（Capacitor）集成。hosted 模式：页面由用户服务端加载，Capacitor 桥由原生层
// 注入 window.Capacitor——仅在 isNativePlatform() 时激活，浏览器/PWA 路径零影响。
//
// 职责：
//  1. 通知生产权：Android 在场时交给原生常驻服务（ApprovalService 自持 /ws/inbox，
//     WebView 挂起后 JS 停摆，页面驱动在锁屏下不可靠——实机实测）；iOS/旧壳退回
//     页面自持 WS + LocalNotifications（APNs 接入前的前台兜底）。
//  2. 按钮裁决 → POST /api/approvals/resolve（Bearer 令牌，secret 不进通知载荷——
//     与能力 URL 模型同一条红线：载荷只有 key/requestId，凭据在客户端）。
//  3. 冷启动接力按通知来源分两路：原生通知点正文 → MainActivity extras →
//     consumePendingOpen；LocalNotifications 插件通知 → 引导页捕获 → ?nativeAction=
//     query（localStorage 跨源不共享，不能走 localStorage 暂存）。
//  4. 状态外置（getNativeBridgeStatus）：权限被拒/桥异常绝不再静默死——SessionList
//     的横幅靠它给出可操作的出口。实机教训：POST_NOTIFICATIONS 未授予时整条链路
//     零可见迹象。

import { Capacitor, registerPlugin } from '@capacitor/core'
import type { LocalNotificationsPlugin } from '@capacitor/local-notifications'
import { postJson } from './api'
import { getToken } from './auth'
import { InboxSocket, type InboxEvent } from './inbox'
import { sessionHashUrl } from './sessionHash'

const ACTION_TYPE = 'APPROVAL'
const QUERY_PARAM = 'nativeAction'

export type NativeAction = { key: string; requestId: string; actionId: string }

/** app/android 侧的 AnyPlaneBridge 插件（自研，非 npm 插件） */
interface AnyPlaneBridgePlugin {
  configure(opts: { serverUrl: string; token: string }): Promise<{ ok: boolean }>
  disable(): Promise<void>
  /** 取走「点通知正文」暂存在原生层的会话 key（点批准/拒绝不经过这里） */
  consumePendingOpen(): Promise<{ key?: string }>
  /** 权限被永久拒绝时的出口：跳本应用系统通知设置页 */
  openNotificationSettings(): Promise<void>
}

// ---------------------------------------------------------------------------
// 状态外置：横幅 UI 的唯一事实源

export type NativeBridgeStatus = {
  /** 是否在原生壳内 */
  active: boolean
  /** 通知权限（unknown=尚未查询） */
  permission: 'unknown' | 'granted' | 'prompt' | 'prompt-with-rationale' | 'denied'
  /** 通知生产权在谁手里 */
  service: 'off' | 'plugin' | 'js-fallback'
  /** 桥初始化异常（如旧缓存包导致动态 import 失败）；null = 正常 */
  error: string | null
}

let status: NativeBridgeStatus = { active: false, permission: 'unknown', service: 'off', error: null }
const listeners = new Set<() => void>()

function setStatus(patch: Partial<NativeBridgeStatus>): void {
  status = { ...status, ...patch }
  listeners.forEach((l) => l())
}

export function getNativeBridgeStatus(): NativeBridgeStatus {
  return status
}

export function subscribeNativeBridge(l: () => void): () => void {
  listeners.add(l)
  return () => listeners.delete(l)
}

// ---------------------------------------------------------------------------

/** LocalNotifications 的 id 必须是 int32：requestId 做 FNV-1a 折叠 */
export function notifId(requestId: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < requestId.length; i++) {
    h ^= requestId.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h & 0x7fffffff
}

function summarizeInput(input: unknown): string {
  const s = typeof input === 'string' ? input : JSON.stringify(input) ?? ''
  return s.length > 120 ? s.slice(0, 120) + '…' : s
}

/** 解析引导页经 query 带过云的冷启动 action（纯函数，便于测试） */
export function parseNativeAction(raw: string | null): NativeAction | null {
  if (!raw) return null
  try {
    const a = JSON.parse(raw) as NativeAction
    if (typeof a.key === 'string' && typeof a.requestId === 'string' && typeof a.actionId === 'string') return a
  } catch {
    // 坏参数按无 action 处理
  }
  return null
}

/** 读取并清除引导页经 query 带过云的冷启动 action */
export function consumeNativeActionParam(): NativeAction | null {
  const url = new URL(location.href)
  const parsed = parseNativeAction(url.searchParams.get(QUERY_PARAM))
  if (parsed) {
    url.searchParams.delete(QUERY_PARAM)
    history.replaceState(null, '', url.pathname + url.search + url.hash)
  }
  return parsed
}

// ---------------------------------------------------------------------------
// 初始化（分两段：setupNativeBridge 一次性装载；continueNativeSetup 可在权限补授后续跑）

let LN: LocalNotificationsPlugin | null = null
let setupStage: 'none' | 'ready' | 'done' = 'none'

async function act(a: NativeAction): Promise<void> {
  if (a.actionId === 'approve' || a.actionId === 'deny') {
    const r = await postJson('/api/approvals/resolve', {
      key: a.key,
      requestId: a.requestId,
      decision: a.actionId === 'approve' ? 'allow' : 'deny',
    }).catch(() => null)
    // 409 = 已在别处裁决（或上游已超时），静默；401 已由 api 层触发令牌页
    if (r && !r.ok && r.status !== 409) {
      await LN?.schedule({
        notifications: [{ id: notifId(a.requestId), title: '审批未送达', body: '请打开应用确认会话状态' }],
      }).catch(() => {})
    }
  } else {
    // 点通知正文：深链进对应会话（hash 路由接管，见 App.tsx）
    location.hash = sessionHashUrl(a.key)
  }
  await LN?.cancel({ notifications: [{ id: notifId(a.requestId) }] }).catch(() => {})
}

/** 权限补授后的续跑（横幅按钮路径） */
async function continueNativeSetup(): Promise<void> {
  if (!LN || setupStage === 'done') return
  const perm = await LN.requestPermissions()
  setStatus({ permission: perm.display })

  // Android 原生常驻服务在场时让权（见文件头职责 1）
  if (Capacitor.isPluginAvailable('AnyPlaneBridge')) {
    const bridge = registerPlugin<AnyPlaneBridgePlugin>('AnyPlaneBridge')
    const sync = async (): Promise<void> => {
      await bridge.configure({ serverUrl: location.origin, token: getToken() ?? '' })
      const pending = await bridge.consumePendingOpen()
      if (pending.key) location.hash = sessionHashUrl(pending.key)
    }
    await sync()
    // 回前台时重同步：捡起登录态变化（重登录换 token）与等待中的深链
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') void sync()
    })
    setupStage = 'done'
    setStatus({ service: 'plugin' })
    return
  }

  if (perm.display !== 'granted') return
  setupStage = 'done'
  setStatus({ service: 'js-fallback' })
  new InboxSocket((ev: InboxEvent) => {
    if (ev.type === 'approval') {
      void LN?.schedule({
        notifications: [
          {
            id: notifId(ev.requestId),
            title: `审批 · ${ev.toolName}`,
            body: summarizeInput(ev.input),
            actionTypeId: ACTION_TYPE,
            extra: { key: ev.key, requestId: ev.requestId },
          },
        ],
      }).catch(() => {})
    } else if (ev.type === 'approval_resolved') {
      // 在别处（其他设备/规则引擎/会话内）已裁决：清掉本机通知
      void LN?.cancel({ notifications: [{ id: notifId(ev.requestId) }] }).catch(() => {})
    }
  })
}

export async function setupNativeBridge(): Promise<void> {
  // 冷启动 action 接力：?nativeAction= 只可能由壳内引导页注入，但消费与平台无关——
  // 浏览器里同样成立，让这条链路可被 chrome-devtools 直接回归
  const cold = consumeNativeActionParam()
  if (cold) void act(cold)

  if (!Capacitor.isNativePlatform()) return
  setStatus({ active: true })
  try {
    // 动态 import 失败的最典型原因是旧缓存 index.html 引用已不存在的块（实机踩坑），
    // 之前这会无声地杀掉整个桥——现在进状态条
    LN = await import('@capacitor/local-notifications')
      .then((m) => m.LocalNotifications)
      .catch(() => null)
    if (!LN) {
      setStatus({ error: '通知组件加载失败：可能是应用缓存了旧页面，请彻底关闭应用重进' })
      return
    }

    await LN.registerActionTypes({
      types: [
        {
          id: ACTION_TYPE,
          actions: [
            // foreground:false —— 按钮在后台直接裁决，不把 app 拉到前台
            { id: 'approve', title: '批准', foreground: false },
            { id: 'deny', title: '拒绝', foreground: false, destructive: true },
          ],
        },
      ],
    })

    await LN.addListener('localNotificationActionPerformed', (ev) => {
      const extra = ev.notification.extra as { key?: unknown; requestId?: unknown } | undefined
      if (typeof extra?.key !== 'string' || typeof extra.requestId !== 'string') return
      void act({ key: extra.key, requestId: extra.requestId, actionId: ev.actionId })
    })

    setupStage = 'ready'
    await continueNativeSetup()
  } catch (e) {
    setStatus({ error: `原生桥初始化失败：${e instanceof Error ? e.message : String(e)}` })
  }
}

/** 横幅「去开启」按钮：重问一次权限；被永久拒绝（返回 denied 且不再弹窗）时跳系统设置页 */
export async function requestNativeNotificationPermission(): Promise<void> {
  if (!LN) return
  const before = (await LN.checkPermissions()).display
  const perm = await LN.requestPermissions()
  setStatus({ permission: perm.display })
  if (perm.display === 'granted') {
    await continueNativeSetup()
    return
  }
  // 已经问过且仍拒绝：再调 requestPermissions 也不会弹了，直接送设置页
  if (before === 'denied' && Capacitor.isPluginAvailable('AnyPlaneBridge')) {
    await registerPlugin<AnyPlaneBridgePlugin>('AnyPlaneBridge').openNotificationSettings()
  }
}
