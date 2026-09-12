# 交付编年史（已完成方向的交付记录）

> 从 ROADMAP 迁出（2026-09-12 拆分）。ROADMAP 只保留**未来时**——待排期方向与决策依据；
> 方向一旦标记完成，交付记录搬到这里，ROADMAP 原位只留一行索引（方向编号保持不变，
> 代码注释里的「方向N」仍能在 ROADMAP 搜到并跳转到本文对应节）。
>
> **本文是历史档案，不再更新**。内容反映交付当时的事实，后续演进以代码为准；
> 上游行为实测结论另见 `research/`，本文只记「我们做了什么、为什么这么做」。
> 按日期倒序。

---

## 方向十二（部分）：上量前的运行韧性——2026-09-12

前三项已按风险完成；第四项（会话列表 O(n)）只做了隔离实验与方向选择，尚未修改生产路径，仍在 ROADMAP。

- **全局异常兜底**：`uncaughtException` / `unhandledRejection` 已与 SIGINT/SIGTERM 汇入同一个
  关闭协调器，复用 `server.stop(true)`、双后端 `disposeAll()` 与 5 秒强退保护。
  正常信号退出码为 0，致命异常/超时为 1；关闭中再遇 fatal 只升级退出码、不重复清理。
- **Codex 上帝文件拆分**：`backends/codex/runtime.ts` 从约 1,435 行降到 353 行，形成
  `mapping.ts`（纯映射）、`history.ts`（历史双轨）、`session.ts`（单线程状态机）与
  `runtime.ts`（app-server/RPC/demux/注册表）四个边界。公开 import 面保持兼容，
  拆分不混入协议或行为变更；双轨历史、partial 输出、审批等待与子线程路由测试原样跟随。
- **编排层风险补测**：原「18 个无同名 test」的统计已过时（此前已有 2 个 hub 测试）。
  本轮新增 28 个 routes/hub 测试，覆盖全部 routes 的关键分支，以及 hub 的状态节流、
  attach 单播补放、回滚互斥、回调广播与死审批清理；进程关闭协调器另有 5 个测试。
  `/clear` 三层重键、真实 CLI attach/退出竞态、handoff 全链仍保留给 e2e，
  不为类型文件或一行转发制造形式测试。

## 方向十一（部分）：分发与首次上手——2026-09-12

- **npm bin 改 Node launcher**（`cli/anyplane.mjs`）。原 bin 指向 `#!/usr/bin/env bun` 的 `.ts`，
  没装 Bun 的机器上 npm shim 只抛 `'"bun"' 不是内部或外部命令`——不说缺什么也不说怎么装。
  目标用户多是 npm 装 claude/codex CLI 过来的，**没装 Bun 是常态而非例外**。
  **红线**：已在 Bun 运行时必须直接 `import` 不套子进程——多一层包装会吞 Ctrl+C，
  绕过 `server.stop(true)` 的子进程树清理（见 AGENTS.md 的 Windows 注意事项）。
  改造后 `bunx` 路径行为与改造前逐字节一致，回归面只有 Node 路径。
- README 英文化与中文分离（中文移至 `README.zh-CN.md`）；官网 iOS 表述分平台化、
  Bun 门槛同步全平台 ≥ 1.4.0。

## 方向七：长会话虚拟列表与初始定位重构——2026-09-09

尾部窗口化方案上线。**交付记录与两次回退的根因已独立成文**：
[`research/2026-09-12-transcript-windowing.md`](research/2026-09-12-transcript-windowing.md)
（回退实录的保质期远长于交付记录，且代码里多处注释指向它）。
尚未动手的 4 条可选优化留在 ROADMAP。

## 方向四：Codex 迁移 Paginated 历史模式与 thread/revert——2026-09-09

**定论**：`thread/revert` 已发布且非实验，原地截断 durable history + 保持 thread id + 会话 key 不变，
体验远好于 `thread/fork`（后者每次回滚产生一条孤立垃圾线程，且 sessionKey 变化需要重定向导航）。
但 `thread/revert` 仅支持 `history_mode: "paginated"` 的线程，因此必须系统性迁移历史读取链路。
迁移同时是**历史完整性的修复路径**——legacy `thread/read includeTurns` 缺三类 item，
codex 会话刷新后工具卡会凭空消失（上游实测细节见
[`research/2026-09-11-codex-upstream-behavior-notes.md`](research/2026-09-11-codex-upstream-behavior-notes.md)）。

前置：本机 codex 已从 0.148.0 升级 0.153.4（2026-09-09，单独 PR）。

**实施步骤（全部落地）**：
1. **新线程创建**：`thread/start` 显式传 `history_mode: "paginated"`（0.153 起上游已默认 paginated，
   显式传降为防御性措施）。
2. **历史读取分页重构**：`readHistory` 从已 deprecated 的 `thread/read includeTurns: true`
   迁移为 `thread/turns/list` + `thread/items/list` 分页，同时解决超大历史读取慢的问题。
3. **双轨兼容分流**：既有历史会话仍为 legacy，`readHistory` 按 `thread.history_mode` 自动分流；
   回滚也按 mode 选择：paginated 走 `thread/revert`，legacy 降级走 `thread/fork`。
4. **回滚时序**：`thread/revert` 原地生效后，前端清理当前 turn 之后的消息并刷新状态，无需换 key 导航。

**交付明细**：
- 服务端：`thread/start` 显式 paginated；`readHistory` 按 `historyMode` 双轨分流
  （paginated：turns/list **显式 asc**（默认降序，实测）+ items/list 跨 turn 分页归组；
  legacy：维持 thread/read）；`revertAt`/`historyModeOf`；`thread/reverted` 通知 →
  cli 系统消息入环广播；paginated resume 跳过 rollout 回扫（0.153 冷 resume 自动补发 tokenUsage）。
- port：`rewindConversation` 双轨——paginated 原地 revert（清 hub.cliRing 防重连复活
  "被回滚的未来"，广播 `reverted` 就地截断）；legacy 维持 fork + 导航。status 下发 historyMode。
- 前端：RewindPicker 按 historyMode 切换「回滚到此处」/「从此处分叉」文案；
  `reverted` 事件就地截断（**排除**所选消息——beforeTurnId 语义，与 claude rewound 的
  保留目标不同）；cli `thread_reverted` 触发权威历史重载（5s 回声去重）。
- 验证：`bun test` 446 全过（新增 5 项：双轨分页/asc/锚点/孤儿 turnId/reverted 通知）；
  `server/scripts/e2e-codex-paginated.ts` 全绿（真实服务端+模型：历史工具卡完整、
  revert 截断、原地续聊、legacy fork 降级）；分 turn 超时 + 失败轨迹 dump 入脚本。
- 已知边界：冷/热 resume 的 tokenUsage 补发差异与 writer lock 时序见 AGENTS.md；
  e2e 脚本需用唯一 cwd（xn key 跨次复用会撞服务端残留 Hub）。

## 方向五：Codex 实时流与思考增量对齐（Delta 通知接入）——2026-09-07

**定论**：此前 Codex 大多等 `item/completed` 整块到达才显示，思考过程依赖
`~/.anyplane/reasoning/` 侧车落盘，子代理转录需前端 8 秒定时轮询。接入 app-server
原生 Delta 通知后全面消灭（探针实测结论见
[`research/2026-09-11-codex-upstream-behavior-notes.md`](research/2026-09-11-codex-upstream-behavior-notes.md)，
其中「子线程事件直接推到父连接」推翻了 AGENTS.md 旧结论，无需 resume 子线程）。

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
- 验证：`bun test` 437 全过（新增 27 项）；`server/scripts/e2e-codex-streaming.ts` 真实
  server+模型全链路（A 正文/思考增量先于 result；B partial 先于终态且终态完整、append 增量标记；
  C 侧链转录先于 task_notification）；浏览器实测。
- 侧车维持原角色（离线历史兜底，live 从不读它）；**终态拉取无条件保留一次**（审查发现：
  live 转发使"桶非空即跳过"守卫常真，中途接入的客户端会永久缺早期 item——uuid 去重已幂等，
  代价仅终态一次 RPC）。
- **medium 审查修复轮**（8 条存活发现全修）：终态拉取改**全量重建**（append 会把早期 item 追加到
  live 覆盖段之后打乱时序）且桶已驱逐时丢弃结果（防重建出永不驱逐的僵尸 running 卡）；partial 改
  **append 增量**下发（全量重发在 32KB 缓冲 × 300ms 窗口下放大约 100 倍下行，远程/蜂窝场景不可接受；
  MCP 进度保持替换语义）；ToolCard 开合改派生值（用户点过以用户为准，不再被 streaming 翻转顶掉）；
  子线程注册收编 `registerSpawnedChildren` 单份实现（路由地基防两处拷贝漂移）；子线程未知 item 类型
  warn 留痕（对齐宽松解析红线）；e2e 脚本收编 `e2e-lib`（connect 支持 ANYPLANE_TOKEN——此前 lib 消费者
  对带 token 服务端全灭；新增 spawnAppServer 共享 stdio harness，消除与 e2e-codex.ts 的静默分叉）；
  e2e 总超时正确退 1（原先空断言集超时退 0，挂死会被 CI 当绿）。
- 已知边界：attach 中途接入运行中的 collab 子线程，注册前事件跳过（warn 留痕），终态拉取兜底。

## 方向六：架构解耦与上帝文件重构（BackendPort 抽象）——2026-09-07

**定论**：`index.ts`（1800+ 行）和 `Chat.tsx`（2000+ 行）承担了过多混合职责，双后端在 `index.ts`
散落 20 余处 `isCodexKey` 分支。此项为**纯架构解耦重构**，绝不与任何行为改动混杂，独立开分支推进。

**已交付**（PR #15）：
- **服务端 BackendPort 契约**：`backends/port.ts` 定义接口，`portFor(key)` 是编排层唯一的后端分支点；
  状态/句柄/生命周期/消息/回滚/侧问/查询/handoff/审批/REST 管理全域收编进 claude/codex 两个适配器（S1.1–S1.7），
  `isCodexKey` 从编排层清零（只剩 key 元数据读取）。装配经 `initBackendPorts` 显式注入 HubServices，
  适配器不反向 import 编排层。
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
零行为改动红线守住。未来评估第三后端（OpenCode/Gemini）时以 BackendPort 为承重结构。

## 方向三：公网接入（不自购云服务器）——2026-08-27

**定论**：优先级 Tailscale funnel > Cloudflare Tunnel > 家宽 IPv6 直连；都不需要自购 VPS。
三套配方 + 安全红线 + 手机蜂窝验收清单已写入 [`public-access.md`](public-access.md)
（含「通知投递 vs 审批回执」双路径模型与故障排查表——"通知到了、按钮点不动"的唯一根因是
publicUrl 入方向不可达）。authToken + 手机 ntfy 审批已实测通过。

| 方案 | 花费 | 第三方可见性 | 备注 |
|---|---|---|---|
| Tailscale funnel | 免费 | 边缘节点只转发加密 TCP，TLS 在本机终止 | 一条命令，首选 |
| Cloudflare Tunnel | 免费 | CF 边缘终止 TLS（可见明文），换来 Access 认证层 | 要稳定域名 + WAF 时选 |
| 家宽 IPv6 + DDNS | 零 | 无第三方 | 国内家宽多有公网 v6；注意运营商入站过滤与自身防火墙 |

## 控制通道与管理面三项——2026-08-27

原属 ROADMAP「已验证但暂不做」小节中已落地的部分；该小节保留的是**决定不做**的决策记录。

- **`claude agents --json --all` 状态增强**：`backends/claude/agents.ts` SWR 轮询
  （15s TTL + 后台刷新，listSessions 同步热路径零阻塞）；pid 文件优先、daemon 兜底——
  独有价值是 `kind:background` 后台 agent（无 pid 文件）的存活状态。
  （control.sock 深度集成维持**不做**的结论，理由留在 ROADMAP。）
- **MCP 管理面板**：claude 详情抽屉 MCP tab 结构化面板（状态/工具数/scope/配置摘要/错误），
  重连（mcp_reconnect）与启停（mcp_toggle，持久化 settings 与 TUI 同语义）；
  query 通道加 extra 传参复用为动作通道。codex 侧维持 mcpServerStatus/list 只读直出。
  浏览器实测重连/禁用/启用全通过。
- **`generate_session_title` 控制通道**：首条真实 user 消息 × 首个 init 双条件触发
  （`maybeGenerateTitle`，按 sessionId 去重，/clear 后新会话再生成）；CLI persist 写 ai-title
  进 transcript，discovery 标题链（custom-title > ai-title > summary > 首条消息）自动接住，
  无需 AnyPlane 侧落状态。实测 4 项全过。

## 方向一：推送通知（手机审批闭环的最后一环）——2026-08-25

- 服务端 `push.ts`：自实现 VAPID + aes128gcm（不依赖 web-push——其 node:https 假定 TLS）。
  订阅注册表 `~/.anyplane/push-subscriptions.json`（per-subscription 能力密钥），
  VAPID 密钥 `~/.anyplane/vapid.json`。
- inbox 事件（approval/done/error）fan-out；审批推送内容详细
  （工具名 + 命令摘要 + 项目名——锁屏脱敏交给 OS）。
- **通知直接审批**：能力 URL（`/api/approval-action?k&r&d&s=<secret>`），SW 通知按钮回 POST 即裁决，
  不开页面；绕开 authToken（能力模型），仅对 pending 中的 requestId 有效。
- 前端：sw.js push/notificationclick、订阅面板（列表页铃铛）、`#s=<key>` 深链。
- 验证：`server/scripts/e2e-push.ts` 15 项全过（mock push service + 独立实现解密反证加密正确 +
  能力审批 + 403 拒绝 + 410 清理）。

### webhook 通道——2026-08-27

配置项 `pushWebhooks` + `publicUrl`；ntfy http action 真一键审批，Bark/Server酱 落
`GET /api/approval-page` 确认页（防预览误触）；webhook 能力密钥 = HMAC(vapid 私钥, 渠道标识) 派生，
不落新状态。验证：`server/src/push.test.ts` webhook 段 7 项单测 +
真实服务端 mock 渠道活体全链路（审批 fanout/按钮 POST/确认页/done 扇出）。

### iOS 通知按钮降级——2026-09-12

**平台能力查证**：Safari（iOS 与 macOS）**完全忽略** notification `actions`，且不实现
`Notification.maxActions`（caniuse：iOS Safari 至 26.6 仍 Not supported；Apple Web Push 文档：
通知表面只保留 title/body/tag/data，图标固定为 Web App 自身图标）。按钮在 iPhone 上根本不渲染——
**「锁屏一键审批」这条核心卖点在 iOS Web Push 上不成立**，用户只看到「需要审批」却找不到怎么批。
152 之前的 Firefox 桌面同理。

`sw.js` 已按 `maxActions` 运行时探测降级（**不靠 UA**：iOS 上任何浏览器壳都是 WebKit）：
不支持时不挂按钮、裁决入口折进 body、`notificationclick` 直达 `GET /api/approval-page` 确认页
而非完整应用壳。**零服务端改动**——`validSecret` 本就同时接受订阅密钥与 webhook 密钥，
直接复用 approval-action 上已补全的能力密钥即可。单测锁死两条分支（`web/src/sw.test.ts`，
放 src 而非 public 旁边：public 会被原样拷进 `web/dist`）。

能力矩阵：Android/桌面 Chrome 一步（通知按钮），iOS/旧 Firefox 两步（通知 → 确认页）。
**iOS 上要回到一步审批只有一条路——ROADMAP 方向二的原生壳。**
