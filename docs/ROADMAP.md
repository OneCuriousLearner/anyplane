# AnyPlane 后续规划（ROADMAP）

> 2026-08-24 立。前置：统一 Agent 控制面 8 阶段计划已全部完成（见 `PLAN-unified-agent-plane.md`）。
> 本文档收录已讨论定论、待排期的方向；每条附决策依据，避免将来重新论证。

## 定位备忘（为什么做这些）

官方远程能力（Remote Control / claude.ai/code / codex remoteControl）对 **API-key 与 gateway 用户硬性禁用**
（Remote Control 文档：订阅限定；v2.1.196 起 ANTHROPIC_BASE_URL 指向 gateway 即禁用）。
AnyPlane 是这群用户的控制面：本地优先、provider 中立、双供应商。以下方向都服务于这个定位，
不追官方云能力（云同步/E2EE/多设备），不与官方 TUI（agent view）赛跑 UI。

## 方向一：推送通知（手机审批闭环的最后一环）——✅ 已完成（2026-08-25）

**已交付**（commit 见 git log）：
- 服务端 `push.ts`：自实现 VAPID + aes128gcm（不依赖 web-push——其 node:https 假定 TLS）。
  订阅注册表 `~/.anyplane/push-subscriptions.json`（per-subscription 能力密钥），VAPID 密钥 `~/.anyplane/vapid.json`。
- inbox 事件（approval/done/error）fan-out；审批推送内容详细（工具名 + 命令摘要 + 项目名——锁屏脱敏交给 OS）。
- **通知直接审批**：能力 URL（`/api/approval-action?k&r&d&s=<secret>`），SW 通知按钮回POST 即裁决，不开页面；
  绕开 authToken（能力模型），仅对 pending 中的 requestId 有效。
- 前端：sw.js push/notificationclick、订阅面板（列表页铃铛）、`#s=<key>` 深链。
- 验证：`server/scripts/e2e-push.ts` 15 项全过（mock push service + 独立实现解密反证加密正确 +
  能力审批 + 403 拒绝 + 410 清理）。

**剩余待办（未做）**：
- ~~webhook 通道（ntfy/Bark/Server酱）~~ → ✅ 已完成（2026-08-27）：配置项 `pushWebhooks` + `publicUrl`；
  ntfy http action 真一键审批，Bark/Server酱 落 `GET /api/approval-page` 确认页（防预览误触）；
  webhook 能力密钥 = HMAC(vapid 私钥, 渠道标识) 派生，不落新状态。验证：`server/src/push.test.ts`
  webhook 段 7 项单测 + 真实服务端 mock 渠道活体全链路（审批 fanout/按钮 POST/确认页/done 扇出）。
- iOS 实测：需 PWA 加到主屏幕后订阅；图标已备 PNG（icon-192/512）。

## 方向二：App 壳（Capacitor，不换技术栈）

**定论**：不做 RN 重写（代码翻倍、维护翻倍，happy 的路线不是我们的路线）；
用 **Capacitor 套壳现有 PWA** 打出 iOS/Android 原生包——日常开发仍是写 React，新增的只是构建链。

**价值**：
- App Store / Google Play 上架 = 分发实体（项目里程碑性质的目标）
- 原生推送（APNs/FCM 插件）比 Web Push 更可靠，方向一可以先在壳内落地
- 分享面板、生物识别锁（可选）等原生能力解锁

**步骤草拟**：
1. `bun add @capacitor/core @capacitor/cli`，`npx cap init`（构建产物指向 `web/dist`）
2. 壳内服务器地址配置页（首次启动填 `https://xxx.ts.net` + token；现在 PWA 靠 URL 参数）
3. 推送插件接入（`@capacitor/push-notifications`），复用方向一的登记端点
4. iOS 需要 $99/年开发者账号；Android 可直接侧载 APK 先行
5. 上架材料：隐私声明（本地直连、无遥测——这本身是卖点）

**验收**：Android APK 侧载可用（连接/审批/推送全通）；iOS TestFlight 内测。

## 方向三：公网接入（不自购云服务器）——✅ 配方已落地（2026-08-27）

**定论**：优先级 Tailscale funnel > Cloudflare Tunnel > 家宽 IPv6 直连；都不需要自购 VPS。
三套配方 + 安全红线 + 手机蜂窝验收清单已写入 [`docs/public-access.md`](public-access.md)
（含「通知投递 vs 审批回执」双路径模型与故障排查表——"通知到了、按钮点不动"的唯一根因是 publicUrl 入方向不可达）。
进度：authToken + 手机 ntfy 审批已实测通过；蜂窝验收待 CF Tunnel 落地（命名隧道需域名，临时隧道零费用随时可验）。

| 方案 | 花费 | 第三方可见性 | 备注 |
|---|---|---|---|
| Tailscale funnel | 免费 | 边缘节点只转发加密 TCP，TLS 在本机终止 | 一条命令，首选 |
| Cloudflare Tunnel | 免费 | CF 边缘终止 TLS（可见明文），换来 Access 认证层 | 要稳定域名 + WAF 时选 |
| 家宽 IPv6 + DDNS | 零 | 无第三方 | 国内家宽多有公网 v6；注意运营商入站过滤与自身防火墙 |

## 已验证但暂不做的（决策记录）

- **~~daemon socket 深度集成~~（保留结论）+ ~~`claude agents --json --all` 状态增强~~** ✅ 已接入（2026-08-27）：
  `backends/claude/agents.ts` SWR 轮询（15s TTL + 后台刷新，listSessions 同步热路径零阻塞）；
  pid 文件优先、daemon 兜底——独有价值是 `kind:background` 后台 agent（无 pid 文件）的存活状态。
  control.sock 深度集成维持原结论不做：协议 proto 版本锁死，只能 opportunistic 增强，不当基石。
- **codex token_budget**：thread/goal/set 协议字段已透传，UI 不做——token ≠ 钱，预算心智账户建不起来；等真实无人值守批处理场景出现再点亮。
- **codex `permissions` named-profile 迁移**：`sandboxPolicy` 未 deprecated，不急；迁移时注意 `sandboxPolicy` 与 `permissions` 互斥不能同发。升级 codex 前跑 `bun run server/scripts/check-codex-schema.ts`。
- **codex `thread/revert`**：仓库里有（实验性，按 turn id 截断 durable history），0.148 未发布；发布后替代 RewindPicker 的 fork 截断做"真回滚"。
- **~~MCP 管理面板~~** ✅ 已完成（2026-08-27）：claude 详情抽屉 MCP tab 结构化面板（状态/工具数/scope/配置摘要/错误），
  重连（mcp_reconnect）与启停（mcp_toggle，持久化 settings 与 TUI 同语义）；query 通道加 extra 传参复用为动作通道。
  codex 侧维持 mcpServerStatus/list 只读直出。浏览器实测重连/禁用/启用全通过。
- **~~`generate_session_title` 控制通道~~** ✅ 已接入（2026-08-27）：首条真实 user 消息 × 首个 init 双条件触发
  （`maybeGenerateTitle`，按 sessionId 去重，/clear 后新会话再生成）；CLI persist 写 ai-title 进 transcript，
  discovery 标题链（custom-title > ai-title > summary > 首条消息）自动接住，无需 AnyPlane 侧落状态。实测 4 项全过。

## 更远的地平线（只记录，不动手）

两家官方都在建各自的 agent 互联（claude 2.1.224 跨会话 SendMessage/ListAgents；codex remoteControl/pairing），
但都是围墙花园。AnyPlane 同时长在两家协议上，是唯一可能成为**跨供应商 agent 消息路由**的位置。
handoff 是这个路由的雏形（一次性、单向、带上下文）；成熟形态是双向持续消息总线。
等两边协议出 research preview 再评估；lineage.json 字段设计不要锁死在"一次性接力"模型上。
