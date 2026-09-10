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

## 方向四：Codex 迁移 Paginated 历史模式与 thread/revert——✅ 已完成（2026-09-09）

**定论**：`thread/revert` 已经发布且非实验，原地截断 durable history + 保持 thread id + 会话 key 不变，
体验远好于现在的 `thread/fork`（当前每次回滚产生一条孤立垃圾线程，且 sessionKey 变化需要重定向导航）。
但 `thread/revert` 仅支持 `history_mode: "paginated"` 的线程，而上游默认是 `legacy`，
因此必须系统性迁移历史读取链路。

**前置一：本机 codex 0.148.0 已落后（npm latest 0.153.4），升级单独 PR 处理（~~等待排期：
定 PR #17 合入后从 master 另开 `chore/upgrade-codex` 分支~~ → ✅ 已升级 0.153.4，2026-09-09）**。
步骤：升级 CLI → `check-codex-schema.ts` 对比基线 → 刷新 `codex-schema-baseline/` →
回归方向五 e2e（`e2e-codex-delta.ts` 探针 + `e2e-codex-streaming.ts` 断言）→ `bun test`。
已预查 0.153.x 源码（本地快照含 rust-v0.153.4 tag）：方向五依赖的 delta 通知 wire 名全部仍在
（`item/agentMessage/delta`、`item/commandExecution/outputDelta`、`item/mcpToolCall/progress` 等）。
paginated 迁移应以升级后的最新协议为基线，避免按 0.148 语义开发再返工。

**0.153.4 升级实测结论（2026-09-09 探针，改变方向四前提）**：
- schema 漂移 118 处**全部为新增式**（project/*、turn/settings/update、thread/timeline/list、
  bedrock、mcp event stream 等），无任何已有方法/通知被移除或改名；方向五 wire 名逐项核对仍在。
  值得注意的新形状：ThreadItem 新增 `functionCallOutput` variant（translate 未知类型 warn 留痕路径覆盖）、
  `agentMessage` 新增可空 `delivery`/`questions` 字段、`subAgentActivity` kind 新增 `completed`
  （translate 已处理）、`CollabAgentTool` 新增 sendMessage/followupTask/interruptAgent/listAgents。
- **`thread/start` 默认 `historyMode` 已切 paginated**（实测新线程返回值）——上方"上游默认是 legacy"
  已过时，实施步骤 1 从"必须显式传"降为"防御性显式传"。
- legacy `thread/read includeTurns` **仍缺** commandExecution/collabAgentToolCall/reasoning
  （0.153.4 实测复现）——方向四作为历史完整性修复路径的结论成立且更硬。
- `thread/turns/list` 对 legacy 线程可用但内嵌 items 只有 user/agentMessage；
  `thread/items/list` 对 legacy 报 `-32601 not supported yet`，仅 paginated 线程可用且 item 完整
  （条目形状 `{turnId, item}` 包装，非裸 ThreadItem）——方向四双轨分流时 legacy 会话
  只能继续走 `thread/read includeTurns`（残缺现状），无法借用分页 API 补齐。
- e2e-codex-streaming 的 C3/C4/Z 断言依赖"主模型用 collab 工具后收敛"，
  实测 deepseek-v4-flash 在 0.148.0 与 0.153.4 **同现 spawn→wait→再 spawn 死循环**
  （直连 app-server 无 AnyPlane 介入也复现）——上游/模型侧 flake，与升级无关；
  回归时该三项失败不代表协议回归，看 A/B/C1/C2 即可。

**前置二：上游线程持久化已切 sqlite（本机已生效）**。
`~/.codex/sessions/` 的 rollout jsonl 停止新增（本机最新一个 2026-08-29），改存
`~/.codex/*.sqlite`（state_5/logs_2/goals_1 等，上游 `codex-rs/state/` 模块）。影响面：
- `hydrateContextUsage` 的 rollout 尾部回扫**静默失效**——resume 后环形 UI 回退为"首个新 turn 才显示"
  （代码按"找不到即隐藏"设计，优雅降级不报错）。迁移时换水合数据源（`thread/turns/list` 或接受等首个 turn）。
- 历史读取走 `thread/read` RPC 不受影响（app-server 自读 sqlite）；归档/删除走 RPC 不受影响；
  reasoning 侧车是 AnyPlane 自存（`~/.anyplane/reasoning/`）不受影响。
- "超大 rollout 读取慢"的原动机随之消解一半：sqlite 时代历史读取本就该走
  `thread/turns/list` + `thread/items/list` 分页（方向四主目标不变，理由更充分）。
- **⚠ 实测发现（0.148，master 上也存在）**：legacy `thread/read includeTurns` 返回的 turns
  里**没有 commandExecution / collabAgentToolCall / reasoning** 三类 item（userMessage /
  agentMessage / subAgentActivity / fileChange 正常）——codex 会话刷新后工具卡凭空消失，
  子代理桶的终态拉取也缺工具对（thinking 有侧车兜底）。rollout 时代的老线程经当前二进制读取同样缺，
  说明是重建/持久化路径而非单线程数据问题。0.153 源码中 `thread/items/list` 已对 sqlite 线程实现
  （rollout 线程报 Unsupported）——方向四的 paginated 迁移因此不仅是 revert 体验优化，
  更是**历史完整性的修复路径**；升级 PR 需顺手验证 0.153 的 legacy 读取是否也缺。

**实施步骤**：
1. **新线程创建**：`thread/start` 显式传 `history_mode: "paginated"`。
2. **历史读取分页重构**：`readHistory` 从已 deprecated 的 `thread/read includeTurns: true`
   迁移为 `thread/turns/list` + `thread/items/list` 分页，同时解决超大 rollout 读取慢的问题。
3. **双轨兼容分流**：既有历史会话仍为 legacy，`readHistory` 须按 `thread.history_mode` 自动分流；
   回滚操作也按 mode 选择：paginated 线程走 `thread/revert`，legacy 线程降级走 `thread/fork`。
4. **回滚时序**：`thread/revert` 原地生效后，前端清理当前 turn 之后的消息并刷新状态，无需换 key 导航。

**交付记录（PR 见 git log，全部按上方步骤落地）**：
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

## 方向七：长会话虚拟列表与初始定位重构

✅ **已完成（2026-09-09，尾部窗口化方案）**：`web/src/hooks/useTranscriptScroll.ts` 承接 Chat 全部滚动逻辑，
窗口纯函数在 `web/src/lib/transcriptWindow.ts`（单测覆盖）；Chat/Transcript 接入切片与稳定 key。

- **初始定位（硬前提）**：首个非空抄本在 `useLayoutEffect` 以 `auto` 直达底部（绘制前完成），
  完成前扩窗门控恒关；会话切换的重置效应跳过首次挂载（实测：挂载即重置会清掉同帧 layout 锚点，
  扩窗门控永久关闭——fixture 首跑即逮到）。
- **扩窗门控**：仅「方向向上 + 距顶 < 480px + 初始定位完成」触发；本仓库不存在程序化向上滚动
  （跟随/回底/锚定补偿全部向下），方向向上 ⟺ 用户主动上翻（滚轮/touch/拖滚动条全覆盖）。
  锚定补偿与回底重置的钳位滚动套 200ms 豁免窗防回链。
- **窗口策略**：行数 >120 启用，初始只挂尾部 80 行，上翻按 60 行/段扩窗；prepend 后按
  scrollHeight 增量补偿 scrollTop（视口内容不跳）。atBottom 期间窗口随行数漂移保持尾部
  （跟随滚动钉底，顶部卸载不可见）；离开底部冻结起点；回到底部（滚动或 ↓ 按钮）恢复尾窗收敛。
  只向上生长不向下收缩——超长会话读到顶部时 DOM 会涨回全量，记录的取舍。
- **稳定 key**：Transcript 行 key 从索引改为内容派生（msg.id / 首块 key），
  扩窗平移不再 remount 已展开的思考/工具卡。
- **验收 fixture**：`web/transcript-fixture.html`（仅 Vite dev 提供，不进生产构建）合成 322 行
  混合抄本 + 分页数据源（首载 46 轮、20 轮/页 prepend），`?autorun=1` 自检四段场景
  （打开定位/流式追加有界/上翻扩窗+翻页锚定无跳变/回底收敛），
  chrome-devtools MCP 实测 14 断言全绿；真实会话集成冒烟（含本会话直播流）通过。

**实测逮出并修复的两个存量 bug**（2026-09-09 用户报告长会话复现）：
1. **claude 历史 300 条硬截断**：`readHistory` 固定 `slice(-300)`，更早消息永不下发——
   窗口化上翻后才用户可见。已改为 `before` 行号游标分页（页间零重叠，`subagents` 仅首页下发），
   前端窗口扩到顶且 hasMore 时自动翻页 + 锚定 prepend（`ingest.prependHistoryMsgs`：
   全量重建工具索引顺带完成跨页配对）。实测 860 条会话 3 页、1726 条会话 6 页完整到顶，
   首条消息逐字命中。
2. **历史 agent 桶复活**：`subagents` 全量下发但主线消息被 300 条窗口截断，窗口外 agent 的
   tool_use 不在 `finished` 集合 → 全被误判未完成建桶 → hydrateTasks 判终态 → 30s 齐消失。
   修复为 `selectHistoryBuckets` 纯函数口径：只为「调用在已加载窗口内且未配对终态」的建桶，
   窗口外/已完成一律不建（真在跑的由 status activeTasks 权威水合兜底）。

**审查修复轮（/code-review medium，8 项全修）**：翻页响应的分页纪元守卫（在途期间
applyHistory/reset 重置过坐标系即作废）+ catch 补会话切换守卫（错误卡不再写进新会话）；
replay_gap 重载按「已加载数+500」保载拉取（append-only 下零漂移；tail_reset 内容截断
仍全量重置）；hasMore 期间推迟孤儿 tool_result 浮现（其 tool_use 可能在未加载页，
翻页时跨页配对完成）；翻到更早页时对首页留存的 subagents 做 add-only 补建桶；
扩窗 setState 走 flushSync 与同 lane 的 WS draft 更新隔离（锚定补偿不再混入尾部增量）；
哨兵 JSX 合一（对齐 fixture 形态）；onReachTop 与哨兵对 codex 关门（防方向四落地后
渲染出死控件）。

**后续可选优化（只记录，不动手）**：
1. **向下收缩**：读到顶部后裁掉尾部行，让 DOM 在任意阅读位置都有界（现策略只向上生长，
   翻到顶即全量挂载）。需要底部锚定 + 回底恢复路径，复杂度比本轮高一档，等真实超长会话
   （>500 行）使用反馈再评估。
2. **codex 客户端侧分页**：目前服务端分页读全再一次性下发，超长 codex 线程首载 payload
   若成问题再做。接通时必须同时放开哨兵/onReachTop 的 codex 关门（F8 修复处），否则没入口。
3. **子代理侧链转录翻页**：`SUBAGENT_HISTORY_LIMIT=150` 是首载防 payload 爆炸的取舍，
   深挖老 agent 完整转录需要桶内翻页，等需求出现再做。
4. **翻页预取**：windowStart 接近 0 时提前拉下一页，消掉翻到顶后的加载等待感（纯体验项）。

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

## 抄本窗口化 / 虚拟列表（✅ 已落地第三版，见「方向七」；回退实录保留）

现状：**尾部窗口化已上线**（useTranscriptScroll + transcriptWindow，验收 fixture
`web/transcript-fixture.html` 四段场景全绿）。此前两次回退的根因记录如下，
第三版的每条设计约束都直接对应其中一个坑。

跟随滚动 rAF 合帧（流式输出曾每 token 一次 smooth scrollTo，移动端积 jank）
是早期落地的纯收益项，第三版沿用。**另外两条试过都回退了，根因是同一个：
与「打开会话即滚到最新」打架。**

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
