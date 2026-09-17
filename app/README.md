# @anyplane/app — Capacitor 原生壳

hosted 模式：壳内不打包业务前端，WebView 直连用户自托管的 AnyPlane 服务端。
业务代码全在 `web/`；本目录只有原生工程、引导页（`www/index.html`）与 Capacitor 配置。

## 构建环境

- **JDK 21**（Capacitor 8 编译目标 Java 21；JDK 17 会报 `invalid source release: 21`）
- Android SDK：platform-tools、platforms;android-36、build-tools;35.0.0
- iOS 构建必须 macOS + Xcode（CI 走 `.github/workflows/app-ios.yml`，macos-latest 无签名编译）

## 常用命令

```bash
bun install                  # 根目录，工作区一起装
bunx cap sync android        # 装完依赖/改完 www 后必跑（插件注入 + 资源拷贝；
                             # capacitor.settings.gradle 引用 node_modules 内容寻址路径，
                             # 换机器/升级依赖后必须重新 sync 再生）
cd android && ./gradlew assembleDebug   # 出 app-debug.apk
```

## 架构要点

- 首启引导页填服务器地址（存 localStorage），随后 WebView 跳转该源；业务页面与原生源内一致，`/api`、`/ws` 零改动。
- **审批通知（Android，2026-09-17 真机验收通过的架构）**：`ApprovalService` 前台服务在原生层自持 `/ws/inbox`，审批事件落原生通知（批准/拒绝按钮）；按钮裁决由 `ApprovalActionReceiver` 直接 POST `/api/approvals/resolve`（Bearer + 摘来的 SSO cookie），进程死了也能被广播拉起——不依赖 WebView/JS 在场。前台时不发通知（页面内审批卡已覆盖），切后台一刻补发挂账。
- **JS↔原生通道是 `anyplane-bridge://` 导航拦截，不是 JSI**：vivo OriginOS 的 WebView 对远端页整段废除 `addJavascriptInterface`（实机确诊，一切插件调用永 pending）；导航拦截任何 WebView 都可用。native→JS 走 `evaluateJavascript`（独立机制）。iOS 保留 JSI 页面路径（WKWebView 正常）。
- 冷启动接力：原生通知点正文 → MainActivity 缓冲 → 页面加载后 `evaluateJavascript` 推 hash 深链。
- Android 允许 cleartext（`usesCleartextTraffic="true"`）、iOS 放开 ATS（`NSAllowsArbitraryLoads`）——均为「用户自填服务器地址」的刻意取舍，覆盖局域网 http。
- 导航白名单由 `AnyPlaneBridgePlugin.shouldOverrideLoad` 强制执行：本地源 + 已配置服务器源壳内加载，其余外链甩外部浏览器（`allowNavigation: ['*']` 仅为兜底）。已知限制：SSO 前置部署的交互式登录跳转也会被甩到外部浏览器。
- token/cookie 经 `SecureStore`（Android Keystore AES/GCM）落盘，历史明文自动迁移重加密；开机自启 `BootReceiver`（配置过服务器地址才拉起）。
- SSO 网关后置的服务端：`configure` 时从 `CookieManager` 摘 WebView 会话 cookie，原生 WS/POST 统一携带（本机 woa 网关实测必须）。

## 已知待办

- Android 后台驻留边界：`START_STICKY` + `stopWithTask="false"` + 开机自启已覆盖常规路径；Doze 深睡与各 OEM 保活设置页差异仍需用户侧一次性加白（豁免入口在通知菜单「后台保活」，vivo 实测需手动一次）。
- iOS 后台送达必须走 APNs（需开发者账号；模拟器 spike 与 `simctl push` 验证在推进中）。
