# AGENTS.md

## 项目定位

cc-remote：在手机/桌面浏览器中管理本机运行的官方 Claude Code 会话。**不修改官方 CLI**——服务端以子进程方式驱动其 headless 协议（`claude --print --input-format stream-json --output-format stream-json --permission-prompt-tool stdio`），stdin/stdout 走双向 NDJSON，与 claude.ai/code 网页版桥接本地 CLI 用的是同一套本地协议。

## 常用命令

**本项目仅使用 Bun（>= 1.3.13；Windows 必须 1.3.15+ 或 canary）。绝不要用 npm / npx / yarn / pnpm。**

```bash
bun install          # 安装依赖（Bun workspaces: server + web）
bun run dev          # 开发模式：并行拉起 server(:7480) + Vite(:5173, 代理 /api 与 /ws)
bun run dev:server   # 仅服务端
bun run dev:web      # 仅 Vite
bun run build        # 构建前端到 web/dist
bun run start        # 生产模式：服务端托管 API + WS + 静态前端
```

端到端验证脚本（需服务端已启动，会真实调用 claude CLI）：

```bash
bun run server/scripts/smoke.ts          # 最小协议验证
bun run server/scripts/e2e-ws.ts         # WS 全链路：attach/resume/set_model/问答
bun run server/scripts/e2e-approval.ts   # 权限审批链路
bun run server/scripts/e2e-slash.ts      # /compact 与 /btw
bun run server/scripts/e2e-rewind.ts     # rewind_files 与对话回滚
```

仓库目前没有单元测试（`bun test` 无测试可跑）；验证改动主要靠上述 e2e 脚本。

## 架构

两个 workspace：`server/`（Bun 服务端，无框架，直接用 `Bun.serve`）和 `web/`（React 19 + Vite + Tailwind 4）。共享根 `tsconfig.json`（strict, bundler resolution）。

### 服务端（server/src）

- **`index.ts`** — 入口，REST + WebSocket 枢纽。核心是 **Hub 模型**：每个会话一个 `Hub`（key → clients/pendingApprovals/spawnOpts/pendingEnv），`hubs: Map<sessionKey, Hub>`。所有 WS 消息在 `handleClientMessage` 中分发。
- **sessionKey 编码**：已存在会话 `s|<slug>|<sessionId>`；新会话 `n|<encodeURIComponent(cwd)>`。`parseKey` 靠 `listSessions()` 反查 cwd——slug 目录被删时 key 无法解析。
- **懒 spawn**：`attach` 只握手不启动 CLI；首条 user 消息 / 无启动参数等价物的控制请求才触发 `ensureSpawned`。未 spawn 时 model/mode/effort 选择缓存在 `hub.spawnOpts`，自定义 env 缓存在 `hub.pendingEnv`（必须排在首条 user 消息之前写入 stdin）。
- **`processManager.ts`** — `ClaudeSession` 封装一个 CLI 子进程：spawn、NDJSON 行泵（pumpStdout）、控制请求、空闲回收。
  - **busy 语义（重要）**：优先信任 `system/session_state_changed`（spawn 时设 `CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS=1`）；未收到该事件时回退到 sendUserText→result 启发式。审批等待（can_use_tool）也算 busy。**running / requires_action 时绝不回收进程。**
  - **回收**：无 WS 客户端、主会话 idle 且无 `task_started` 记录的后台任务后，才按 `detachRecycleMs`（有权威事件，默认 5min）或 `idleTimeoutMs`（回退，默认 30min）回收子进程。
  - **Windows 进程树清理**：`dispose()` 里除 `proc.kill()` 外还 `taskkill /T /F`，防止 claude 子进程残留拖住端口。
- **`discovery.ts`** — 会话发现：扫描 `~/.claude/projects/<slug>/*.jsonl`，合并 `~/.claude/sessions/<pid>.json` 的活跃状态（busy/idle/waiting/offline）。slug = `sanitizePath(cwd)`（非字母数字 → `-`）。
- **`protocol.ts`** — stream-json NDJSON 类型，**宽松解析原则：未知字段/未知 type 一律透传**，保证官方 CLI 升级后不崩。改协议相关代码时遵守这一原则。
- **`config.ts`** — `cc-remote.config.json` 或 `~/.config/cc-remote/config.json`，`CC_REMOTE_PORT` / `CLAUDE_CONFIG_DIR` 环境变量覆盖。

### 前端（web/src）

- `pages/SessionList.tsx`（会话列表）+ `pages/Chat.tsx`（聊天主界面，大部分交互逻辑在这）；`App.tsx` 只是双栏布局。
- `lib/ws.ts` — WS 客户端（按 sessionKey 连接、自动重连），`ServerEvent` 联合类型即服务端广播的全部事件种类。
- `lib/blocks.ts` — 消息块模型：**live 流与历史加载共用同一套块归并逻辑**。增量（stream_event delta）与 assistant 块快照按 `message.id`+块序号归并定稿，不重复渲染。tool_use/tool_result 按 id 配对成一张卡。
- 过滤规则：`<system-reminder>`/isMeta 不进主抄本，sidechain（子代理）消息不入主流；`compact_boundary` 渲染为分隔线。

### /btw 侧问与 rewind 的服务端实现（index.ts）

- **btw**：spawn 一次性 `claude -p <问题> --fork-session --resume <sid> -n "FORK: ..."`，逐行泵 NDJSON 转发为 `btw_delta`/`btw_result`，不经过 ProcessManager。
- **rewind_conversation**：先 `processManager.dispose()` 再带 `--resume-session-at` 重新 spawn（先摘 map 再 kill，避免旧 onExit 污染新会话）。

## Windows 平台注意事项

- **Bun <= 1.3.14 存在监听 socket 被子进程继承的 bug**（oven-sh/bun#36936），服务端和 `scripts/dev.ts` 启动时都会检查版本并拒绝启动（可用 `CC_REMOTE_ALLOW_UNSAFE_BUN=1` 跳过）。已形成的死 PID 监听需重启 Windows 才能释放。
- `scripts/dev.ts` 故意不用 `bun --watch` 和 `bun run --cwd`：Windows watcher 会在异步 SIGINT 清理完成前杀掉 server；多层包装进程会吞 Ctrl+C。**不要用任务管理器强杀 server**，会绕过 `server.stop(true)` 与子进程树清理。
- claude 在 Windows 可能是 `.cmd`/`.bat`（需 `cmd.exe /d /s /c` 包装）或 `.exe`；`resolveClaudeCommand()` 优先选真实存在的 `.exe`。

## 已知限制（改相关功能前先读 README）

- `/rename` 不支持；compact 边界之前的消息不能作为 rewind 目标；`rewind_files` 只能回滚到有检查点的消息（spawn 时设了 `CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING=1`）；effort 运行时切换依赖 `update_environment_variables`，旧版 CLI 可能需重开会话。
- 认证未实现，勿直接暴露到不受信网络。

## 文档

`docs/claude-code/` 是官方 Claude Code 文档的本地 Markdown 镜像（gitignore，不进仓库），**协议/CLI/SDK 相关改动的重要开发参考**。用 `bun run docs:claude` 拉取或更新；入口见 `llms.txt`，全量见 `llms-full.txt`，单页在 `en/**/*.md`。
