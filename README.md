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

- **会话列表**：扫描 `~/.claude/projects/**/*.jsonl`，按项目分组，展示标题/最近活动/状态徽标（busy/idle/waiting/offline，活跃状态来自 `~/.claude/sessions/*.json` PID 文件）
- **接续对话**：按目录 + session id 精准 `--resume`
- **流式输出**：`--include-partial-messages` 增量渲染，草稿气泡实时过 Markdown；assistant 块快照按 `message.id`+块序号归并定稿，不与增量重复
- **Markdown 渲染**：react-markdown + GFM（表格/任务列表/删除线），代码块等宽底色
- **工具卡片**：tool_use 与 tool_result 按 id 配对成一张卡（名称+摘要一行 trace，展开看参数与结果，失败染红）；思考块默认折叠
- **消息标签**：斜杠命令回显（`<command-name>`）渲染为命令 chip，本地命令输出剥 ANSI 折叠，`<system-reminder>`/isMeta 不进主抄本，子代理 sidechain 消息不入主流
- **状态利用**：`system/init` 提供模型/权限模式徽标与斜杠命令补全；`system/status` 驱动"请求中/压缩中"相位指示；`result` 生成"本轮 25s · 830 tok"回合摘要；`compact_boundary` 渲染为上下文压缩分隔线
- **运行时切换**：模型（set_model）、权限模式（set_permission_mode，等同 shift+tab）、effort（update_environment_variables，部分版本可能需重开会话生效）、中断（interrupt）
- **权限审批**：`can_use_tool` 推到 UI 审批卡片；或配置 `permissionPolicy: "bypass"` 全自动
- **斜杠命令**：`/compact`、`/context` 原生透传；`/rewind`（消息选择器，支持"仅回滚文件"与"回滚对话+文件"）；`/btw <问题>`（fork 侧问，不污染主会话）；其他命令原样发给 CLI 处理

## 运行

要求：Bun >= 1.3.13（Windows 请用 1.3.15+ 或 canary，见下方说明），PATH 中有已登录的官方 `claude` CLI。支持 Windows 与 Linux。

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
```

## 配置

项目根目录 `cc-remote.config.json` 或 `~/.config/cc-remote/config.json`（均可选）：

```json
{
  "port": 7480,
  "permissionPolicy": "ask",
  "claudePath": "/usr/local/bin/claude",
  "detachRecycleMs": 300000,
  "idleTimeoutMs": 1800000,
  "claudeConfigDir": "~/.claude"
}
```

- `permissionPolicy`: `"ask"`（默认，转发 UI 审批）| `"bypass"`（spawn 即 bypassPermissions）
- `detachRecycleMs`: 已收到 Claude `session_state_changed` 时，客户端全断、主会话 `idle` 且无 Claude 后台任务后多久回收子进程（默认 5 分钟）；`running` / `requires_action` / 后台 Agent、workflow、shell 任务期间绝不回收
- `idleTimeoutMs`: 无权威状态事件时的回退回收延迟（默认 30 分钟）
- `CC_REMOTE_PORT` 环境变量可覆盖端口（默认固定 7480）
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
