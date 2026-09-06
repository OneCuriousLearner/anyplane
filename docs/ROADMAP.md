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
- **codex `thread/revert`**：**已发布且非实验**（0.149 实测：协议宏无 `#[experimental]`，有独立集成测试，README 已文档化）。
  语义正是想要的：原地截断 durable history 到 `beforeTurnId` 之前、**线程 id 不变**、会中断进行中的 turn 并发 `thread/reverted`，
  比现在的 `thread/fork` 强（fork 每次回滚都留一条垃圾线程，且 sessionKey 变化需要导航）。

  **但当前用不了，卡在前置条件**：`thread/revert` 仅支持 paginated 线程
  （`thread_processor.rs`：非 paginated 直接 `invalid_request("thread/revert only supports paginated threads")`），
  而 `ThreadHistoryMode` 的 **默认值是 `Legacy`**（`protocol.rs` 的 `#[default] Legacy`），
  AnyPlane 的 `thread/start` 未传 `history_mode`，建出来的全是 legacy 线程。

  **要用它必须先迁移历史读取路径**：`thread/start` 传 `history_mode: "paginated"`，
  且 `readHistory` 从 `thread/read includeTurns:true`（legacy 专用，官方已标 deprecated）
  改为 `thread/turns/list` + `thread/items/list` 分页。这同时能解决大 rollout 打开慢的问题，
  但是独立一块工作量，不要顺手做——两种 history_mode 的线程会长期并存（用户既有会话都是 legacy），
  迁移后 `readHistory` 必须按 `thread.history_mode` 分流，回滚也要按模式选 revert / fork。
- **~~MCP 管理面板~~** ✅ 已完成（2026-08-27）：claude 详情抽屉 MCP tab 结构化面板（状态/工具数/scope/配置摘要/错误），
  重连（mcp_reconnect）与启停（mcp_toggle，持久化 settings 与 TUI 同语义）；query 通道加 extra 传参复用为动作通道。
  codex 侧维持 mcpServerStatus/list 只读直出。浏览器实测重连/禁用/启用全通过。
- **~~`generate_session_title` 控制通道~~** ✅ 已接入（2026-08-27）：首条真实 user 消息 × 首个 init 双条件触发
  （`maybeGenerateTitle`，按 sessionId 去重，/clear 后新会话再生成）；CLI persist 写 ai-title 进 transcript，
  discovery 标题链（custom-title > ai-title > summary > 首条消息）自动接住，无需 AnyPlane 侧落状态。实测 4 项全过。

## 抄本窗口化 / 虚拟列表（做过一版，回退了，记下踩坑）

现状：抄本全量挂载。已落地的只有**跟随滚动 rAF 合帧**（流式输出曾每 token 一次
smooth scrollTo，移动端积 jank）——这条是纯收益、已实测。

**另外两条试过都回退了，根因是同一个：与「打开会话即滚到最新」打架。**

`content-visibility:auto`（跳过视口外排版绘制）：视口外行按 `contain-intrinsic-size`
占位，首绘时 `scrollHeight` 被显著低估，滚到底会落空——实测打开长会话停在对话中段
并弹出「回到底部」按钮。绘制收益不值得换掉主行为。要用必须连初始定位一起重做
（例如初始定位完成前不启用、或对尾部若干行豁免）。

**窗口化（只渲染尾部 N 行、上翻扩窗）** 回退原因：

- 扩窗判定**不能用消息数**：活动分组把多条消息并成一行，rows 与 messages 差着量级，
  用消息数会导致条件恒真、持续扩窗
- 首绘时 `scrollTop` 恒为 0，若不加「初始定位已完成」守卫，会立刻扩窗并把视图钉在顶部，
  与自动滚到底互相打架
- 加了守卫后仍观察到初始位置不在底部：跟随滚动的 rAF 与新内容 commit 的时序，
  叠加 `behavior:'smooth'` 的动画目标会用到过期 scrollHeight

结论：要做就得连「初始定位」一起重设计——初始用 `auto` 直达底部并在 layout 阶段完成，
扩窗只由**用户主动输入**（wheel/touchmove）触发而非任意 scroll 事件。
**验收必须拿真实长会话**（> 200 行）跑，本仓库现有会话都不到 50 行，测不出来。

## 更远的地平线（只记录，不动手）

两家官方都在建各自的 agent 互联（claude 2.1.224 跨会话 SendMessage/ListAgents；codex remoteControl/pairing），
但都是围墙花园。AnyPlane 同时长在两家协议上，是唯一可能成为**跨供应商 agent 消息路由**的位置。
handoff 是这个路由的雏形（一次性、单向、带上下文）；成熟形态是双向持续消息总线。
等两边协议出 research preview 再评估；lineage.json 字段设计不要锁死在"一次性接力"模型上。
