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
- **审批通知（Android，实机验证后的架构）**：`ApprovalService` 前台服务在原生层自持 `/ws/inbox`，审批事件落原生通知（批准/拒绝按钮）；按钮裁决由 `ApprovalActionReceiver` 直接 POST `/api/approvals/resolve`（Bearer），进程死了也能被广播拉起——不依赖 WebView/JS 在场。前台时不发通知（页面内审批卡已覆盖）。页面 WS + LocalNotifications 的 JS 路径只保留给 iOS（APNs 接入前的兜底）与缺插件的旧壳。
- 冷启动接力有两条平行的路，按通知来源分：原生通知点正文 → MainActivity extras → `consumePendingOpen`；LocalNotifications 插件通知（iOS/JS 路径）→ 引导页捕获 → `?nativeAction=` query 接力（localStorage 跨源不共享）。
- Android 允许 cleartext（`usesCleartextTraffic="true"`）、iOS 放开 ATS（`NSAllowsArbitraryLoads`）——均为「用户自填服务器地址」的刻意取舍，覆盖局域网 http。
- `allowNavigation: ['*']` 是 spike 期的刻意放宽（hosted 模式的服务器地址运行时才知道，静态配置只能通配）；收紧项：自定义原生 WebViewClient 白名单收窄到本地源+用户配置源。

## 已知待办

- Android 后台驻留边界：`START_STICKY` + `stopWithTask="false"` 已覆盖划卡；Doze 深睡与 OEM 激进清理（小米/华为等）仍需用户在系统设置里给 app 加白/关电池优化；开机自启未做。
- iOS 后台送达必须走 APNs（需开发者账号；模拟器 spike 用 `simctl push` 验证 action 渲染，未做）。
- 令牌在原生层落 SharedPreferences 明文（与 WebView localStorage 同级敏感度）；Keystore 包装是加固项。
