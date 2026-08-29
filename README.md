# AnyPlane

Claude Code / Codex 远程工作管理工具：在手机（或桌面）浏览器中管理运行在本机/容器上的官方 Claude Code 与 Codex 会话。

## 原理

不修改官方 CLI。服务端以子进程方式驱动两家 CLI 的 headless 协议：

```
claude --print --verbose --input-format stream-json --output-format stream-json \
       --include-partial-messages --allow-dangerously-skip-permissions \
       --permission-prompt-tool stdio [--resume <session-id>]

codex app-server --stdio   # JSON-RPC 2.0 over NDJSON，单进程托管全部线程
```

Claude 侧 stdin/stdout 走双向 NDJSON（user 消息 + control_request/response），与官方 claude.ai/code 网页版桥接本地 CLI 用的是同一套本地协议；Codex 事件在服务端翻译为同一消息形状，前端与 WS 协议零分叉。

## 功能

- **双后端**：Claude Code（stream-json 子进程）与 **Codex**（`codex app-server` JSON-RPC）统一接入，同一 UI 管理两个 agent 的会话；Codex 事件在服务端翻译为统一消息形状，前端零分叉
- **接力（handoff）**：一键让另一个 agent 接续本目录工作——源会话自写交接简报（Claude 在线走 side_question / 离线 fork-session；Codex ephemeral fork），目标会话带简报进场先确认现场再继续；血缘落盘 `~/.anyplane/lineage.json`
- **分叉（branch）**：当前会话一键开分支（`--fork-session` 懒启动，首条消息才真正分叉），携带全部历史，原会话不动
- **目标（goal）**：设定完成条件，agent 持续工作直到达成（Claude `/goal` Stop hook / Codex `thread/goal`），顶栏 chip 显示进度与 token 统计
- **项目工作台**：会话按项目目录分组（git 分支 + 各后端计数）
- **Token 计量**：只计 token 不计费用，分后端分桶（input/output/cache/reasoning），不跨后端合并
- **会话列表**：扫描 `~/.claude/projects/**/*.jsonl` + `thread/list`，展示标题/最近活动/状态徽标（busy/idle/waiting/offline）；新会话首条消息后自动生成 **AI 标题**（官方 `generate_session_title` 通道，persist 进 transcript）；外部会话存活状态 = pid 文件 + `claude agents --json --all` daemon 视图双源（后台 agent 也能识别）
- **接续对话**：按目录 + session id 精准 `--resume`；Codex 按 `thread/resume`
- **流式输出**：`--include-partial-messages` 增量渲染，草稿气泡实时过 Markdown；assistant 块快照按 `message.id`+块序号归并定稿，不与增量重复
- **Markdown 渲染**：react-markdown + GFM（表格/任务列表/删除线），代码块等宽底色
- **工具卡片**：tool_use 与 tool_result 按 id 配对成一张卡（名称+摘要一行 trace，展开看参数与结果，失败染红）；思考块默认折叠
- **图片附件**：粘贴/选择图片发送（Claude content blocks / Codex localImage 落 `~/.anyplane/uploads/`），历史图片默认展示
- **消息标签**：斜杠命令回显（`<command-name>`）渲染为命令 chip，本地命令输出剥 ANSI 折叠，`<system-reminder>`/isMeta 不进主抄本，子代理 sidechain 消息不入主流
- **状态利用**：`system/init` 提供模型/权限模式徽标；initialize 握手返回斜杠命令清单（含描述）驱动命令面板；`result` 生成回合摘要；`compact_boundary` 渲染为上下文压缩分隔线
- **运行时切换**：模型（set_model，StatusPill 透传显示各档**实际配置的模型名**——开面板即查 `ANTHROPIC_DEFAULT_*_MODEL_NAME`，未配置降级 tier 名）、权限模式（set_permission_mode，Codex 侧近似映射 approvalPolicy+sandbox）、effort、中断（interrupt）、/compact
- **权限审批**：`can_use_tool` / `requestApproval` 统一推到 UI 审批卡片；Codex 侧强制 `approvalsReviewer: "user"`（覆盖用户配置的 auto_review）；或配置 `permissionPolicy: "bypass"` 全自动
- **推送通知**：Web Push（VAPID）——锁屏/关掉页面也能收到审批/完成/错误通知；审批通知带**允许/拒绝按钮，不打开页面直接裁决**；点击通知深链直达会话。另有 **webhook 通道**（ntfy / Bark / Server酱）——国内 Android 无 FCM 环境的出路，Server酱可直达微信；ntfy 保留通知内一键审批，Bark/Server酱 点链接进确认页裁决
- **会话详情抽屉**：context 分类用量 / **MCP 管理**（claude 侧结构化面板：状态/工具数/scope，重连与启停——启停持久化到 settings，与 TUI 同语义）/ 设置（只读控制查询）
- **斜杠命令面板**：输入 `/` 弹出全量可滚动清单（自有命令置顶，键盘导航）；claude 命令尽量透传，codex 有对应物的命令前端拦截映射（app-server 无斜杠解析）
- **回滚（rewind）**：消息选择器——仅回滚文件（文件检查点）、仅回滚对话、对话+文件（先确认检查点恢复成功再截断对话）；Codex 无文件检查点，提供"从此处分叉"（原线程不动）
- **后台任务**：task_started → task_notification 活动任务芯片，可 `stop_task` 手动停止
- **会话改名**：Claude 离线会话追加 custom-title（官方 /rename 同形）；Codex `thread/name/set`（会话内 `/rename <名>` 亦可）
- **归档与回收站**：归档只移入 `~/.anyplane/trash/`（不物理删除），回收站可恢复；物理删除留给用户自行处理
- **收件箱**：`/ws/inbox` 跨会话审批/完成/错误汇总；桌面通知（页面隐藏时）；标题角标；PWA 可添加到手机主屏

## 运行

要求：Bun >= 1.3.13（Windows 请用 1.4.0+，见下方说明），PATH 中有已登录的官方 `claude` CLI；使用 Codex 后端需要 PATH 中有 `codex` CLI（>= 0.147，服务端自动 spawn `codex app-server --stdio` 并按其配置认证）。支持 Windows 与 Linux。

**npm 包（推荐，装完即跑）**：

```bash
bunx anyplane            # 启动服务端（默认 :7480），托管 API + WebSocket + 前端
bunx anyplane gateway    # 可选：80/443 域名网关（见下方「域名访问」）
```

配置文件与源码方式完全一致（`./anyplane.config.json` → `~/.anyplane/config.json` → 环境变量），
运行数据同样在 `~/.anyplane/`。前端已随包预构建，无需 clone 仓库。

**源码方式（开发用）**：**本项目仅使用 Bun，请勿使用 npm / npx / yarn / pnpm。** 依赖安装、脚本与运行时一律走 `bun`；用 npm 会产生错误的 lockfile、错误的进程树，并在 Windows 上更容易留下僵尸端口。

```bash
bun install
bun run build      # 构建前端到 web/dist
bun run start      # 启动服务端（默认 :7480），托管 API + WebSocket + 前端
```

开发模式（前端热更新）：

```bash
bun run dev          # 并行拉起 server + Vite（推荐）
bun run dev:server   # 仅服务端 :7480
bun run dev:web      # 仅 Vite :5173，代理 /api 与 /ws 到 7480
bun run gateway      # 对外 80/443 网关（见下方「域名访问」）
```

## 配置

项目根目录 `anyplane.config.json`、`~/.anyplane/config.json`（均可选）。
根目录的配置文件**已被 gitignore**（机器相关路径不应入库），可复制 `anyplane.config.example.json` 后按需修改：

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

- `host`: 监听地址，默认 `127.0.0.1`（仅本机）。**绑定非回环地址（如 `0.0.0.0`）必须同时配置 `authToken`**，否则拒绝启动——局域网内的任何人都能起会话 = 任意命令执行。
- `authToken`: 访问令牌（可选）。配置后 `/api` 与 `/ws` 一律要求 `Authorization: Bearer <token>` 或 `?token=<token>`；静态前端壳不鉴权（JS 中无敏感数据）。局域网模式启动时终端会打印带 token 的扫码 URL 二维码，手机扫码即入；浏览器端令牌存 localStorage，401 时会弹出令牌输入页。
- `permissionPolicy`: `"ask"`（默认，转发 UI 审批）| `"bypass"`（spawn 即 bypassPermissions）
- `detachRecycleMs`: 已收到 Claude `session_state_changed` 时，客户端全断、主会话 `idle` 且无 Claude 后台任务后多久回收子进程（默认 5 分钟）；`running` / `requires_action` / 后台 Agent、workflow、shell 任务期间绝不回收
- `idleTimeoutMs`: 无权威状态事件时的回退回收延迟（默认 30 分钟）
- 环境变量覆盖：`ANYPLANE_PORT`、`ANYPLANE_HOST`、`ANYPLANE_TOKEN`、`CLAUDE_CONFIG_DIR`
- **运行数据目录**：一切 AnyPlane 自产数据都在 `~/.anyplane/`（图片附件、会话回收站、接力血缘、codex 思考侧车、推送密钥与订阅），不自动清理，由用户自行管理
- **推送通知（Web Push）**：在列表页铃铛面板订阅；需 HTTPS（Tailscale serve/funnel 或自有反代）或 localhost；iOS 需先把站点**添加到主屏幕**再从主屏图标打开订阅（Safari 页签内不提供推送）。Android 国内无 FCM 环境不可达（已知边界）
- **推送 webhook 通道（ntfy / Bark / Server酱）**：与 Web Push 订阅并列接收同一份通知，配置文件管理：

  ```json
  {
    "publicUrl": "https://AnyPlane.example.com",
    "pushWebhooks": [
      { "type": "ntfy", "topic": "换成长随机串", "server": "https://ntfy.sh", "token": "可选" },
      { "type": "bark", "url": "https://api.day.app/你的Key" },
      { "type": "sct", "sendkey": "SCT开头的SendKey" }
    ]
  }
  ```

  - `publicUrl` 是 AnyPlane 的公网基准地址（不带尾斜杠）。webhook 通知里的深链和审批按钮需要绝对 URL——不配也能发，但只有纯文本（标题+摘要）。
  - 直接审批分级：**ntfy** 通知内按钮一键允许/拒绝（app 内 POST，不打开页面）；**Bark/Server酱** 点链接进确认页（两个按钮，避免链接被预览抓取误触发审批）。
  - 渠道凭证 = 通知保密边界：ntfy topic 要用不可猜的长随机串（或配 token），Bark key / SendKey 同理。与 Web Push 不同，webhook 渠道方（ntfy.sh/Apple/腾讯）能读通知全文。
  - 手动验证：配置后重启服务端，让某会话触发一次审批（如让它写文件），观察 ntfy app / Bark / 微信是否收到并能否一键裁决；**铃铛面板的"测试通知"按钮**可向全部订阅与 webhook 通道一键发测试推送（返回分通道送达计数），不必触发真实审批。
- 跨网段访问**不自建公网穿透**：三套免 VPS 配方（Tailscale funnel / Cloudflare Tunnel / 家宽 IPv6+DDNS）见 [`docs/public-access.md`](docs/public-access.md)，含安全红线与手机蜂窝网络验收清单
- spawn 时自动设置 `CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS=1` 以接收权威 busy/idle 信号
- Windows 请使用 Bun 1.4.0+。Bun 1.3.x 及更早版本存在监听 socket 被子进程继承的问题
  ([oven-sh/bun#36936](https://github.com/oven-sh/bun/issues/36936))；修复已随 1.4.0 发布
  （1.3.15 稳定版从未发布，Bun 由 1.3.14 直接跳到 1.4.0）。
  已经产生的死 PID 监听通常需要重启一次 Windows 才能释放。
- `bun run dev` 使用纯 Bun 启动器并等待 server 完成优雅关闭；不要用任务管理器直接结束 server，
  否则可能绕过 `server.stop(true)` 与 Claude 子进程树清理。

## Claude Code 官方文档（本地镜像）

本地可拉取 [Claude Code Docs](https://code.claude.com/docs/en/overview) 的 Markdown 镜像到 `docs/claude-code/`（已加入 `.gitignore`，不进仓库）：

```bash
bun run docs:claude
```

会写入：

- `docs/claude-code/llms.txt` — 官方文档索引
- `docs/claude-code/llms-full.txt` — 全量合并文本
- `docs/claude-code/en/**/*.md` — 按路径拆分的各页（当前约 185 篇）
- `docs/claude-code/manifest.json` — 拉取元数据（时间、成功/失败计数）

来源为官方 [`llms.txt`](https://code.claude.com/docs/llms.txt) / [`llms-full.txt`](https://code.claude.com/docs/llms-full.txt)；单页亦可直接访问 `https://code.claude.com/docs/en/<page>.md`。

## 域名访问（80/443 网关）

开发态 Vite 仍在 `:5173`、生产态服务端仍在 `:7480`，默认都只绑 `127.0.0.1`。需要用域名从外部访问、且不写端口（或只走 80/443）时，另开网关：

```bash
bun run gateway --insecure   # 仅授信内网；有 authToken 则可去掉 --insecure
```

| 怎么进 | 落到哪 |
|---|---|
| `http://anyplane.example.com/` | 生产 `:7480`（默认，无角标） |
| `http://anyplane.example.com/?mode=dev` | 开发 `:5173`，左下角 **DEV**（点击新开生产标签） |
| `http://anyplane.example.com/?mode=prod` | 显式生产 `:7480` |
| `http://anyplane-dev.example.com/` | 永远开发（需再挂一个域名，并配置 `gateway.devHost` 指向它） |
| `https://…` 同样规则 | 自签证书；若平台在边缘终结 TLS，浏览器 HTTPS 实际打到容器明文 80，也能分流 |

`127.0.0.1:5173` / `127.0.0.1:7480` 不受影响。80 上若收到 SSH 握手，会转到本机 `:36000`。状态页：`/__gateway`。

## 部署到远程容器

在容器内 `bun run build && bun run start`，配置 `authToken` 后把 7480 端口通过你的域名暴露即可（未配置 token 时严禁绑定非回环地址——服务端会拒绝启动）。

## 测试脚本

`server/scripts/` 下有若干端到端脚本（需服务端已启动）：

```bash
bun run server/scripts/smoke.ts          # 直接 spawn CLI 的最小协议验证
bun run server/scripts/e2e-ws.ts         # WS 全链路：attach/resume/set_model/问答
bun run server/scripts/e2e-approval.ts   # 权限审批链路
bun run server/scripts/e2e-slash.ts      # /compact 与 /btw
bun run server/scripts/e2e-rewind.ts     # rewind_files 与对话回滚
```

## 已知限制

- compact 边界之前的消息无法作为 rewind 目标（逻辑上已不存在），UI 会自动过滤
- `rewind_files` 只能回滚到发生过文件变更、存在检查点的消息（spawn 时已设 `CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING=1`）
- `side_question` 与 `/goal` 需要 Claude CLI ≥ 2.1.139；旧版会回 `Unknown skill`
- Codex 无文件检查点（不支持文件回滚）；rollout 不持久化 reasoning（AnyPlane 侧车落盘 `~/.anyplane/reasoning/` 并在读历史时回插）
- effort 的运行时切换依赖 `update_environment_variables`，若所用 CLI 版本不支持则需重开会话（spawn 时 `--effort` 一定有效）
