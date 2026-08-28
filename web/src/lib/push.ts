// Web Push 订阅管理：订阅/退订/状态查询
// 密钥流：服务端 VAPID 公钥 → pushManager.subscribe → 订阅对象 POST 回服务端注册表

import { apiFetch, apiError } from './api'

/** 当前浏览器是否支持推送（Service Worker + Push API + 通知） */
export function pushSupported(): boolean {
  return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window
}

function urlBase64ToUint8Array(base64: string): Uint8Array {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4)
  const b64 = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/')
  const raw = atob(b64)
  const out = new Uint8Array(raw.length)
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i)
  return out
}

/** 查询当前订阅状态（已订阅返回 endpoint，未订阅/不支持返回 null） */
export async function currentPushEndpoint(): Promise<string | null> {
  if (!pushSupported()) return null
  try {
    const reg = await navigator.serviceWorker.ready
    const sub = await reg.pushManager.getSubscription()
    return sub?.endpoint ?? null
  } catch {
    return null
  }
}

/** 订阅推送：请求通知权限 → 向 push service 订阅 → 注册到服务端。 */
export async function subscribePush(): Promise<{ ok: boolean; error?: string }> {
  if (!pushSupported()) return { ok: false, error: '当前浏览器不支持推送（iOS 需先把 App 加到主屏幕）' }
  try {
    const perm = await Notification.requestPermission()
    if (perm !== 'granted') return { ok: false, error: '通知权限被拒绝' }
    const pkResp = await apiFetch('/api/push/public-key')
    if (!pkResp.ok) return { ok: false, error: `获取推送公钥失败（HTTP ${pkResp.status}）` }
    const { publicKey } = (await pkResp.json()) as { publicKey: string }
    const reg = await navigator.serviceWorker.ready
    const sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(publicKey) as BufferSource,
    })
    const json = sub.toJSON() as { endpoint?: string; keys?: { p256dh: string; auth: string } }
    const r = await apiFetch('/api/push/subscriptions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ endpoint: json.endpoint, keys: json.keys }),
    })
    if (!r.ok) {
      const err = await apiError(r).catch(() => new Error(`HTTP ${r.status}`))
      return { ok: false, error: `注册订阅失败：${err.message}` }
    }
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

/** 退订：先退 push service，再从服务端注册表摘除 */
export async function unsubscribePush(): Promise<void> {
  if (!pushSupported()) return
  try {
    const reg = await navigator.serviceWorker.ready
    const sub = await reg.pushManager.getSubscription()
    if (!sub) return
    const endpoint = sub.endpoint
    await sub.unsubscribe().catch(() => {})
    await apiFetch('/api/push/subscriptions', {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ endpoint }),
    }).catch(() => {})
  } catch {}
}
