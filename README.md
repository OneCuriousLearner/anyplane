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
- **流式输出**：`--include-partial-messages` 增量渲染
- **运行时切换**：模型（set_model）、权限模式（set_permission_mode，等同 shift+tab）、effort（update_environment_variables，部分版本可能需重开会话生效）、中断（interrupt）
- **权限审批**：`can_use_tool` 推到 UI 审批卡片；或配置 `permissionPolicy: "bypass"` 全自动
- **斜杠命令**：`/compact`、`/context` 原生透传；`/rewind`（消息选择器，支持"仅回滚文件"与"回滚对话+文件"）；`/btw <问题>`（fork 侧问，不污染主会话）；其他命令原样发给 CLI 处理

## 运行

要求：Bun >= 1.3.13，PATH 中有已登录的官方 `claude` CLI。支持 Windows 与 Linux。

```bash
bun install
bun run build      # 构建前端到 web/dist
bun run start      # 启动服务端（默认 :7480），托管 API + WebSocket + 前端
```

开发模式（前端热更新）：

```bash
bun run dev:server   # 服务端 :7480
bun run dev:web      # vite dev :5173，代理 /api 与 /ws 到 7480
```

## 配置

项目根目录 `cc-remote.config.json` 或 `~/.config/cc-remote/config.json`（均可选）：

```json
{
  "port": 7480,
  "permissionPolicy": "ask",
  "claudePath": "/usr/local/bin/claude",
  "idleTimeoutMs": 1800000,
  "claudeConfigDir": "~/.claude"
}
```

- `permissionPolicy`: `"ask"`（默认，转发 UI 审批）| `"bypass"`（spawn 即 bypassPermissions）
- `CC_REMOTE_PORT` 环境变量可覆盖端口

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
