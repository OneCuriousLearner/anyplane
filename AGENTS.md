# AGENTS.md

AGENTS.md 只放读代码读不出的东西——设计哲学与决策原因；代码现状速查一律不写（保质期短且必然腐烂）。

## 项目定位

cc-remote：在手机/桌面浏览器中管理本机运行的官方 Claude Code 与 Codex 会话。
**不修改官方 CLI**——服务端以子进程方式驱动两家 CLI 的 headless 协议（Claude 走 stream-json NDJSON，Codex 走 app-server JSON-RPC），并统一翻译为 Claude stream-json 形状，前端与 WS 协议因此不分叉。
与 claude.ai/code 网页版桥接本地 CLI 用的是同一套本地协议。

## 常用命令

**本项目仅使用 Bun（>= 1.3.13；Windows 必须 1.3.15+ 或 canary）。绝不要用 npm / npx / yarn / pnpm。**

```bash
bun install          # 安装依赖（Bun workspaces: server + web）
bun run dev          # 开发模式：并行拉起 server(:7480) + Vite(:5173, 代理 /api 与 /ws)
bun run dev:server   # 仅服务端
bun run dev:web      # 仅 Vite
bun run build        # 构建前端到 web/dist
bun run start        # 生产模式：服务端托管 API + WS + 静态前端
bun run gateway      # 80/443 网关：按 ?mode=dev|prod 反代到 :5173 / :7480（无 token 需 --insecure）
```

端到端验证脚本（需服务端已启动，会真实调用 claude/codex CLI）：

```bash
bun run server/scripts/smoke.ts          # 最小协议验证
bun run server/scripts/e2e-ws.ts         # WS 全链路：attach/resume/set_model/问答
bun run server/scripts/e2e-approval.ts   # 权限审批链路
bun run server/scripts/e2e-slash.ts      # /compact 与 /btw
bun run server/scripts/e2e-branch-btw-goal.ts  # btw(side_question)/branch(懒分叉)/goal 全链路
bun run server/scripts/e2e-codex-goal.ts       # codex thread/goal 设置与清除
bun run server/scripts/e2e-push.ts             # Web Push 全链路（mock push service + RFC 8291 解密 + 能力 URL 审批 + 410 清理）
bun run server/scripts/e2e-rewind.ts     # rewind_files 与对话回滚
bun run server/scripts/e2e-codex.ts      # codex app-server 协议探针
bun run server/scripts/e2e-handoff.ts    # 接力双向链路（简报质量/现场确认/血缘）
```

服务端配置了 `authToken` 时，e2e 脚本需要 `CC_REMOTE_TOKEN` 环境变量才能连上 WS。

单元测试使用 Bun Test：

```bash
bun test                 # 跑全量（server/ + scripts/ + web/）
bun test server/         # 仅服务端测试
bun test web/            # 仅前端测试
```

- 测试文件统一命名为 `*.test.ts`，按目录分布：`server/src/backends/claude/`、`scripts/`、`web/src/`。
- `bun run build` 使用 Vite，只打包生产依赖图，测试文件不会进入 `web/dist`。
- 仓库仍有大量逻辑依赖 e2e 脚本验证；新增纯函数/工具优先补 `*.test.ts`，涉及真实 CLI 行为的链路改 e2e 脚本。

## 架构

两个 workspace：`server/`（Bun 服务端，无框架，直接用 `Bun.serve`）和 `web/`（React 19 + Vite + Tailwind 4）。共享根 `tsconfig.json`（strict, bundler resolution）。

### 服务端（server/src）

- **运行数据目录（约定）**：一切 cc-remote 自产的运行数据都放 `~/.cc-remote/`——`uploads/`（图片附件，hash 命名去重）、`trash/`（claude 会话回收站）、`lineage.json`（接力血缘）、`reasoning/`（codex 思考侧车）、`vapid.json` + `push-subscriptions.json`（推送密钥与订阅注册表）。**这些数据目录不做自动清理**，由用户自行管理。
- **`push.ts`** — Web Push 分发：inbox 事件（approval/done/error）→ 自实现 VAPID（RFC 8292）+ aes128gcm 载荷（RFC 8291/8188，不依赖 web-push 库——其 node:https 发送路径假定 TLS）。审批推送携带**能力 URL**（`/api/approval-action?k&r&d&s=<per-subscription secret>`），SW 通知按钮可直接审批不打开页面；该端点绕开 authToken（秘密只经加密推送投递，且仅对 pending 中的 requestId 有效）。死订阅（404/410）自动摘除。
- **`index.ts`** — 入口，REST + WebSocket 枢纽。核心是 **Hub 模型**：每个会话一个 `Hub`（WS 客户端、待审批、启动偏好与 goal/重键等会话级状态），`hubs: Map<sessionKey, Hub>`。所有 WS 消息在 `handleClientMessage` 中分发。另有全局收件箱频道 `/ws/inbox`（跨会话审批/完成/错误汇总）。
- **认证**：`auth.ts`——配置 `authToken` 后 `/api` 与 `/ws` 一律校验（Bearer 或 `?token=`）；**绑非回环 host 必须配 token，否则拒绝启动**。静态前端壳不鉴权。
- **sessionKey 编码**：Claude 会话 `s|<slug>|<sessionId>`、新会话 `n|<encodeURIComponent(cwd)>`、分叉会话 `b|<encodeURIComponent(cwd)>|<sourceSessionId>`（懒分叉：首条消息 spawn 时才 `--fork-session --resume`）；Codex 线程 `x|<threadId>`、新线程 `xn|<encodeURIComponent(cwd)>`。Claude 的 `parseKey` 靠 `listSessions()` 反查 cwd——slug 目录被删时 key 无法解析（已知限制）；Codex key 靠 `thread/read` 惰性解析 cwd。
- **Hub 生命周期不变量（重要）**：任何后端的会话句柄存活期间，其 Hub 不得删除——否则重连复用旧会话时事件会广播进已删 Hub（消息黑洞）。WS close 处理器按后端判定存活（`processManager.get` / `codexRuntime.get`）。
- **懒 spawn**：`attach` 只握手不启动 CLI；首条 user 消息 / 无启动参数等价物的控制请求才触发 `ensureSpawned`。未 spawn 时 model/mode/effort 选择缓存在 `hub.spawnOpts`，自定义 env 缓存在 `hub.pendingEnv`（必须排在首条 user 消息之前写入 stdin）。Codex 相反：`x|` 会话 attach 即 `thread/resume`（订阅实时事件），`xn|` 新线程保持懒启动。
- **后端抽象（backends/）**：`backends/types.ts` 定义统一接口（`AgentBackend`/`AgentSession`/`SessionSummary`/`TokenUsage`），`backends/registry.ts` 按 key 前缀分发。**统一消息边界是 Claude stream-json 形状**——Codex 事件翻译为该形状，前端与 WS 协议不分叉。
  - `backends/claude/`：`processManager.ts`（CLI 子进程、NDJSON 行泵、busy 语义、空闲回收、Windows 进程树清理）、`discovery.ts`（会话发现）、`tailer.ts`（外部会话 transcript 跟踪）、`protocol.ts`（**宽松解析原则：未知字段/未知 type 一律透传**）。
  - `backends/codex/`：`rpc.ts`（JSON-RPC stdio 客户端，-32001 过载退避）、`runtime.ts`（**单 app-server 进程托管全部线程**，按 threadId 解复用；ephemeral fork 收集器）、`translate.ts`（ThreadItem → stream-json 翻译）、`backend.ts`。
  - **busy 语义（重要）**：Claude 优先信任 `system/session_state_changed`；Codex 用 `thread/status/changed`（active/idle）+ 审批等待合成 requires_action。**running / requires_action 时绝不回收。**
- **Codex 关键实现点**：审批 `requestApproval` → 统一审批卡（accept/acceptForSession/decline/cancel），`turn/start` 强制 `approvalsReviewer: "user"`（覆盖用户配置的 auto_review）；权限模式近似映射 approvalPolicy+sandbox；**wire 枚举双轨**：`thread/start` 的 `sandbox` 是 kebab-case，`turn/start` 的 `sandboxPolicy` 是 camelCase（0.147.0 实测）；线程被其他进程持有时 resume 报 -32600（UI 显示"被占用"）；不 kill 线程进程，断开订阅后 app-server 30 分钟自动卸载。
- **`handoff.ts`** — 接力编排：源会话自摘要（Claude 源在线时走 `side_question` 控制通道，离线才 spawn `--fork-session --resume --bare` 一次性问答 / Codex `thread/fork ephemeral:true`）→ 目标会话播种首条消息（简报 + 现场确认指令）→ 血缘写 `~/.cc-remote/lineage.json`。进度事件推源 Hub。
- **`config.ts`** — `cc-remote.config.json` 或 `~/.config/cc-remote/config.json`，`CC_REMOTE_PORT` / `CC_REMOTE_HOST` / `CC_REMOTE_TOKEN` / `CLAUDE_CONFIG_DIR` 环境变量覆盖。

### 前端（web/src）

- `pages/SessionList.tsx`（会话列表）+ `pages/Chat.tsx`（聊天主界面，大部分交互逻辑在这）；`App.tsx` 只是双栏布局。
- 其他前端子系统索引：斜杠命令面板与拦截表（`Chat.tsx`）、推送订阅设置（`SessionList.tsx` + `lib/push.ts`）、推送深链 `#s=<key>`（`App.tsx`）。
- `lib/ws.ts` — WS 客户端（按 sessionKey 连接、自动重连），`ServerEvent` 联合类型即服务端广播的全部事件种类。
- `lib/blocks.ts` — 消息块模型：**live 流与历史加载共用同一套块归并逻辑**。增量（stream_event delta）与 assistant 块快照按 `message.id`+块序号归并定稿，不重复渲染。tool_use/tool_result 按 id 配对成一张卡。
- 过滤规则：`<system-reminder>`/isMeta 不进主抄本，sidechain（子代理）消息不入主流；`compact_boundary` 渲染为分隔线。

### 斜杠命令

> 全景审计（内建分类/别名表/codex 对应物）在 `docs/audits/2026-08-slash-commands.md`。命令清单与拦截映射以代码为准（`Chat.tsx` 的面板与拦截表、`index.ts` 与 codex `runtime.ts` 的服务端映射），本节只记决策原因。

- **总原则**：claude 尽量透传——CLI 是命令的仲裁者，透传等于自动跟进新版命令；codex app-server 对斜杠文本零解析（原样进模型），凡有 RPC 对应物的命令**必须前端拦截**，这是双后端命令不分叉的代价。
- **拦截放在 UI 层（send()）而非服务端**：斜杠命令的语义是会话导向的（分叉/重命名/导航新会话），前端拦截才能立即驱动导航与面板反馈；服务端只做能力通道（控制请求 / RPC）。
- **必须拦的判例**：`/btw` 官方在 headless 是空操作（JSX 被非交互分支置空），故走 `side_question` 控制通道；`/branch` 官方 headless 会写孤立 fork 文件但不切换，必须全形拦截（含参数）；`/exit` `/quit` headless 真杀进程，web 场景多为误触，拦下提示归档。
- **不拦的判例——`/clear`**：CLI 换 sessionId 续跑正是想要的新会话语义；服务端跟进做三层重键（Hub / 进程 map / 存活 WS 的 data.key，少一层即双进程或消息黑洞），`moved` 事件驱动前端导航。
- **rewind**：先 `processManager.dispose()` 再 `--resume-session-at` 重 spawn（先摘 map 再 kill，避免旧 onExit 污染新会话）；`rewind_both` 必须先等 `rewind_files` 成功应答，绝不能先截断对话。

## Windows 平台注意事项

- **Bun <= 1.3.14 存在监听 socket 被子进程继承的 bug**（oven-sh/bun#36936），服务端和 `scripts/dev.ts` 启动时都会检查版本并拒绝启动（可用 `CC_REMOTE_ALLOW_UNSAFE_BUN=1` 跳过）。已形成的死 PID 监听需重启 Windows 才能释放。
- `scripts/dev.ts` 故意不用 `bun --watch` 和 `bun run --cwd`：Windows watcher 会在异步 SIGINT 清理完成前杀掉 server；多层包装进程会吞 Ctrl+C。**不要用任务管理器强杀 server**，会绕过 `server.stop(true)` 与子进程树清理。
- claude 在 Windows 可能是 `.cmd`/`.bat`（需 `cmd.exe /d /s /c` 包装）或 `.exe`；`resolveClaudeCommand()` 优先选真实存在的 `.exe`。

## 已知限制（改相关功能前先读 README）

- compact 边界之前的消息不能作为 rewind 目标；`rewind_files` 只能回滚到有检查点的消息（spawn 时设了 `CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING=1`）；effort 运行时切换依赖 `update_environment_variables`，旧版 CLI 可能需重开会话。
- Codex 侧：无文件检查点（不支持 rewind_both）；rollout 不持久化 reasoning（cc-remote 侧车落盘 `~/.cc-remote/reasoning/<threadId>.jsonl` 并在历史读取时按 turn 时间窗回插）。
- 认证已实现（authToken），但**未配置 token 时严禁绑定非回环地址**。`GET /api/fs/list?path=`（新会话目录选择器用）会暴露本机目录结构，与"任意目录起会话 = 任意命令执行"同级风险。
- 跨网段不自建公网穿透：推荐 Tailscale serve/funnel 或自有反代 + TLS。

## 文档

`docs/claude-code/` 是官方 Claude Code 文档的本地 Markdown 镜像（gitignore，不进仓库），**协议/CLI/SDK 相关改动的重要开发参考**。用 `bun run docs:claude` 拉取或更新；入口见 `llms.txt`，全量见 `llms-full.txt`，单页在 `en/**/*.md`。

**长文本文档（审计报告/调研记录/规划）放 `docs/` 目录**（如 `docs/audits/2026-08-slash-commands.md` 斜杠命令全景审计、`ROADMAP.md` 后续规划），AGENTS.md 只保留最关键结论并引用路径。
