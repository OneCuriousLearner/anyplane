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

import { Capacitor } from '@capacitor/core'
import { LocalNotifications, type LocalNotificationsPlugin } from '@capacitor/local-notifications'
import { postJson } from './api'
import { getToken } from './auth'
import { InboxSocket, type InboxEvent } from './inbox'
import { sessionHashUrl } from './sessionHash'

const ACTION_TYPE = 'APPROVAL'
const QUERY_PARAM = 'nativeAction'

export type NativeAction = { key: string; requestId: string; actionId: string }

// ---------------------------------------------------------------------------
// 设备侧遥测：静默死无法本地排查时，把里程碑直接写进服务端日志（/api/client-log）

function clientLog(tag: string, msg: string): void {
  void postJson('/api/client-log', { tag, msg }).catch(() => {})
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | null> {
  return Promise.race([p, new Promise<null>((resolve) => setTimeout(() => resolve(null), ms))])
}

// ---------------------------------------------------------------------------
// 状态外置：横幅 UI 的唯一事实源

export type NativeBridgeStatus = {
  /** 是否在原生壳内 */
  active: boolean
  /** 壳平台（android/ios/web） */
  platform: string
  /** 通知权限（unknown=尚未查询） */
  permission: 'unknown' | 'granted' | 'prompt' | 'prompt-with-rationale' | 'denied'
  /** 通知生产权在谁手里 */
  service: 'off' | 'plugin' | 'js-fallback'
  /** 桥初始化异常（如旧缓存包导致动态 import 失败）；null = 正常 */
  error: string | null
}

let status: NativeBridgeStatus = { active: false, platform: 'web', permission: 'unknown', service: 'off', error: null }
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

/** 导航桥：anyplane-bridge://<method>?<query> 经 shouldOverrideLoad 拦截执行——
 *  纯页面导航，不依赖 addJavascriptInterface（vivo OriginOS 的 WebView 对远端页
 *  整段废除 JSI 通道，实机确诊）。仅 Android 使用；被拦截的导航不进历史。 */
function navBridge(method: string, params: Record<string, string>): void {
  const q = new URLSearchParams(params).toString()
  location.href = `anyplane-bridge://${method}${q ? `?${q}` : ''}`
}

/** Android 电池优化豁免（vivo/国产 ROM 后台省电掐长连的对症出口），导航桥直发 */
export function requestBatteryExemptionNav(): void {
  if (Capacitor.getPlatform() === 'android') navBridge('requestBatteryExemption', {})
}

/** native→JS 事件入口（evaluateJavascript 推入，与 JSI 无关的独立机制） */
function registerNativeEventHook(): void {
  ;(window as unknown as { __anyplaneNativeEvent?: (ev: unknown) => void }).__anyplaneNativeEvent = (ev) => {
    const e = ev as { type?: string; display?: NativeBridgeStatus['permission'] }
    if (e?.type === 'perm' && e.display) {
      clientLog('native-perm', `display=${e.display}`)
      setStatus({ permission: e.display })
    }
  }
}

/** 权限补授后的续跑（横幅按钮路径） */
async function continueNativeSetup(): Promise<void> {
  if (!LN || setupStage === 'done') return

  // Android：导航桥通道（JSI 在 vivo OriginOS 的 WebView 上对远端页整段失效——实机）。
  // configure 由原生执行：启动前台服务 + 原生直发系统权限弹窗（ensureNotificationPermission）；
  // 权限结果经 __anyplaneNativeEvent 回推。这条链上没有任何 JSI 调用。
  if (Capacitor.getPlatform() === 'android') {
    const sync = (): void => {
      navBridge('configure', { serverUrl: location.origin, token: getToken() ?? '' })
    }
    sync()
    // 回前台时重同步：捡起登录态变化（重登录换 token）
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') sync()
    })
    setupStage = 'done'
    setStatus({ service: 'plugin' })
    clientLog('configure-nav', '已发导航桥 configure')
    return
  }

  // iOS：WKWebView 的 JSI 正常，但自研插件只有 Android 实现——通知生产权在页面 JS：
  // 权限 OK 后自持 /ws/inbox + LocalNotifications（APNs 接入前的前台兜底）。
  // 权限弹窗与后续解耦：requestPermissions 挂起（部分 ROM 回调丢失）不会拖死主链。
  const current = await withTimeout(LN.checkPermissions(), 3000)
  if (current) setStatus({ permission: current.display })
  clientLog('perm-check', current ? `display=${current.display}` : 'TIMEOUT（checkPermissions 未返回）')
  void LN.requestPermissions()
    .then((p) => setStatus({ permission: p.display }))
    .catch(() => {})

  if (current?.display !== 'granted') return
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
  setStatus({ active: true, platform: Capacitor.getPlatform() })
  // BRIDGE_REV：判别「设备跑的是不是最新包」——每轮改动自增，setup 必带
  clientLog('setup', `rev=7 platform=${Capacitor.getPlatform()} origin=${location.origin}`)
  try {
    // 静态 import（早期版本是动态 import + 独立 chunk：国产 ROM 上 chunk 拉取可能挂起，
    // 整桥死在半路且无声——静态引入消除独立 fetch，代价是浏览器多载一个 10KB 级包）
    LN = LocalNotifications
    clientLog('ln-import', 'static ok')

    // Android：导航桥通道，全程不碰 JSI（vivo OriginOS 实机整段失效）。
    // native→JS 状态回推经 __anyplaneNativeEvent（evaluateJavascript 独立机制）。
    if (Capacitor.getPlatform() === 'android') {
      registerNativeEventHook()
      setupStage = 'ready'
      await continueNativeSetup()
      return
    }

    // iOS / 其他：LN 初始化（WKWebView 的 JSI 正常）。每个原生调用套 3s 超时
    // 并逐个上报到达证据（国产 ROM 排查期留下的遥测，成本极低，保留）。
    await withTimeout(LN.registerActionTypes({
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
    }), 3000).then((r) => clientLog('register-action-types', r === null ? 'TIMEOUT' : 'ok'))

    await withTimeout(LN.addListener('localNotificationActionPerformed', (ev) => {
      const extra = ev.notification.extra as { key?: unknown; requestId?: unknown } | undefined
      if (typeof extra?.key !== 'string' || typeof extra.requestId !== 'string') return
      void act({ key: extra.key, requestId: extra.requestId, actionId: ev.actionId })
    }), 3000).then((r) => clientLog('add-listener', r === null ? 'TIMEOUT' : 'ok'))

    // CI/模拟器 spike 钩子（?testNotify=1）：等授权完成后调度一条带审批按钮的测试通知，
    // 验证「权限弹窗 → 注册 actionType → 调度 → 系统渲染按钮 → action 回传 → POST」。
    // 裁决对象是虚构的（服务端 409 属预期），断言点是 POST 本身到达。
    // 必须等 granted：iOS 在授权完成前 add() 会被系统静默丢弃（首轮 spike 实测踩坑）。
    if (new URLSearchParams(location.search).get('testNotify') === '1') {
      void (async () => {
        for (let i = 0; i < 45; i++) {
          const p = await LocalNotifications.checkPermissions().catch(() => null)
          if (p?.display === 'granted') break
          await new Promise((r) => setTimeout(r, 1000))
        }
        void LocalNotifications.schedule({
          notifications: [
            {
              id: 42,
              title: '审批 · CI-Test',
              body: 'simulator spike 测试通知',
              // 延迟 15s 触发：前台送达会被 willPresent 吞掉（不进通知中心），
              // 等测试把 app 压到后台再送达（spike 实测前台调度不现身）
              schedule: { at: new Date(Date.now() + 15000) },
              actionTypeId: ACTION_TYPE,
              extra: { key: 's|ci|test', requestId: 'ci-test-1' },
            },
          ],
        })
          .then(() => clientLog('test-notify', 'scheduled'))
          .catch((e) => clientLog('test-notify-fail', String(e)))
      })()
    }

    setupStage = 'ready'
    await continueNativeSetup()
  } catch (e) {
    setStatus({ error: `原生桥初始化失败：${e instanceof Error ? e.message : String(e)}` })
  }
}

/** 横幅「去开启」按钮：重问一次权限；被永久拒绝（返回 denied 且不再弹窗）时跳系统设置页 */
export async function requestNativeNotificationPermission(): Promise<void> {
  if (!LN) return
  clientLog('banner-tap', '用户点击去开启')
  // Android：直达系统通知设置页（导航桥）。原生 configure 流每次都会顺带直发
  // 系统权限弹窗（ensureNotificationPermission），设置页是 ROM 吞弹窗时的保底出口。
  if (Capacitor.getPlatform() === 'android') {
    navBridge('openNotificationSettings', {})
    clientLog('settings-nav', '已发导航桥 openNotificationSettings')
    return
  }
  const before = (await LN.checkPermissions().catch(() => null))?.display ?? 'unknown'
  if (before === 'granted') {
    setStatus({ permission: 'granted' })
    await continueNativeSetup()
    return
  }
  // requestPermissions 在部分国产 ROM 上可能既不弹窗也不 resolve（回调丢失）——
  // 3s 超时视为被拒，绝不串行等待。iOS 暂无自研插件，被拒后靠横幅文案引导手动进设置。
  const perm = await withTimeout(LN.requestPermissions(), 3000)
  if (perm) setStatus({ permission: perm.display })
  clientLog('perm-request', perm ? `result=${perm.display}` : 'timeout（ROM 未返回）')
  if (perm?.display === 'granted') {
    await continueNativeSetup()
  }
}
