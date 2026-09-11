# AGENTS.md

AGENTS.md 只放读代码读不出的东西——设计哲学与决策原因；代码现状速查一律不写（保质期短且必然腐烂）。
在实测踩坑之前，先穷尽官方的协议正本，或者基于 Terminal 真实执行 `claude` / `codex` 命令得到的结果来推断。

**写入判定**（每加一句话前过一遍，2026-09-11 精简后立规）：
① 删掉它，改代码时会踩坑吗？会 → 留（红线与决策）。
② 读代码/文档 5 分钟能自己查到吗？能 → 不写（常量值、文件清单、字段路径、UI 布局、目录明细均属此类）。
③ 是上游 CLI 行为的实测结论吗？是 → 写进 `docs/research/` 并按版本标注，AGENTS.md 只留指针。

## 项目定位

AnyPlane：在手机/桌面浏览器中管理本机运行的官方 Claude Code 与 Codex 会话。
**不修改官方 CLI**——服务端以子进程方式驱动两家 CLI 的 headless 协议（Claude 走 stream-json NDJSON，Codex 走 app-server JSON-RPC），并统一翻译为 Claude stream-json 形状，前端与 WS 协议因此不分叉。
与 claude.ai/code 网页版桥接本地 CLI 用的是同一套本地协议。

## 常用命令

**本项目仅使用 Bun（>= 1.3.13；Windows 必须 1.4.0+）。绝不要用 npm / npx / yarn / pnpm。**

```bash
bun install          # 安装依赖（Bun workspaces: server + web）
bun run dev          # 开发模式：并行拉起 server(:7480) + Vite(:5173, 代理 /api 与 /ws)
bun run dev:server   # 仅服务端
bun run dev:web      # 仅 Vite
bun run build        # 构建前端到 web/dist
bun run start        # 生产模式：服务端托管 API + WS + 静态前端
bun run gateway      # 80/443 网关：按 ?mode=dev|prod 反代到 :5173 / :7480（无 token 需 --insecure）
```

端到端验证（需服务端已启动，会真实调用 claude/codex CLI）：`server/scripts/smoke.ts` 与 `server/scripts/e2e-*.ts`，每个脚本头部注释写明用法与覆盖点（WS 全链路 / 审批 / 斜杠命令 / 回滚 / push / 接力 / codex 各协议探针等）。

服务端配置了 `authToken` 时，e2e 脚本需要 `ANYPLANE_TOKEN` 环境变量才能连上 WS 与 REST（两侧统一由 `e2e-lib` 的 `connect()`/`apiFetch()` 读取）。

e2e 脚本默认不指定模型——anyplane 不显式传模型时完全不干预 CLI 选择（新会话与 resume 均不带 `--model`）。要让 e2e 走自定义/第三方模型，直接配 CLI 自己的默认值即可（均在 home 目录，不进本仓库）：claude 用 `~/.claude/settings.json` 的 `model`（或服务端进程环境变量 `ANTHROPIC_MODEL`，`childEnv` 会透传）；codex 用 `~/.codex/config.toml` 的 `model`。唯一例外是 `e2e-ws.ts` 的 `set_model`——那是被测链路本身，不是默认值配置。

单元测试使用 Bun Test（`bun test`，可按目录过滤）：测试文件统一命名 `*.test.ts` 就近放在被测模块旁；`bun run build` 只打包生产依赖图，测试文件不进 `web/dist`。仓库仍有大量逻辑依赖 e2e 脚本验证；新增纯函数/工具优先补 `*.test.ts`，涉及真实 CLI 行为的链路改 e2e 脚本。

## 架构

两个 workspace：`server/`（Bun 服务端，无框架，直接用 `Bun.serve`）和 `web/`（React 19 + Vite + Tailwind 4）。共享根 `tsconfig.json`（strict, bundler resolution）。

### 服务端（server/src）

- **运行数据目录（约定）**：一切 AnyPlane 自产的运行数据都放 `~/.anyplane/`（uploads/trash/lineage/reasoning/vapid 等）。**不做自动清理**，由用户自行管理。
- **`push.ts`** — Web Push 分发。决策点：自实现 VAPID + aes128gcm 载荷而**不依赖 web-push 库**（其 node:https 发送路径假定 TLS）；审批推送携带**能力 URL**，SW 通知按钮可直接审批不打开页面——该端点刻意绕开 authToken（秘密只经加密推送投递，且仅对 pending 中的 requestId 有效）；**订阅 endpoint 白名单**防注册 SSRF/通知窃听（inbox 事件扇出给全部订阅）；投递不跟随重定向；死订阅（404/410）自动摘除。**webhook 通道**（ntfy/Bark/Server酱）：配置即信任（无注册面无白名单），渠道方可读通知全文（非端到端加密）；能力密钥 = HMAC(vapid 私钥, 渠道标识) 派生不落状态；Bark/Server酱 的一键审批落 GET 确认页（GET 只渲染，防预览抓取误触）。
- **`log.ts`** — 结构化日志：零第三方依赖是刻意约束；`ANYPLANE_LOG_LEVEL` / `ANYPLANE_LOG_FORMAT=json` 控制。
- **`index.ts`** — 入口，REST + WebSocket 枢纽。核心是 **Hub 模型**：每个会话一个 `Hub`（WS 客户端、待审批、启动偏好、下行 cli 事件环形缓冲、goal/重键等会话级状态）。另有全局收件箱频道 `/ws/inbox`（跨会话审批/完成/错误汇总）。
- **认证**：`auth.ts`——配置 `authToken` 后 `/api` 与 `/ws` 一律校验（Bearer 或 `?token=`）；**绑非回环 host 必须配 token，否则拒绝启动**。静态前端壳不鉴权。**无 token 模式的两道跨源防护**（WS 无 SOP、text/plain 简单请求免 preflight，恶意网页可经浏览器打回环服务）：`Origin` 与 `Host` 须一致或同为回环（缺失放行=非浏览器客户端，`null` 拒绝=file:// 沙箱页）；非 GET `/api` 强制 `content-type: application/json`。配了 token 则两道检查不生效（token 即防线，行为与旧版一致）。
- **审批规则引擎**：`approvalRules.ts`——`approvalRules` 配置数组按序首中，介入点在 `sessionCallbacks().onApprovalRequest`（双后端一处覆盖），命中即自动裁决不入 pending。**设计红线**：规则只在服务端裁决，绝不进入推送能力 URL 链路（一键审批永远是人触发）；坏规则启动 fail fast（静默跳过 = 用户误以为保护已生效）；每次自动裁决必须广播 `approval_auto` 留痕（UI 系统卡 + 服务端日志）。匹配字段口径与 `summarizeInput` 对齐，不另起一套。
- **sessionKey 编码**：`s|`=Claude 会话、`n|`=新会话、`b|`=懒分叉（首条消息 spawn 时才 `--fork-session --resume`）、`x|`=Codex 线程、`xn|`=新线程（构造/解析正本在两后端 `keyFor` 与 `backends/port.ts` 的 `describeKey`，`port.test.ts` 锁死一一对应）。Claude 的 `parseKey` 靠 `listSessions()` 反查 cwd——slug 目录被删时 key 无法解析（已知限制）。
- **Hub 生命周期不变量（重要）**：任何后端的会话句柄存活期间，其 Hub 不得删除——否则重连复用旧会话时事件会广播进已删 Hub（消息黑洞）。WS close 处理器按后端判定存活（`processManager.get` / `codexRuntime.get`）。
- **懒 spawn**：`attach` 只握手不启动 CLI；首条 user 消息 / 无启动参数等价物的控制请求才触发 `ensureSpawned`。未 spawn 时 model/mode/effort 选择缓存在 `hub.spawnOpts`，自定义 env 缓存在 `hub.pendingEnv`（必须排在首条 user 消息之前写入 stdin）。Codex 相反：`x|` 会话 attach 即 `thread/resume`（订阅实时事件），`xn|` 新线程保持懒启动。
- **后端抽象（backends/）**：**统一消息边界是 Claude stream-json 形状**——Codex 事件翻译为该形状，前端与 WS 协议不分叉。`ClaudeSession` 与 `CodexSession` 保持结构化同形（契约见 `backends/types.ts` 末尾注释）；Hub 层以 `isCodexKey` 分发，没有注册表中间层。
  - `backends/claude/`：**宽松解析原则（protocol.ts）：未知字段/未知 type 一律透传**。`agents.ts` 的 daemon 视图独有价值是 background agent 存活态；control.sock 逆向协议版本锁死，刻意不用。
  - `backends/codex/`：**单 app-server 进程托管全部线程**（runtime.ts），按 threadId 解复用。
    **ThreadItem 覆盖以官方 union 为准**（`server/scripts/codex-schema-baseline/v2/ThreadItem.ts`）：live（`itemStarted`/`itemCompleted`）与历史（`itemsToHistory`）**必须同形**，否则刷新页面卡片凭空消失。`collabAgentToolCall`/`subAgentActivity` 有意只走侧栏桶不进主线；其余未知 type 一律 `log.warn` 留痕后透传/跳过，**不再静默丢弃**（曾丢 hookPrompt/dynamicToolCall/imageView/sleep/imageGeneration 五种，用了 hooks 或生图的会话抄本会凭空缺块）。
  - **busy 语义（重要）**：Claude 优先信任 `system/session_state_changed`；Codex 用 `thread/status/changed`（active/idle）+ 审批等待合成 requires_action。**running / requires_action 时绝不回收。**注意 **`system/init` 是每个 query turn 的首条流消息，不是 spawn 时发出**——纯控制查询（mcp_status 等）的会话在首个真实 turn 之前没有 init；initModel 入库即 `onStatusChange` 回放，前端在权威 idle 且不存在合法草稿时自清陈旧草稿（防服务端重启/断线后"生成中"永挂）。
  - **上下文占用（环形 UI 数据源）红线**：① claude 口径 = 最后一条**主线** assistant 消息的 `message.usage`（input+cache，不含 output）——**绝不能用 `result.usage` 的 input 侧，它是本 turn 各 API 调用的累计，多调用 turn 结束会虚增近翻倍**；codex = `thread/tokenUsage/updated` 的 `last.totalTokens`（`total` 是累计，别混）。② 窗口大小以官方 `get_context_usage` 的 `maxTokens` 为权威，模型名启发式只是首见兜底（实测 `k3-256k` 被旧启发式误判成 200k）；权威值按 model 持久化（同模型窗口不变），transcript 的 `message.model` 缺 `[1m]` 后缀故离线水合需靠 sessionId→model 反查。③ **离线水合 `hydratedContextOf` 严禁在列表端点逐行调用**（N 行 × 文件读）。
- **Codex 后端决策**：审批 `requestApproval` → 统一审批卡（accept/acceptForSession/decline/cancel），`turn/start` 强制 `approvalsReviewer: "user"`（覆盖用户配置的 auto_review）；权限模式近似映射 approvalPolicy+sandbox；线程被占（resume 报 -32600）UI 显示"被占用"，不 kill 线程进程。**历史与回滚双轨**：新线程显式 `historyMode:'paginated'` 锁死防回摆；回滚 paginated 走 `thread/revert`（原地截断持久历史，不换 key 不导航），legacy 降级 `thread/fork`；revert 成功即清 `hub.cliRing`（cliSeq 不动保持单调——否则重连补放会复活"被回滚的未来"），另有 `thread_reverted` 系统消息入环兜底触发前端权威重载。**实时流**：命令输出/进度 delta 经 300ms 追尾合并为 **partial tool_result**（`partial:true`，前端更新文本但保持运行态；cliRing 不占序号，终态 `aggregatedOutput` 兜底）；`plan/delta` 有意不接（experimental 且拼接不保证等于成稿）；子线程事件 demux 进侧栏桶，delta/turn/tokenUsage 级不进桶。
  **上游行为实测笔记（wire 枚举大小写双轨、writer lock、unload 60s、冷/热 resume 的 tokenUsage 补发差异、turns/list 降序、sqlite 化等）在 `docs/research/2026-09-11-codex-upstream-behavior-notes.md`——改 codex 后端前先读**（笔记按版本标注，随上游腐烂，以协议正本与最新实测为准）。
- **`handoff.ts`** — 接力编排：源会话自摘要（Claude 源在线时走 `side_question` 控制通道，离线才 spawn `--fork-session --resume --bare` 一次性问答 / Codex `thread/fork ephemeral:true`）→ 目标会话播种首条消息（简报 + 现场确认指令）→ 血缘写 `~/.anyplane/lineage.json`。
- **AI 会话标题**：首条真实 user 消息 × 首个 init 双条件齐备才触发 `generate_session_title`（懒 spawn 下首条消息常先于 init 到达，只挂一路会漏）；CLI `persist:true` 自写 ai-title 进 transcript，**AnyPlane 侧不落任何标题状态**。
- **`config.ts`** — 项目根目录 `anyplane.config.json`、`~/.anyplane/config.json`（均可选，但不允许放 `~/.config/`），`ANYPLANE_PORT` / `ANYPLANE_HOST` / `ANYPLANE_TOKEN` / `CLAUDE_CONFIG_DIR` 环境变量覆盖。

### 前端（web/src）

- 开发前端时不使用任何 emoji 以保持风格一致，统一使用图标库或自行绘制。
- 大部分交互逻辑在 `pages/Chat.tsx`；各子系统的入口文件读目录即得，不在此列。
- `lib/ws.ts` — WS 客户端。每条下行 `cli` 事件带服务端分配的单调 `seq`，客户端跨重连维护 `lastSeq` 高水位并在 `attach` 时通过 `fromSeq` 触发单播补发（照搬官方 Bridge 序号游标模型）；断线太久环底被挤掉时服务端推送 `replay_gap` 引导前端重载历史。
- **`lib/ingest.ts` — 消息 ingest 归并唯一实现**：live 流、tail 实时追加、历史批量加载三路共用，彻底消灭行为分叉。tool_use ↔ tool_result 跨消息配对成卡；先到的结果进 `pending` 乱序缓冲，待工具块落地时补齐修复；真孤儿推迟到批次收尾或权威 idle 时浮现为提示。
- **抄本滚动与尾部窗口化三条红线**（两次回退的根因，踩坑实录见 ROADMAP）：①初始定位必须先于窗口化——首个非空抄本 layout 阶段 `auto` 直达底部，完成前扩窗门控恒关；②扩窗只认向上滚动——本仓库不存在程序化向上滚动（跟随/回底/锚定补偿全向下，新增向上滚动必须套 ignoreScrollUntil 守卫）；③窗口粒度是渲染行不是消息数。Transcript 行 key 必须保持内容派生（msg.id / 首块 key），索引 key 会让扩窗平移 remount 掉已展开的思考/工具卡。翻页 prepend 前必须先 `preparePrepend()` 捕获锚点。
- 过滤规则：`<system-reminder>`/isMeta 不进主抄本，sidechain（子代理）消息不入主流；`compact_boundary` 渲染为分隔线。
- 后台任务侧栏三条血泪：① **`task_started` 是 live-only 不落盘**——中途接入的客户端只能靠 status 事件携带的服务端权威 `activeTasks` 水合补建 running 桶，否则首绘即终态；② 历史 `resp.subagents` **只回填「Agent/Task tool_use 在已加载历史窗口内、且主线 tool_result 缺失」的 subagent**——已完成的与调用在分页窗口之外的都不建桶（实测窗口外 20 个 subagent 被误判未完成 → 复活 → 水合判终态 → 30s 齐消失）；③ **终态语义只有一种**：挂 `evictAfter` 宽限期驱逐（镜像官方协调器面板 `PANEL_GRACE_MS`），驱逐即永久，外部会话（tailer 路径）以主线 tool_result 为唯一终态信号走同一套。codex 侧桶键统一为子线程 id；`collabAgentToolCall` 同时出主线 Collab 工具卡（Begin 建卡、End 配对），否则 codex 会话主线看不到任何工具调用。

### 斜杠命令

> 全景审计（内建分类/别名表/codex 对应物）在 `docs/audits/2026-08-slash-commands.md`。命令清单与拦截映射以代码为准（`Chat.tsx` 的面板与拦截表、`index.ts` 与 codex `runtime.ts` 的服务端映射），本节只记决策原因。

- **总原则**：claude 尽量透传——CLI 是命令的仲裁者，透传等于自动跟进新版命令；codex app-server 对斜杠文本零解析（原样进模型），凡有 RPC 对应物的命令**必须前端拦截**，这是双后端命令不分叉的代价。
- **拦截放在 UI 层（send()）而非服务端**：斜杠命令的语义是会话导向的（分叉/重命名/导航新会话），前端拦截才能立即驱动导航与面板反馈；服务端只做能力通道（控制请求 / RPC）。
- **必须拦的判例**：`/btw` 官方在 headless 是空操作（JSX 被非交互分支置空），故走 `side_question` 控制通道；`/branch` 官方 headless 会写孤立 fork 文件但不切换，必须全形拦截（含参数）；`/exit` `/quit` headless 真杀进程，web 场景多为误触，拦下提示归档。
- **不拦的判例——`/clear`**：CLI 换 sessionId 续跑正是想要的新会话语义；服务端跟进做三层重键（Hub / 进程 map / 存活 WS 的 data.key，少一层即双进程或消息黑洞），`moved` 事件驱动前端导航。
- **rewind**：先 `processManager.dispose()` 再 `--resume-session-at` 重 spawn（先摘 map 再 kill，避免旧 onExit 污染新会话）；`rewind_both` 必须先等 `rewind_files` 成功应答，绝不能先截断对话。

## Windows 平台注意事项

- **Bun <= 1.3.14 存在监听 socket 被子进程继承的 bug**（oven-sh/bun#36936），修复随 1.4.0 发布。服务端和 `scripts/dev.ts` 启动时都会检查版本并拒绝启动（可用 `ANYPLANE_ALLOW_UNSAFE_BUN=1` 跳过）。已形成的死 PID 监听需重启 Windows 才能释放。
- `scripts/dev.ts` 故意不用 `bun --watch` 和 `bun run --cwd`：Windows watcher 会在异步 SIGINT 清理完成前杀掉 server；多层包装进程会吞 Ctrl+C。**不要用任务管理器强杀 server**，会绕过 `server.stop(true)` 与子进程树清理。
- claude 在 Windows 可能是 `.cmd`/`.bat`（需 `cmd.exe /d /s /c` 包装）或 `.exe`；`resolveClaudeCommand()` 优先选真实存在的 `.exe`。

## 已知限制（改相关功能前先读 README）

- compact 边界之前的消息不能作为 rewind 目标；`rewind_files` 只能回滚到有检查点的消息（spawn 时设了 `CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING=1`）；effort 运行时切换依赖 `update_environment_variables`，旧版 CLI 可能需重开会话。
- Codex 侧：无文件检查点（不支持 rewind_both）；rollout 不持久化 reasoning（AnyPlane 侧车落盘 `~/.anyplane/reasoning/<threadId>.jsonl` 并在历史读取时按 turn 时间窗回插）。
- 认证已实现（authToken），但**未配置 token 时严禁绑定非回环地址**。`GET /api/fs/list?path=`（新会话目录选择器用）会暴露本机目录结构，与"任意目录起会话 = 任意命令执行"同级风险。
- 跨网段不自建公网穿透：三套免 VPS 配方（funnel/CF Tunnel/IPv6+DDNS）与安全红线见 `docs/public-access.md`。

## 文档

**已知未覆盖面**：`side_question` 与 `generate_session_title` 是 CLI headless 的**私有 subtype**，
官方 SDK 类型里没有（`PRINT_ONLY_SUBTYPES` 已登记）。**漂移检测覆盖不到它们**——上游改名或移除
只会表现为运行时静默失效，回归防线只有 e2e（`e2e-handoff.ts` / `e2e-slash.ts`），升级 CLI 后务必跑。

**协议正本优先于文档**：改协议相关代码前先查机器可读的正本，再查文档，最后才靠实测反推——
`@anthropic-ai/claude-agent-sdk`（官方公开 npm 包）的 `sdk.d.ts` 是 claude stream-json 的类型正本
（`check-claude-protocol.ts` 即以它为漂移基线数据源）；
`codex app-server generate-ts --experimental` 是 codex 的协议正本（`check-codex-schema.ts` 用它）。
历史教训：上下文窗口曾靠模型名启发式反推，而官方 `get_context_usage` 一直存在且给权威 `maxTokens`。

`docs/claude-code/` 与 `docs/codex/` 是两家官方文档的本地 Markdown 镜像（gitignore，不进仓库），**协议/CLI/SDK/app-server 相关改动的重要开发参考**——分别用 `bun run docs:claude` / `bun run docs:codex` 拉取，入口各见 `llms.txt`。

**长文本文档（审计报告/调研记录/规划）放 `docs/` 目录**，各子目录角色与命名约定见 `docs/README.md` 文档地图，AGENTS.md 只保留最关键结论并引用路径。

README 面向安装用户只保留常用项；用户向参考文档放 `docs/`：配置全集与推送 webhook 细节见 `docs/configuration.md`，域名网关与远程容器部署见 `docs/gateway.md`——改配置项/网关行为时同步这两份。

发版流程与权限模型见 `docs/releasing.md`：**tag 与根 package.json 版本必须同步**（CI 强校验），发布权限默认仅仓库 owner（npm Trusted Publishing 绑定本仓库 + release.yml，仓库不存 npm token）。
