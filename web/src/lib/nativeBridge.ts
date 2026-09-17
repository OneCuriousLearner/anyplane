// 原生壳（Capacitor）集成。hosted 模式：页面由用户服务端加载，Capacitor 桥由原生层
// 注入 window.Capacitor——仅在 isNativePlatform() 时激活，浏览器/PWA 路径零影响。
//
// 职责：
//  1. 自持 /ws/inbox 连接 → 审批事件落成带「批准/拒绝」按钮的本地通知。
//     Android v1 不依赖 FCM/厂商通道：壳活着期间由页面 WS 直接驱动（后台存活
//     增强——常驻服务——是后续项）。iOS 的后台送达必须走 APNs，另行接入。
//  2. 按钮裁决 → POST /api/approvals/resolve（Bearer 令牌，secret 不进通知载荷——
//     与能力 URL 模型同一条红线：载荷只有 key/requestId，凭据在客户端）。
//  3. 冷启动：进程已死时点通知，action 只会投递到本地引导页（app/www/index.html），
//     由它转成 ?nativeAction= query 带过来，本模块启动时消费（localStorage 跨源不共享，
//     不能走 localStorage 暂存）。

import { Capacitor } from '@capacitor/core'
import { postJson } from './api'
import { InboxSocket, type InboxEvent } from './inbox'
import { sessionHashUrl } from './sessionHash'

const ACTION_TYPE = 'APPROVAL'
const QUERY_PARAM = 'nativeAction'

export type NativeAction = { key: string; requestId: string; actionId: string }

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

export async function setupNativeBridge(): Promise<void> {
  if (!Capacitor.isNativePlatform()) return
  const { LocalNotifications } = await import('@capacitor/local-notifications')

  await LocalNotifications.registerActionTypes({
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

  const act = async (a: NativeAction): Promise<void> => {
    if (a.actionId === 'approve' || a.actionId === 'deny') {
      const r = await postJson('/api/approvals/resolve', {
        key: a.key,
        requestId: a.requestId,
        decision: a.actionId === 'approve' ? 'allow' : 'deny',
      }).catch(() => null)
      // 409 = 已在别处裁决（或上游已超时），静默；401 已由 api 层触发令牌页
      if (r && !r.ok && r.status !== 409) {
        await LocalNotifications.schedule({
          notifications: [{ id: notifId(a.requestId), title: '审批未送达', body: '请打开应用确认会话状态' }],
        }).catch(() => {})
      }
    } else {
      // 点通知正文：深链进对应会话（hash 路由接管，见 App.tsx）
      location.hash = sessionHashUrl(a.key)
    }
    await LocalNotifications.cancel({ notifications: [{ id: notifId(a.requestId) }] }).catch(() => {})
  }

  await LocalNotifications.addListener('localNotificationActionPerformed', (ev) => {
    const extra = ev.notification.extra as { key?: unknown; requestId?: unknown } | undefined
    if (typeof extra?.key !== 'string' || typeof extra.requestId !== 'string') return
    void act({ key: extra.key, requestId: extra.requestId, actionId: ev.actionId })
  })

  const cold = consumeNativeActionParam()
  if (cold) void act(cold)

  const perm = await LocalNotifications.requestPermissions()
  if (perm.display !== 'granted') return

  new InboxSocket((ev: InboxEvent) => {
    if (ev.type === 'approval') {
      void LocalNotifications.schedule({
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
      void LocalNotifications.cancel({ notifications: [{ id: notifId(ev.requestId) }] }).catch(() => {})
    }
  })
}
