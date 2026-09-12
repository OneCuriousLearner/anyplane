// service worker：PWA 可安装性 + Web Push 接收与点击。
// 不做离线缓存——数据面全部走网络，缓存陈旧数据只会误导。
self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()))
self.addEventListener('fetch', () => {})

// ---------- Web Push ----------

/** 通知按钮可用性。Safari（iOS 与 macOS）完全忽略 actions 数组，Firefox 桌面 152 之前同样不支持，
 *  两者都不实现 Notification.maxActions——探测不到就按「没有按钮」走降级路径。
 *  不能靠 UA 判断：这是能力差异，且 iOS 上任何浏览器壳都是 WebKit。 */
function maxActions() {
  const n = self.Notification
  return n && typeof n.maxActions === 'number' ? n.maxActions : 0
}

/** 降级落点：把审批能力 URL 换成同 secret 的 GET 确认页（服务端 validSecret 同时认订阅密钥与
 *  webhook 密钥，故无需服务端改动）。GET 只渲染不执行，链接被预览抓取也不会误触裁决。 */
function approvalPageUrl(actions) {
  if (!actions || !actions.allow) return undefined
  try {
    const u = new URL(actions.allow, self.location.origin)
    const k = u.searchParams.get('k') || ''
    const r = u.searchParams.get('r') || ''
    const s = u.searchParams.get('s') || ''
    if (!k || !r || !s) return undefined
    return `/api/approval-page?k=${encodeURIComponent(k)}&r=${encodeURIComponent(r)}&s=${encodeURIComponent(s)}`
  } catch {
    return undefined
  }
}

// payload 形状见 server/src/push.ts 的 PushPayload
self.addEventListener('push', (e) => {
  if (!e.data) return
  let p
  try {
    p = e.data.json()
  } catch {
    return
  }
  const isApproval = p.type === 'approval' && !!p.actions
  const canAct = isApproval && maxActions() >= 2
  const page = isApproval && !canAct ? approvalPageUrl(p.actions) : undefined
  const opts = {
    // 无按钮时把裁决入口折进正文——否则 iOS 用户只看到「需要审批」却找不到怎么批
    body: page ? `${p.body ?? ''}\n（点击本通知前往审批）` : (p.body ?? ''),
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    tag: p.tag ?? `ccr-${Date.now()}`,
    renotify: p.type === 'approval',
    requireInteraction: p.type === 'approval', // 审批通知常驻直到用户处理（Safari 忽略，由系统托管）
    data: { key: p.key, requestId: p.requestId, actions: p.actions, page },
    // 审批通知带直接裁决按钮（通知栏上完成审批，不打开页面）
    actions: canAct
      ? [
          { action: 'allow', title: '✓ 允许' },
          { action: 'deny', title: '✗ 拒绝' },
        ]
      : [],
  }
  e.waitUntil(self.registration.showNotification(p.title ?? 'AnyPlane', opts))
})

self.addEventListener('notificationclick', (e) => {
  const data = e.notification.data ?? {}
  e.notification.close()

  // 直接审批：action 按钮携带能力 URL，SW 同源 POST 完成裁决
  const actionUrl = e.action === 'allow' ? data.actions?.allow : e.action === 'deny' ? data.actions?.deny : undefined
  if (actionUrl) {
    e.waitUntil(
      fetch(actionUrl, { method: 'POST' })
        .then((r) => r.json())
        .then((r) => {
          if (!r.ok) {
            return self.registration.showNotification('审批未生效', {
              body: String(r.error ?? '该审批可能已在别处处理'),
              icon: '/icon-192.png',
              tag: 'ccr-action-failed',
            })
          }
        })
        .catch(() => {}),
    )
    return
  }

  // 无按钮平台的审批点击：直达轻量确认页而非整个应用壳——少一次前端加载与路由，
  // 两步（点通知 → 按允许）的体感接近一键。普通通知仍走深链回会话。
  const target = data.page ?? (data.key ? `/#s=${encodeURIComponent(data.key)}` : '/')
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const c of list) {
        if ('focus' in c) {
          c.navigate(target).catch(() => {})
          return c.focus()
        }
      }
      return self.clients.openWindow(target)
    }),
  )
})
