# AnyPlane 后续规划（ROADMAP）

> 2026-08-24 立。前置：统一 Agent 控制面 8 阶段计划已全部完成（见 [plans/unified-agent-plane.md](plans/unified-agent-plane.md)）。
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

## 方向四：Codex 迁移 Paginated 历史模式与 thread/revert（待排期）

**定论**：`thread/revert` 已经发布且非实验，原地截断 durable history + 保持 thread id + 会话 key 不变，
体验远好于现在的 `thread/fork`（当前每次回滚产生一条孤立垃圾线程，且 sessionKey 变化需要重定向导航）。
但 `thread/revert` 仅支持 `history_mode: "paginated"` 的线程，而上游默认是 `legacy`，
因此必须系统性迁移历史读取链路。

**实施步骤**：
1. **新线程创建**：`thread/start` 显式传 `history_mode: "paginated"`。
2. **历史读取分页重构**：`readHistory` 从已 deprecated 的 `thread/read includeTurns: true`
   迁移为 `thread/turns/list` + `thread/items/list` 分页，同时解决超大 rollout 读取慢的问题。
3. **双轨兼容分流**：既有历史会话仍为 legacy，`readHistory` 须按 `thread.history_mode` 自动分流；
   回滚操作也按 mode 选择：paginated 线程走 `thread/revert`，legacy 线程降级走 `thread/fork`。
4. **回滚时序**：`thread/revert` 原地生效后，前端清理当前 turn 之后的消息并刷新状态，无需换 key 导航。

## 方向五：Codex 实时流与思考增量对齐（Delta 通知接入）——✅ 已完成（2026-09-07）

**定论**：当前 Codex 在 AnyPlane 中大多等 `item/completed` 整块到达后才显示，思考过程依赖 `~/.anyplane/reasoning/` 侧车落盘，子代理转录需前端 8 秒定时轮询。这完全可以通过接入 Codex app-server 原生的 Delta 通知全面消灭。

**探针实测（codex 0.148.0，本机默认模型 deepseek-v4-flash）**——三项推翻旧结论的实测：
- `item/agentMessage/delta`、`item/reasoning/textDelta` 真实到达且量大（单 turn 思考 delta 8000+）；`summaryTextDelta` 该模型不发。
- `item/commandExecution/outputDelta` 逐秒实时到达（命令真正跑起来时）；`terminalInteraction`、`item/mcpToolCall/progress` 按 schema 接入。
- **子线程事件直接推到父连接**（0.148 实测，含嵌套孙线程、thread/resume 之后同样成立）——AGENTS.md 旧结论"子代理转录不被父通知流转发"已过时；无需 resume 子线程，demux 路由转发即可。

**已交付**（PR 见 git log）：
- 服务端：`item/reasoning/summaryPartAdded`（摘要分段补 `\n\n`，仅见过 summary delta 时）；
  `outputDelta`/`terminalInteraction` 尾部追加、`mcpToolCall/progress` 取最新，300ms 追尾合并为
  **partial tool_result**（`partial:true` 标记——前端更新卡片文本但保持运行态；cliRing 不占序号，
  重连由终态 `aggregatedOutput` 兜底；缓冲尾留 32KB）。
- collab 父子事件链转发：`subAgentActivity started`/`collabAgentToolCall` End 注册子线程路由，
  子线程 `item/completed` 翻译为 claude sidechain 形状（`parent_tool_use_id`=子线程 id，uuid 与
  历史同口径）进侧栏桶；孙代理 `task_started` 携带 `parent_tool_use_id`+`spawn_depth` 血缘；
  子线程 reasoning 同写侧车（侧车条目新增 `itemId` 锚点，live/历史去重不叠加，顺带修复主线
  思考块重连补发可能重复的隐患）。子线程 delta/tokenUsage/turn 级事件不进桶（桶无草稿概念）。
- 前端：`pairToolResultPartialIn`（保 pending、过期丢弃、不进乱序缓冲）；工具卡 streaming
  时强制展开（Thinking 同款行为）；`taskStarted` 读取 `parent_tool_use_id`。
- 验证：`bun test` 434 全过（新增 24 项）；`server/scripts/e2e-codex-streaming.ts` 真实
  server+模型全链路（A 正文/思考增量先于 result；B partial 先于终态且终态完整；C 侧链转录
  先于 task_notification）；浏览器实测。
- 侧车维持原角色（离线历史兜底，live 从不读它）；**终态拉取无条件保留一次**（审查发现：
  live 转发使"桶非空即跳过"守卫常真，中途接入的客户端会永久缺早期 item——uuid 去重已幂等，
  代价仅终态一次 RPC）。
- 已知边界：attach 中途接入运行中的 collab 子线程，注册前事件跳过（warn 留痕），终态拉取兜底。

## 方向六：架构解耦与上帝文件重构（BackendPort 抽象）——✅ 已完成（2026-09-07）

**定论**：目前 `index.ts`（1800+ 行）和 `Chat.tsx`（2000+ 行）承担了过多混合职责。双后端在 `index.ts` 中散落了 20 余处 `isCodexKey` 分支。此项为**纯架构解耦重构**，绝不与任何行为改动混杂，独立开分支推进。

**已交付**（PR #15，commit 见 git log）：
- **服务端 BackendPort 契约**：`backends/port.ts` 定义接口，`portFor(key)` 是编排层唯一的后端分支点；
  状态/句柄/生命周期/消息/回滚/侧问/查询/handoff/审批/REST 管理全域收编进 claude/codex 两个适配器（S1.1–S1.7），
  `isCodexKey` 从编排层清零（只剩 key 元数据读取）。装配经 `initBackendPorts` 显式注入 HubServices，适配器不反向 import 编排层。
- **index.ts 拆分**：`hub/`（registry/callbacks/messages/lifecycle/status/broadcast）与 `push/` 物理切出（S2.1），
  `routes/` REST 四文件切出（S2.2），index.ts 收口为纯装配层。
- **Chat.tsx 拆解**：纯函数与斜杠拦截表下沉 lib（F1）→ 展示子组件 ChatHeader/Composer/DetailDrawer（F2）→
  useTaskBuckets（F3）→ useTranscriptIngest（F4）→ useSessionSocket（F5）。
- **merge 前审查修复轮**（medium 审查 8 条存活发现，1164e66）：ensureForSend 异常防护（挪进 try）、
  `deliverApproval` 共享投递核（自动/手动裁决同路）、approval_auto 摘要口径唯一化（`summarizeInput` 上移 util.ts
  成唯一正本，事件直接带 `detail`，前端删自建口径）、btw 双端共享信封、codex `threadRpc` 收敛与归档列表复用
  `toSummary`、/clear 重键加后端守卫、e2e-push 恢复全路径断言并修复 HTTP 鉴权缺口。

**验证**：`bun test` 410 全过（含新增 summarizeInput 口径单测）；e2e-ws / e2e-slash / e2e-approval / e2e-push
真实 CLI 全链路绿；浏览器实测会话列表、回收站归档/恢复、发消息、codex btw 均正常。
零行为改动红线守住（审查修复轮的每项都已在上方列明）。未来评估第三后端（OpenCode/Gemini）时以 BackendPort 为承重结构。

## 方向七：长会话虚拟列表与初始定位重构（待排期）

**定论**：长会话（>200 行）全量挂载 DOM 在移动端仍有内存和渲染压力。此前试过 `content-visibility:auto` 与简单行窗口化，均因破坏「打开会话即滚到最新」的默认体验而回退（踩坑实录见下方）。

**实施步骤**：
1. **解耦初始滚动与视口扩窗**：进入会话首绘时必须使用 `auto`（无缓动动画）确保 100% 精确停在底部，以此为硬前提再开启视口切片。
2. **扩窗触发限定用户手势**：扩窗仅允许由用户的主动向上滚轮或 touchmove 手势触发，严格禁止由数据变动触发的级联 scroll 事件引发扩窗。
3. **超长会话自动化回归**：编写能模拟 300+ 行消息及工具调用的 fixture，在浏览器自动化环境下严格验收打开会话、流式追加、手动上翻这三段的滚动稳定性。

## 方向八：自托管 Outbound Relay 与端到端加密（E2EE）评估

**定论**：坚持「不自营 SaaS 云中继服务」的产品底线，但公网访问中「通知到了、锁屏按钮点不动」（蜂窝网络入站不可达）是当前最大的可用性断点。

**探索方案**：
1. **轻量自托管 Relay 脚本**：提供用户可在自己的便宜 VPS 上一键运行的极轻量反向打洞中继（仅做 TCP / WebSocket 的公网 rendezvous 与帧中转，不做业务解析）。
2. **端到端加密（E2EE）**：AnyPlane 服务端与浏览器客户端直接协商一次性会话密钥（如 X25519 + ChaCha20-Poly1305），中继 VPS 仅转发密文，无法窥视命令与代码内容，彻底保住本地主权与隐私防线。

## 已验证但暂不做的（决策记录）

- **~~daemon socket 深度集成~~（保留结论）+ ~~`claude agents --json --all` 状态增强~~** ✅ 已接入（2026-08-27）：
  `backends/claude/agents.ts` SWR 轮询（15s TTL + 后台刷新，listSessions 同步热路径零阻塞）；
  pid 文件优先、daemon 兜底——独有价值是 `kind:background` 后台 agent（无 pid 文件）的存活状态。
  control.sock 深度集成维持原结论不做：协议 proto 版本锁死，只能 opportunistic 增强，不当基石。
- **codex token_budget**：thread/goal/set 协议字段已透传，UI 不做——token ≠ 钱，预算心智账户建不起来；等真实无人值守批处理场景出现再点亮。
- **codex `permissions` named-profile 迁移**：`sandboxPolicy` 未 deprecated，不急；迁移时注意 `sandboxPolicy` 与 `permissions` 互斥不能同发。升级 codex 前跑 `bun run server/scripts/check-codex-schema.ts`。
- **codex `thread/revert` 与 paginated 迁移背景**：见上方「方向四」。
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
