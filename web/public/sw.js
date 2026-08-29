// service worker：PWA 可安装性 + Web Push 接收与点击。
// 不做离线缓存——数据面全部走网络，缓存陈旧数据只会误导。
self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()))
self.addEventListener('fetch', () => {})

// ---------- Web Push ----------

// payload 形状见 server/src/push.ts 的 PushPayload
self.addEventListener('push', (e) => {
  if (!e.data) return
  let p
  try {
    p = e.data.json()
  } catch {
    return
  }
  const opts = {
    body: p.body ?? '',
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    tag: p.tag ?? `ccr-${Date.now()}`,
    renotify: p.type === 'approval',
    requireInteraction: p.type === 'approval', // 审批通知常驻直到用户处理
    data: { key: p.key, requestId: p.requestId, actions: p.actions },
    // 审批通知带直接裁决按钮（通知栏上完成审批，不打开页面）
    actions:
      p.type === 'approval' && p.actions
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

  // 普通点击：聚焦已有窗口，否则打开深链直达会话
  const target = data.key ? `/#s=${encodeURIComponent(data.key)}` : '/'
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
