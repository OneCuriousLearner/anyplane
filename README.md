# cc-remote

Claude Code 远程工作管理工具：在手机（或桌面）浏览器中管理运行在本机/容器上的官方 Claude Code 会话。

## 原理

不修改官方 Claude Code。服务端以子进程方式驱动官方 CLI 的 headless 协议：

```
claude --print --verbose --input-format stream-json --output-format stream-json \
       --include-partial-messages --allow-dangerously-skip-permissions \
       --permission-prompt-tool stdio [--resume <session-id>]
```

stdin/stdout 走双向 NDJSON（user 消息 + control_request/response），与官方 claude.ai/code 网页版桥接本地 CLI 用的是同一套本地协议。

## 功能

- **双后端**：Claude Code（stream-json 子进程）与 **Codex**（`codex app-server` JSON-RPC）统一接入，同一 UI 管理两个 agent 的会话；Codex 事件在服务端翻译为统一消息形状，前端零分叉
- **接力（handoff）**：一键让另一个 agent 接续本目录工作——源会话 fork 自写交接简报（Claude fork-session / Codex ephemeral fork），目标会话带简报进场先确认现场再继续；血缘落盘 `~/.config/cc-remote/lineage.json`
- **项目工作台**：会话按项目目录分组（git 分支 + 各后端计数），Chat 顶栏同目录兄弟会话快捷切换
- **Token 计量**：只计 token 不计费用，分后端分桶（input/output/cache/reasoning），不跨后端合并
- **会话列表**：扫描 `~/.claude/projects/**/*.jsonl` + `thread/list`，展示标题/最近活动/状态徽标（busy/idle/waiting/offline）
- **接续对话**：按目录 + session id 精准 `--resume`；Codex 按 `thread/resume`
- **流式输出**：`--include-partial-messages` 增量渲染，草稿气泡实时过 Markdown；assistant 块快照按 `message.id`+块序号归并定稿，不与增量重复
- **Markdown 渲染**：react-markdown + GFM（表格/任务列表/删除线），代码块等宽底色
- **工具卡片**：tool_use 与 tool_result 按 id 配对成一张卡（名称+摘要一行 trace，展开看参数与结果，失败染红）；思考块默认折叠
- **消息标签**：斜杠命令回显（`<command-name>`）渲染为命令 chip，本地命令输出剥 ANSI 折叠，`<system-reminder>`/isMeta 不进主抄本，子代理 sidechain 消息不入主流
- **状态利用**：`system/init` 提供模型/权限模式徽标；initialize 握手拿 42+ 斜杠命令（含描述）驱动补全；`result` 生成回合摘要；`compact_boundary` 渲染为上下文压缩分隔线
- **运行时切换**：模型（set_model）、权限模式（set_permission_mode，Codex 侧近似映射 approvalPolicy+sandbox）、effort、中断（interrupt）、/compact
- **权限审批**：`can_use_tool` / `requestApproval` 统一推到 UI 审批卡片；Codex 侧强制 `approvalsReviewer: "user"`（覆盖用户配置的 auto_review）；或配置 `permissionPolicy: "bypass"` 全自动
- **会话详情抽屉**：context 分类用量 / MCP 状态 / 设置（只读控制查询）
- **斜杠命令**：`/compact`、`/context` 原生透传；`/rewind`（消息选择器，支持仅回滚文件、仅回滚对话、回滚对话+文件；组合操作先确认文件检查点恢复成功再截断对话）；`/btw <问题>`（fork 侧问，不污染主会话）；其他命令原样发给 CLI 处理
- **后台任务**：task_started → task_notification 活动任务芯片，可 `stop_task` 手动停止
- **会话改名**：Claude 离线会话追加 custom-title（官方 /rename 同形）；Codex `thread/name/set`
- **收件箱 + 通知**：`/ws/inbox` 跨会话审批/完成/错误汇总；桌面通知（页面隐藏时推送）；标题角标；PWA 可添加到手机主屏

## 运行

要求：Bun >= 1.3.13（Windows 请用 1.3.15+ 或 canary，见下方说明），PATH 中有已登录的官方 `claude` CLI；使用 Codex 后端需要 PATH 中有 `codex` CLI（>= 0.147，服务端自动 spawn `codex app-server --stdio` 并按其配置认证）。支持 Windows 与 Linux。

**本项目仅使用 Bun，请勿使用 npm / npx / yarn / pnpm。** 依赖安装、脚本与运行时一律走 `bun`；用 npm 会产生错误的 lockfile、错误的进程树，并在 Windows 上更容易留下僵尸端口。

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

项目根目录 `cc-remote.config.json` 或 `~/.config/cc-remote/config.json`（均可选）。
根目录的配置文件**已被 gitignore**（机器相关路径不应入库），可复制 `cc-remote.config.example.json` 后按需修改：

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
- 环境变量覆盖：`CC_REMOTE_PORT`、`CC_REMOTE_HOST`、`CC_REMOTE_TOKEN`、`CLAUDE_CONFIG_DIR`
- 跨网段访问**不自建公网穿透**：推荐 Tailscale serve/funnel 或自有反代 + TLS，配合 `authToken` 使用
- spawn 时自动设置 `CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS=1` 以接收权威 busy/idle 信号
- Windows 请使用 Bun 1.3.15+。Bun 1.3.14 及更早版本存在监听 socket 被子进程继承的问题
  ([oven-sh/bun#36936](https://github.com/oven-sh/bun/issues/36936))；1.3.15 发布前可用
  `bun upgrade --canary` 获取已合并的修复。已经产生的死 PID 监听通常需要重启一次 Windows 才能释放。
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

启动时若 80/443 已被**上一份** `scripts/gateway.ts` 占用，会 SIGTERM 替换后继续听；nginx/sshd 等其它进程不会动（`--no-replace` 可关闭替换）。

| 怎么进 | 落到哪 |
|---|---|
| `http://cc-remote.devcloud.woa.com/` | 生产 `:7480`（默认，无角标） |
| `http://cc-remote.devcloud.woa.com/?mode=dev` | 开发 `:5173`，左下角 **DEV**（点击新开生产标签） |
| `http://cc-remote.devcloud.woa.com/?mode=prod` | 显式生产 `:7480` |
| `http://cc-remote-dev.devcloud.woa.com/` | 永远开发（需在 DevCloud 再挂一个自定义域名） |
| `https://…` 同样规则 | 自签证书；若平台在边缘终结 TLS，浏览器 HTTPS 实际打到容器明文 80，也能分流 |

`127.0.0.1:5173` / `127.0.0.1:7480` 不受影响。80 上若收到 SSH 握手，会转到本机 `:36000`。状态页：`/__gateway`。

## 部署到远程容器

在容器内 `bun run build && bun run start`，把 7480 端口通过你的域名暴露即可。认证暂未实现（代码中已留好入口，勿直接暴露到不受信网络）。

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

- `/rename` 不支持（headless 无此命令，直接改 jsonl 有并发写风险），标题只读展示
- compact 边界之前的消息无法作为 rewind 目标（逻辑上已不存在），UI 会自动过滤
- `rewind_files` 只能回滚到发生过文件变更、存在检查点的消息
- effort 的运行时切换依赖 `update_environment_variables`，若所用 CLI 版本不支持则需重开会话（spawn 时 `--effort` 一定有效）
