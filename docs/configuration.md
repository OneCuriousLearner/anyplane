# 配置参考

README 只保留最常用的几项，这里是完整配置说明。

配置文件位置（均可选，优先级从高到低）：项目根目录 `anyplane.config.json` → `~/.anyplane/config.json` → 环境变量。
根目录的配置文件**已被 gitignore**（机器相关路径不应入库），可复制 `anyplane.config.example.json` 后按需修改。

```json
{
  "port": 7480,
  "host": "127.0.0.1",
  "authToken": "change-me",
  "permissionPolicy": "ask",
  "claudePath": "/usr/local/bin/claude",
  "detachRecycleMs": 300000,
  "idleTimeoutMs": 1800000,
  "claudeConfigDir": "~/.claude"
}
```

## 配置项

- `port`：监听端口，默认 7480。
- `host`：监听地址，默认 `127.0.0.1`（仅本机）。**绑定非回环地址（如 `0.0.0.0`）必须同时配置 `authToken`**，否则拒绝启动——局域网内的任何人都能起会话 = 任意命令执行。
- `authToken`：访问令牌（可选）。配置后 `/api` 与 `/ws` 一律要求 `Authorization: Bearer <token>` 或 `?token=<token>`；静态前端壳不鉴权（JS 中无敏感数据）。局域网模式启动时终端会打印带 token 的扫码 URL 二维码，手机扫码即入；浏览器端令牌存 localStorage，401 时会弹出令牌输入页。
- `permissionPolicy`：`"ask"`（默认，转发 UI 审批）| `"bypass"`（spawn 即 bypassPermissions）。
- `claudePath`：Claude CLI 路径，默认从 PATH 解析。
- `detachRecycleMs`：已收到 Claude `session_state_changed` 时，客户端全断、主会话 `idle` 且无 Claude 后台任务后多久回收子进程（默认 5 分钟）；`running` / `requires_action` / 后台任务期间绝不回收。
- `idleTimeoutMs`：无权威状态事件时的回退回收延迟（默认 30 分钟）。
- `claudeConfigDir`：Claude 配置目录，默认 `~/.claude`。

环境变量覆盖：`ANYPLANE_PORT`、`ANYPLANE_HOST`、`ANYPLANE_TOKEN`、`CLAUDE_CONFIG_DIR`。

## 运行数据目录

一切 AnyPlane 自产数据都在 `~/.anyplane/`：图片附件（`uploads/`）、会话回收站（`trash/`）、接力血缘（`lineage.json`）、Codex 思考侧车（`reasoning/`）、推送密钥与订阅（`vapid.json` / `push-subscriptions.json`）。**不自动清理，由用户自行管理。**

## 推送通知（Web Push）

在列表页铃铛面板订阅。需要 HTTPS（Tailscale serve/funnel 或自有反代）或 localhost；iOS 需先把站点**添加到主屏幕**再从主屏图标打开订阅（Safari 页签内不提供推送）。Android 国内无 FCM 环境不可达（已知边界，可用下方 webhook 通道替代）。

## 推送 webhook 通道（ntfy / Bark / Server酱）

与 Web Push 订阅并列接收同一份通知，配置文件管理：

```json
{
  "publicUrl": "https://anyplane.example.com",
  "pushWebhooks": [
    { "type": "ntfy", "topic": "换成长随机串", "server": "https://ntfy.sh", "token": "可选" },
    { "type": "bark", "url": "https://api.day.app/你的Key" },
    { "type": "sct", "sendkey": "SCT开头的SendKey" }
  ]
}
```

- `publicUrl` 是 AnyPlane 的公网基准地址（不带尾斜杠）。webhook 通知里的深链和审批按钮需要绝对 URL——不配也能发，但只有纯文本（标题+摘要）。
- 直接审批分级：**ntfy** 通知内按钮一键允许/拒绝（app 内 POST，不打开页面）；**Bark/Server酱** 点链接进确认页（两个按钮，避免链接被预览抓取误触发审批）。
- 渠道凭证 = 通知保密边界：ntfy topic 要用不可猜的长随机串（或配 token），Bark key / SendKey 同理。与 Web Push 不同，webhook 渠道方（ntfy.sh / Apple / 腾讯）能读通知全文。
- 手动验证：配置后重启服务端，让某会话触发一次审批（如让它写文件），观察 ntfy app / Bark / 微信是否收到并能否一键裁决；**铃铛面板的「测试通知」按钮**可向全部订阅与 webhook 通道一键发测试推送（返回分通道送达计数），不必触发真实审批。

## 平台注意事项

- spawn 时自动设置 `CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS=1` 以接收权威 busy/idle 信号。
- Windows 请使用 Bun 1.4.0+。Bun 1.3.x 及更早版本存在监听 socket 被子进程继承的问题（[oven-sh/bun#36936](https://github.com/oven-sh/bun/issues/36936)）；修复随 1.4.0 发布。已经产生的死 PID 监听通常需要重启一次 Windows 才能释放。
- `bun run dev` 使用纯 Bun 启动器并等待 server 完成优雅关闭；不要用任务管理器直接结束 server，否则可能绕过 `server.stop(true)` 与 Claude 子进程树清理。
