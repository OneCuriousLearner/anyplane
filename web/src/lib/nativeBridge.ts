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
import type { InboxEvent } from '@anyplane/protocol'
import { postJson } from './api'
import { getToken } from './auth'
import { createStore } from './store'
import { inboxSubscribe } from './inboxBus'
import { consumeQueryParam, sessionHashUrl } from './sessionHash'

const ACTION_TYPE = 'APPROVAL'
const QUERY_PARAM = 'nativeAction'

export type NativeAction = { key: string; requestId: string; actionId: string }

// ---------------------------------------------------------------------------
// 设备侧遥测：静默死无法本地排查时，把里程碑直接写进服务端日志（/api/client-log）。
// 分级：ack/失败/超时类常量保留（native-perm/svc-ws-*/configure-fail/*-fail/TIMEOUT），
// 例行进站确认（setup/import/register/tap 等每次启动都刷的行）只在 ?nativeDebug=1 时上报
// （simplify 评审 Altitude：稳态降噪，服务器日志不该每次开 app 多五行）。

function clientLog(tag: string, msg: string): void {
  void postJson('/api/client-log', { tag, msg }).catch(() => {})
}

function clientDebug(tag: string, msg: string): void {
  if (!new URLSearchParams(location.search).has('nativeDebug')) return
  clientLog(tag, msg)
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | null> {
  return Promise.race([p, new Promise<null>((resolve) => setTimeout(() => resolve(null), ms))])
}

// ---------------------------------------------------------------------------
// 状态外置：横幅 UI 的唯一事实源（store 容器——13.4 批次 C1 统一外部 store 机制，
// 此前是本文件内 18 行手写同形状副本，PR#53 review 合并）

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

const statusStore = createStore<NativeBridgeStatus>({
  active: false,
  platform: 'web',
  permission: 'unknown',
  service: 'off',
  error: null,
})

function setStatus(patch: Partial<NativeBridgeStatus>): void {
  statusStore.set({ ...statusStore.get(), ...patch })
}

export function getNativeBridgeStatus(): NativeBridgeStatus {
  return statusStore.get()
}

export function subscribeNativeBridge(l: () => void): () => void {
  return statusStore.subscribe(l)
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

/** 通知 id 按用途命名（simplify 评审 Altitude：裸 +1 是隐式规则——集中成命名方案，
 *  且成功路径两个用途都清，否则重试成功后旧「未送达」通知挂着没人收） */
function notifIdFor(requestId: string, purpose: 'approval' | 'failure'): number {
  return purpose === 'failure' ? notifId(requestId) + 1 : notifId(requestId)
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
  return parseNativeAction(consumeQueryParam(QUERY_PARAM))
}

// ---------------------------------------------------------------------------
// 初始化（分两段：setupNativeBridge 一次性装载；continueNativeSetup 可在权限补授后续跑）

let LN: LocalNotificationsPlugin | null = null
// continueNativeSetup 的一次性完成标记（替代原 setupStage 三态机——'ready' 写了从不读）
let continueDone = false

async function act(a: NativeAction): Promise<void> {
  if (a.actionId === 'approve' || a.actionId === 'deny') {
    const r = await postJson('/api/approvals/resolve', {
      key: a.key,
      requestId: a.requestId,
      decision: a.actionId === 'approve' ? 'allow' : 'deny',
    }).catch(() => null)
    // 409 = 已在别处裁决（或上游已超时），静默；401 已由 api 层触发令牌页
    if (r && !r.ok && r.status !== 409) {
      // 失败通知用独立 id 且立即返回——否则被函数末尾的统一 cancel 当场删掉（评审发现）
      await LN?.schedule({
        notifications: [{ id: notifIdFor(a.requestId, 'failure'), title: '审批未送达', body: '请打开应用确认会话状态' }],
      }).catch(() => {})
      return
    }
  } else {
    // 点通知正文：深链进对应会话（hash 路由接管，见 App.tsx）
    location.hash = sessionHashUrl(a.key)
  }
  // 成功/409：两个用途的通知都清（重试成功时旧的「未送达」也要收）
  await LN?.cancel({
    notifications: [{ id: notifIdFor(a.requestId, 'approval') }, { id: notifIdFor(a.requestId, 'failure') }],
  }).catch(() => {})
}

/** 导航桥：anyplane-bridge://<method>?<query> 经 shouldOverrideLoad 拦截执行——
 *  纯页面导航，不依赖 addJavascriptInterface（vivo OriginOS 的 WebView 对远端页
 *  整段废除 JSI 通道，实机确诊）。仅 Android 使用；被拦截的导航不进历史。
 *  注意必须用 encodeURIComponent（空格 %20）——URLSearchParams 把空格编成 '+'，
 *  而 Android Uri.getQueryParameter 不把 '+' 还原成空格，token 会被改坏（评审发现） */
function navBridge(method: string, params: Record<string, string>): void {
  const q = Object.entries(params)
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
    .join('&')
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
      // 首个原生回推即导航桥生效的实证（configure 是发即忘导航，收不到回推说明
      // 壳太老/服务没起来——service 状态只许由 ack 驱动，不许乐观假设：评审发现）。
      // 顺带清掉此前的 error——横幅不该比修复它的成功路径活得久（simplify 评审发现）
      setStatus({ permission: e.display, service: 'plugin', error: null })
    }
  }
}

/** 权限补授后的续跑（横幅按钮路径） */
async function continueNativeSetup(): Promise<void> {
  if (!LN || continueDone) return

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
    continueDone = true
    // service 只由原生回推（evaluateJavascript ack）置为 plugin；6s 无 ack 说明
    // 壳太老/服务没起来，落 js-fallback 触发横幅警示（评审发现：乐观假设会让
    // 死桥在 UI 里完全隐形）
    window.setTimeout(() => {
      if (getNativeBridgeStatus().service === 'off') setStatus({ service: 'js-fallback' })
    }, 6000)
    clientDebug('configure-nav', '已发导航桥 configure')
    return
  }

  // iOS：WKWebView 的 JSI 正常，但自研插件只有 Android 实现——通知生产权在页面 JS：
  // 权限 OK 后自持 /ws/inbox + LocalNotifications（APNs 接入前的前台兜底）。
  // 权限弹窗与后续解耦：requestPermissions 挂起（部分 ROM 回调丢失）不会拖死主链。
  const current = await withTimeout(LN.checkPermissions(), 3000)
  if (current) setStatus({ permission: current.display })
  clientDebug('perm-check', current ? `display=${current.display}` : 'TIMEOUT（checkPermissions 未返回）')
  void LN.requestPermissions()
    .then((p) => {
      setStatus({ permission: p.display })
      // 系统弹窗授权后必须续跑建连——此前只在横幅路径续跑，首次进 app 直接授权的
      // 场景下 socket 永远不建（评审发现：iOS 新装首授权后通知全灭直到重启）
      if (p.display === 'granted') void continueNativeSetup()
    })
    .catch(() => {})

  if (current?.display !== 'granted') return
  continueDone = true
  setStatus({ service: 'js-fallback' })
  const scheduleApproval = (a: { key: string; requestId: string; toolName: string; input: unknown; detail?: string }): void => {
    void LN?.schedule({
      notifications: [
        {
          id: notifId(a.requestId),
          title: `审批 · ${a.toolName}`,
          // 服务端唯一口径（summarizeInput）摘要；老服务端缺省时回退本地截断
          body: a.detail ?? summarizeInput(a.input),
          actionTypeId: ACTION_TYPE,
          extra: { key: a.key, requestId: a.requestId },
        },
      ],
    }).catch(() => {})
  }
  inboxSubscribe((ev: InboxEvent) => {
    if (ev.type === 'approval') {
      scheduleApproval(ev)
    } else if (ev.type === 'approval_resolved') {
      // 在别处（其他设备/规则引擎/会话内）已裁决：清掉本机通知
      void LN?.cancel({ notifications: [{ id: notifId(ev.requestId) }] }).catch(() => {})
    } else if (ev.type === 'snapshot') {
      // 连接即下发的 pending 全集（评审发现：JS 兜底路径漏了它，页面加载前
      // 已存在的审批永远不通知；notify 同 id 覆盖，天然去重）
      for (const a of ev.approvals) scheduleApproval(a)
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
  clientLog('setup', `platform=${Capacitor.getPlatform()} origin=${location.origin}`)
  try {
    // 静态 import（早期版本是动态 import + 独立 chunk：国产 ROM 上 chunk 拉取可能挂起，
    // 整桥死在半路且无声——静态引入消除独立 fetch，代价是浏览器多载一个 10KB 级包）
    LN = LocalNotifications
    clientDebug('ln-import', 'static ok')

    // Android：导航桥通道，全程不碰 JSI（vivo OriginOS 实机整段失效）。
    // native→JS 状态回推经 __anyplaneNativeEvent（evaluateJavascript 独立机制）。
    if (Capacitor.getPlatform() === 'android') {
      registerNativeEventHook()
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
    }), 3000).then((r) => clientDebug('register-action-types', r === null ? 'TIMEOUT' : 'ok'))

    await withTimeout(LN.addListener('localNotificationActionPerformed', (ev) => {
      const extra = ev.notification.extra as { key?: unknown; requestId?: unknown } | undefined
      if (typeof extra?.key !== 'string' || typeof extra.requestId !== 'string') return
      void act({ key: extra.key, requestId: extra.requestId, actionId: ev.actionId })
    }), 3000).then((r) => clientDebug('add-listener', r === null ? 'TIMEOUT' : 'ok'))

    // CI/模拟器 spike 钩子（?testNotify=1）：等授权完成后调度一条带审批按钮的测试通知，
    // 验证「权限弹窗 → 注册 actionType → 调度 → 系统渲染按钮 → action 回传 → POST」。
    // 裁决对象是虚构的（服务端 409 属预期），断言点是 POST 本身到达。
    // 必须等 granted：iOS 在授权完成前 add() 会被系统静默丢弃（首轮 spike 实测踩坑）。
    // 成功/失败都走 clientLog：本钩子已被 testNotify 门禁，不是每次开 app 的例行噪音。
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

    await continueNativeSetup()
  } catch (e) {
    setStatus({ error: `原生桥初始化失败：${e instanceof Error ? e.message : String(e)}` })
  }
}

/** 横幅「去开启」按钮：重问一次权限；被永久拒绝（返回 denied 且不再弹窗）时跳系统设置页 */
export async function requestNativeNotificationPermission(): Promise<void> {
  if (!LN) return
  clientDebug('banner-tap', '用户点击去开启')
  // Android：直达系统通知设置页（导航桥）。原生 configure 流每次都会顺带直发
  // 系统权限弹窗（ensureNotificationPermission），设置页是 ROM 吞弹窗时的保底出口。
  if (Capacitor.getPlatform() === 'android') {
    navBridge('openNotificationSettings', {})
    clientDebug('settings-nav', '已发导航桥 openNotificationSettings')
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
  clientDebug('perm-request', perm ? `result=${perm.display}` : 'timeout（ROM 未返回）')
  if (perm?.display === 'granted') {
    await continueNativeSetup()
  }
}
