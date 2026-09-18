# Capacitor 原生壳（方向二）实机踩坑与架构实录（2026-09-18 成文）

- 状态：**Android 全链路真机验收通过**（vivo OriginOS 6 / Android 16，2026-09-17）；
  iOS simulator spike 收官（结论见 §5）；分支 `feat/capacitor-shell`，PR #42 挂起
- 适用范围：改 `app/`（Capacitor 壳）、`web/src/lib/nativeBridge.ts`、`server/src/routes/misc.ts`
  的审批端点之前**先读本文**——每条坑都有实机证据，多数已固化为代码注释
- 本文记「为什么这么做、踩过什么」，交付时点记录在 `delivered.md`，ROADMAP 方向二只留待办与指针

## 1. 形态决策：hosted 而非打包（与最初草稿相反）

壳内**不打包** `web/dist`：`webDir` 只指向壳内引导页（`app/www/index.html`），
WebView 直连用户自托管的 AnyPlane 服务端。

理由：AnyPlane 的模型本就是「浏览器开服务端地址」——hosted 下 `/api`、`/ws` 相对
页面源，`web/` 零改动；前端版本永远与服务端匹配（改前端不必发 App 版）。
打包模式要引入可配 API base + 版本漂移治理，收益为零。
代价：首启多一步填服务器地址（引导页），且壳内导航必须做白名单（§4.3）。

## 2. 九条实机踩坑（按发现顺序）

### ① 外源跳转被 WebViewClient 甩给系统浏览器
**现象**：app 停在引导页「正在连接」，系统浏览器打开了服务器页面。
**根因**：Capacitor 默认只许 WebView 导航到本地源，外源一律 `ACTION_VIEW`
（`Bridge.launchIntent`，源码核实）。hosted 壳跳用户服务端正中此条。
**修法**：`capacitor.config.ts` 配 `server.allowNavigation`（运行时才知道地址，静态配置
只能通配；`HostMask` 语义经源码核实）。真正的收紧在插件层（§4.3）。

### ② 页面 WS 驱动在锁屏后停摆
**现象**：切走/锁屏后审批通知不出现，打开 app 才见审批卡。
**根因**：WebView 挂起 → JS 停摆 → 页面自持的 `/ws/inbox` 与本地通知一并失效。
**修法**：把通知生产权整体移到原生（`ApprovalService` 前台服务自持 WS + 原生通知按钮）。
这条把「后台存活」从后续项提前成核心链路本身。

### ③ 挖孔/状态栏重叠
Capacitor 8 模板无边距配置项（源码查过）。走 CSS `var(--sat)/--sab`（设计系统原预留）
+ Android 主题 `windowLightStatusBar=false`（近黑底上状态栏图标须浅色）。

### ④ 通知权限未授予 = 整条链路零可见迹象
**现象**：用户「通知栏无任何内容」，且前台服务常驻通知也一并消失。
**根因**：`POST_NOTIFICATIONS` 未授予时 `dumpsys` 显示 `importance=NONE`，
系统把该 app 的一切通知静默吞掉——没有报错、没有 UI 迹象。
**修法**：`NativeNotifyBanner`（权限状态外置 store）+ 服务端 HTML `no-cache`
（旧 index.html 引用已删除的 hash 块 → 动态 import 静默失败）+ 前台挂账事件切后台补发。

### ⑤ `isPluginAvailable` 在 hosted 远端页恒 false
`PluginHeaders` 由本地拦截器生成、只注入本地页面；远端页拿不到 → 该 API 对一切原生插件
返回 false。**任何「存在才调用」的门卫写法都会静默全灭**（实机症状：按钮点了毫无反应）。
原生插件探测只能 `registerPlugin` 后真调一次看死活。

### ⑥ vivo OriginOS 的 WebView 对远端页整段废除 `addJavascriptInterface`
**现象**：一切 Capacitor 插件调用永 pending（权限弹窗从未出现）。
**根因**：国产 ROM 的 WebView 对跨源页面禁用 JSI 注入。这是 hosted 模式在国产 ROM 上的
**通用风险**（iOS 的 WKWebView `messageHandlers` 是独立通道，不受影响）。
**修法（现架构）**：JS→native 走 `anyplane-bridge://` 导航拦截
（`Plugin.shouldOverrideLoad`，官方挂点，纯导航机制任何 WebView 都可用）；
native→JS 走 `WebView.evaluateJavascript`（独立机制）；系统权限弹窗改原生直发。
JSI 插件方法已从两端整体移除。

### ⑦ 企业 SSO 网关拦原生请求
**现象**：WebView 里一切正常，原生常驻通知卡「重连中」。
**根因**：WebView 持 SSO 会话 cookie，而原生 OkHttp cookie 罐为空 → 被网关弹回。
**修法**：`configure` 时从 `CookieManager` 摘取服务器域 cookie 落 prefs，
原生 WS/POST 统一携带（`ApiClient` 集中装配）。**ookie 是 configure 时快照**——
SSO 会话轮转后会陈旧，见 §7 待办。

### ⑧ 国产 ROM 后台省电掐长连
**现象**：点一次批准后 WS 闪断（`SocketException: Software caused connection abort`），
一秒后自恢复，但断开窗口内的审批通知丢失。
**根因**：vivo 电池优化掐前台服务的 socket（盒子侧 90s 探活排除了网关掐连）。
**修法**：通知菜单「后台保活」入口 → `ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS`；
各 OEM 仍需用户手动一次（已知边界）。

### ⑨ iOS 26 ShortLook 不渲染 action 按钮（平台回归，非本项目问题）
**现象**：iOS 模拟器上通知送达全通、动作按钮不出现。
**判定证据**：裸应用判别器（零 Capacitor，纯 `UNUserNotification` 注册同款 category）
**复现同款缺失**；外部社区同报 iOS 26 可操作通知异常。
**处置**：`XCTExpectFailure` 自更新监视器——回归存在套件绿，Apple 修复后套件自动变红。
按钮断言之外的部分（权限/注册/调度/送达）保持硬断言。

## 3. 验证环境与手法（供后续维护）

### 3.1 Android 原生链路直测（容器/CI 可用，无需真机）
容器无 KVM 时模拟器 TCG 软模拟可开机，但 **WebView 渲染必崩**（Chromium×TCG），
故 UI 侧只能真机；**原生层可完全直测**：

```bash
avdmanager create avd -n anyplane -k 'system-images;android-35;google_apis;x86_64' -d pixel_6
emulator -avd anyplane -no-window -no-audio -no-accel -gpu guest -memory 4096 &
adb wait-for-device  # 首启数分钟
adb root && adb reverse tcp:7480 tcp:7480          # 模拟器无网络时走反代
# 预置凭据（跳过 UI 引导）：
adb push prefs.xml /data/data/run.anyplane/shared_prefs/anyplane.bridge.xml
adb install -r app-debug.apk
adb shell am start-foreground-service run.anyplane/.ApprovalService
adb logcat | grep -E 'AnyPlaneSvc|AnyPlaneAction|AnyPlaneBridge'   # 全部关键路径有日志
```
挂起审批（等外部裁决）：`bun server/scripts/e2e-lib.ts` 的 `connect()` + 自发 user 消息；
裁决链验证：`adb shell am broadcast -a approve -n run.anyplane/.ApprovalActionReceiver --es ...`
（含 `|` 的 key 要用脚本文件推送到设备执行，`adb shell` 会吞管道）。TCG 下 ART 校验慢，
服务日志要等 1–2 分钟。

### 3.2 iOS spike（CI，免账号免 Mac）
`app-ios-spike.yml`：桩服务器托管 `web/dist` + 构建期注入
`server.url=?testNotify=1&nativeDebug=1`（跳过引导页；`nativeDebug` 打开例行进站确认，
硬断言 `register-action-types`/`test-notify` 依赖它）+
XCUITest 驱动（权限弹窗 → 通知中心 → action）。截图经
`xcrun xcresulttool export attachments --path ... --output-path ...` 导出为工件。
XCUITest 坑位：`TEST_HOST` 与 XCTRunner 互斥（用 TargetApplication 关联）；
宿主用显式 bundle id 启动；**交互避开屏幕中央**（会误点权限弹窗的「不允许」，flaky 根因）；
通知要后台送达才进通知中心（前台被 willPresent 吞掉）。

## 4. IPC 契约（改桥之前必读）

### 4.1 JS → 原生：`anyplane-bridge://<method>?<query>`（导航拦截）
| method | 参数 | 作用 |
|---|---|---|
| `configure` | `serverUrl`, `token` | 写凭据 + 启前台服务 + 原生直发权限弹窗 |
| `openNotificationSettings` | — | 跳系统通知设置页 |
| `requestBatteryExemption` | — | 请求电池优化豁免 |
参数用 `encodeURIComponent`（**不能用 URLSearchParams**——它把空格编成 `+`，
Android `Uri.getQueryParameter` 不还原，token 会被改坏）。未知 method 静默忽略（前向兼容）。
**无回执**：`configure` 是发即忘，JS 侧 `service:'plugin'` 状态只由原生 ack 驱动（§4.2）。

### 4.2 原生 → JS：`window.__anyplaneNativeEvent(<json>)`（evaluateJavascript）
目前**只有一种事件**：`{type:'perm', display:'granted'|'denied'}`（权限结果 ack）。
新增事件在此扩展；JS 侧 `registerNativeEventHook` 是唯一入口。

### 4.3 导航白名单（`shouldOverrideLoad` 强制执行）
壳内放行：`localhost`（引导页）与**和已配置服务器同源（scheme+host+port 全等）**的地址；
其余外链甩外部浏览器。注意：`anyplane-bridge://` 拦截**不检查发起源**——
残余风险与处置见 §6.2。SSO 前置的交互式登录跳转会被甩出去（已知限制）。
`allowNavigation: ['*']` 在 config 里只是兜底，真正判定在插件。

### 4.4 冷启动接力（两条，按通知来源分）
- 原生通知点正文 → `MainActivity` extras（`anyplane.openKey`）：
  本地引导页只挂 `window.__anyplanePendingOpen`，由 `www/index.html` 接到远端
  `#s=`（本地 hash 会随 `location.replace` 丢掉）；已在远端源时直接推
  `location.hash`。`evaluateJavascript` 的字符串必须用 `JSONObject.quote`，
  **不能用 `Uri.encode`**（AOSP 放行 `'()`* ，exported Activity extras 可注入）。
- LocalNotifications 插件通知（iOS 路径）→ 引导页捕获 → `?nativeAction=` query
  （localStorage 跨源不共享，不能走 localStorage 暂存）。
**约束**：原生侧只能表达「打开」，不能表达「裁决」——若 Android 将来出现 WebView 侧
action 源，必须走 query 接力（详见 PR #42 评审）。

## 5. 服务端配套（方向二引入）

- `POST /api/approvals/resolve`（Bearer）：原生通知按钮的裁决端点；与能力 URL 的
  `approval-action` 共用 `resolveApprovalRest`（`hub/lifecycle.ts`）。**红线不变**：
  审批规则引擎不经过任何 REST 路径，一键审批永远是人触发。
- `POST /api/client-log`：设备侧遥测（`?nativeDebug=1` 才收例行进站确认；
  ack/失败/超时类常量始终上报）。设备静默死时的唯一事后证据。
- 静态缓存：**默认一律 no-cache，只有 hash 命名的 `/assets/` 给 immutable**——
  `sw.js`/`manifest` 也在「设备是否最新」判别面上；`cache-control` 头由
  `server/src/index.ts` 的 `staticCacheHeaders` 统一给（Vite 管不到 `Bun.serve` 响应）。
- `InboxApproval.detail`：审批摘要的唯一口径（`summarizeInput`，服务端算好随
  inbox 事件下发）——原生通知/iOS 兜底/网页端不再各自截断 JSON，三处展示一致。

## 6. 三轮质量评审的存量结论

### 6.1 code-review（xhigh，15 条全量处理，见 PR #42）
最关键的五条已修：旧 socket 迟到事件防护（自激重连循环）、`pendings` 并发
（synchronizedMap + 遍历锁）、`snapshot` 权威全集替换（陈账不复活）、白名单全源匹配
（旧版只比 host，同主机异端口可借桥重指服务）、`SecureStore` v1: 前缀格式
（孤儿密文返回空逼重配，不再把垃圾加密成「合法 token」）。全部修复有模拟器复验。

### 6.2 security-review（2 条过滤 + 1 条已纠正）
- **`MainActivity` 的 `Uri.encode` 拼接 JS 曾被误判为不可注入**：AOSP
  `Uri.encode(String)` 实际放行 `A-Za-z0-9` **加上** `_-!.~'()*`，单引号不编码。
  `MainActivity` 又是 `exported=true`，同机 extras 可破出
  `location.hash='#s=…'`。已改 `JSONObject.quote` + 远端页用
  `encodeURIComponent(quotedLiteral)`。不要改回 `Uri.encode`。
- **`localhost` 白名单 + 桥拦截不查发起源的残余风险**：不构成凭据失窃
  （token 是被销毁/覆写而非外发；cookie 按攻击者源读取），残余影响为通知 DoS +
  假冒审批通知钓鱼。**纵深加固方向（未做）**：`configure` 拦截增加「发起源 ==
  已配置服务器源」检查，或把 localhost 放行收窄到引导期。
- `/api/client-log` 的换行注入按「日志伪造非漏洞」过滤（单用户自托管、调用者与读者同一主体）。

### 6.3 simplify（四视角，11 项落地）
结构性收敛：审批摘要正本化（§5 的 `detail`）；`ApiClient` 共享装配
（凭据内存缓存 + 单例 OkHttpClient + 认证 POST 一处，替代四处手搬头）；
`inboxBus` 单例订阅总线（SessionList 与原生桥共用一条 `/ws/inbox`，消灭 iOS 双连接）；
`onStartCommand` 凭据未变时跳过拆连（回前台不再 churn）；`notifIdFor` 用途命名；
`staticCacheHeaders` 反转默认；遥测分级（§5）；死模板清理（通知小图标换品牌 mipmap）。

### 6.4 客户端 attach 对齐（~~已知缺口，未做~~ → 已做 2026-09-19）
`approval_resolved` 广播是幂等清理信号（在线客户端的 stale 卡自愈），**不是补发机制**——
裁决时恰好离线的客户端救不回来。服务端 `replayApprovals` 已在 attach 时单播全量 pending，
但 `useSessionSocket` 目前是 append+dedup 而非 **replace 对齐**。把 attach 后的本地审批集
替换为重放集即可在真正的丢失点收敛（零额外事件）。做之前先补一个「断线错过 resolved」的用例。

**落地（13.4 批次 A）**：attach 发送时清空本地审批集（`useSessionSocket` 两个 attach 点），
WS 有序保证随后到达的 approval_request 恰好=重放集+新请求；e2e-mock 第 5 场景锁定
服务端权威（裁决后重连的重放集不含已裁决项）。浏览器实测：离线期间外部裁决 → 重连后
stale 卡消失不复活。

## 7. 已知边界与后续（给继续推进的人）

| 项 | 说明 |
|---|---|
| iOS APNs + $99 账号 | **暂缓**——推送落地的是同一层坏掉的 ShortLook（§2.9）；监视器在守（变红=Apple 修复了，届时再上） |
| Android 15+ FGS 配额 | `dataSync` 类型 6h/24h 上限，全天挂监听会被强停且配额窗口内禁重启；specialUse 类型/到点提醒待评估（README 已登记） |
| SSO cookie 陈旧 | configure 时快照；轮转后原生请求被弹回。彻底解是共享 `CookieJar`（okhttp 也用它做 WS 握手）——simplify 评审提过，未做 |
| 各 OEM 保活 | 豁免入口已给（电池优化），厂商自启白名单需用户手动（vivo 实测） |
| 白名单加固 | §6.2 的 configure 发起源检查 |
| iOS 后台送达 | 无 APNs 时只能前台路径；点正文进 app 内审批（两步，永远可用） |
| 打包/上架 | 应用商店材料（隐私声明：本地直连无遥测——本身是卖点）；Android 15+ 配额问题需在上架前定案 |
