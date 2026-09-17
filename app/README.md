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
- 审批通知：`web/src/lib/nativeBridge.ts` 在原生壳内自持 `/ws/inbox`，审批事件落本地通知（批准/拒绝按钮），按钮裁决走 `POST /api/approvals/resolve`（Bearer 令牌，secret 不进通知载荷）。
- 冷启动接力：进程死后点通知，action 由引导页捕获并经 `?nativeAction=` query 带给远端页消费（localStorage 跨源不共享）。
- Android 允许 cleartext（`usesCleartextTraffic="true"`）、iOS 放开 ATS（`NSAllowsArbitraryLoads`）——均为「用户自填服务器地址」的刻意取舍，覆盖局域网 http。

## 已知待办

- Android 后台存活：WebView 挂起后通知链路断，需前台服务自持 WS（未做）。
- iOS 后台送达必须走 APNs（需开发者账号；模拟器 spike 用 `simctl push` 验证 action 渲染，未做）。
- App 图标/启动图仍是 Capacitor 默认素材。
