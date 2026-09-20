<p align="center">
  <img src="docs/media/AnyPlane-icon.png" width="64" height="64" alt="AnyPlane" />
</p>

# AnyPlane

> Run your agents, on any plane.

**让 agent 跑着任务，你去生活。它有事叫你，锁屏上就能放行。**

**官网 [anyplane.run](https://anyplane.run)**（国内访问可试 [anyplane.cn](https://anyplane.cn)） · npm 包 [`anyplane`](https://www.npmjs.com/package/anyplane) · [English](README.md)

<p align="center">
  <img src="docs/media/Greeting.png" alt="AnyPlane 会话界面：一次真实对话里向 README 读者打招呼" />
</p>

## 它能帮你做什么

- **离开电脑也能盯着 agent**：手机上查看流式输出、审批文件写入和命令执行，锁屏后推送照样到。
- **一个界面管两家 agent**：Claude Code 和 Codex 的会话按项目目录分组，随时接续历史对话。
- **长跑任务交给 agent 自己盯**：设定目标让它干到达成为止，完成、出错、等你审批都会通知你。
- **会活也能玩出花**：一键分叉当前会话、让一个 agent 接力另一个的工作、回滚对话或文件改动。

## 原理

AnyPlane 不修改官方 CLI。服务端以子进程方式驱动两家 CLI 的 headless 协议——与 claude.ai/code 网页版桥接本地 CLI 用的是同一套本地协议；Codex 的事件在服务端翻译成与 Claude 相同的消息形状，前端因此一套界面通吃。

## 快速开始

需要：Bun ≥ 1.4.0，PATH 中有已登录的官方 `claude` CLI；使用 Codex 后端则另需 `codex` CLI（≥ 0.147）。

```bash
bunx anyplane
```

服务起来后会打开默认浏览器访问 <http://localhost:7480>。不想自动打开就加 `--no-open`（或 `ANYPLANE_NO_OPEN=1`）。前端已随 npm 包预构建，无需 clone 仓库；配置文件和运行数据默认放在 `~/.anyplane/`。

没装 Bun 也可以从 npm 装（`npm i -g anyplane` / `npx anyplane`）——启动时会告诉你怎么补上 Bun。

从源码运行（开发用，本项目仅使用 Bun，请勿用 npm / yarn / pnpm）：

```bash
bun install
bun run build && bun run start   # 生产模式
bun run dev                      # 开发模式：服务端 + Vite 热更新
```

### Docker

单阶段镜像，内置 Bun 与双 CLI——本机不需要装 Bun/Node：

```bash
docker build -t anyplane .
docker run -d --name anyplane -p 7480:7480 \
  -e ANYPLANE_TOKEN=<至少32位随机串> \
  -v anyplane-data:/root/.anyplane \
  -v anyplane-claude:/root/.claude \
  -v anyplane-codex:/root/.codex \
  -v "$HOME/projects:/root/projects" \
  anyplane
```

镜像默认绑 `0.0.0.0`，因此 `ANYPLANE_TOKEN` 必填（不配则服务端拒绝启动——刻意的 fail-closed）。想起会话的项目目录必须挂进容器（示例为 `/root/projects`），新会话目录选择器里看到的是容器内路径。内置 CLI 版本默认钉在本仓库验证过的版本上（protocol-drift CI 负责前移），需要别的版本时用 `--build-arg CLAUDE_CODE_VERSION=latest` 等覆盖。

凭证目录两种挂法（择一）：

- **命名卷（推荐，隔离）**，如上例。首次启动后在容器内登录一次：`docker exec -it anyplane claude auth login` / `codex login`。claude 走 API key 时更省事：`-e ANTHROPIC_API_KEY=...`，无需挂卷。
- **直挂宿主目录**（`-v "$HOME/.claude:/root/.claude"` 等）共享宿主登录态，但容器 CLI 对这些目录**可写**：容器 CLI 比宿主机新时可能把宿主配置/状态文件向前迁移（codex 的带版本 sqlite 状态尤其敏感），反过来弄坏宿主机上较旧的 CLI。走这条建议 `--build-arg` 把容器 CLI 钉到与宿主一致的版本。

Windows（Docker Desktop）跑这个 Linux 镜像即可，无需 Windows 原生镜像；PowerShell 挂卷语法：`-v "$env:USERPROFILE\.claude:/root/.claude"`。

## 功能一览

**会话管理**
- 会话按项目目录分组，显示 git 分支与状态徽标；新会话自动生成 AI 标题，支持改名、归档（回收站可恢复）。
- 接续对话：精准恢复 Claude / Codex 的历史会话，上下文原样带回。

**交互与审批**
- 流式输出实时渲染 Markdown；工具调用与结果配对成卡片，子代理等后台任务收进右侧栏，可随时停止。
- agent 请求权限时推到浏览器里裁决，允许/拒绝一键完成；也可以配置全自动模式或审批规则。
- 模型、权限模式、effort 运行中随时切换；斜杠命令面板两家后端通吃。
- 图片可直接粘贴发送；会话详情抽屉里有上下文用量、MCP 管理与 token 计量。

**通知**
- Web Push：页面关了也能收到审批/完成/错误通知。审批通知在 Android 与桌面 Chrome 上自带允许/拒绝按钮，不打开页面直接裁决；iOS 不支持通知按钮，点击会落到一个两按钮确认页（同样不加载完整应用）。
- webhook 通道（ntfy / Bark / Server酱）：国内无 FCM 环境的出路，Server酱可直达微信。

**高级玩法**
- 接力：一键让另一个 agent 接续本目录工作，自带交接简报。
- 分叉：当前会话开出分支，携带全部历史，原会话不动。
- 目标：设定完成条件，agent 持续工作直到达成。
- 回滚：回滚对话或文件改动；Codex 侧可「从此处分叉」。
- 收件箱汇总所有会话的待办；PWA 可添加到手机主屏。

## 安全

AnyPlane 的本质是把「在本机起会话」开放给能访问该端口的人，而起会话等价于任意命令执行——请认真对待监听地址。

- 默认只监听 `127.0.0.1`（仅本机），这是安全默认值。
- **绑定非回环地址（如 `0.0.0.0`）必须同时配置 `authToken`**，否则服务端拒绝启动。
- 配置 token 后，启动时终端会打印带 token 的扫码 URL 二维码，手机扫码即入。
- 跨网段访问不建议自建公网穿透；Tailscale funnel / Cloudflare Tunnel / IPv6+DDNS 三套免 VPS 配方见 [docs/public-access.md](docs/public-access.md)，或用一键封装 `bun run public-access funnel | cf-quick | caddy <域名>`（未配 authToken 会拒绝执行）。

## 配置

配置文件 `anyplane.config.json`（项目根目录）或 `~/.anyplane/config.json`，均可选。最常用的几项：

```json
{
  "port": 7480,
  "host": "127.0.0.1",
  "authToken": "change-me",
  "permissionPolicy": "ask"
}
```

- `permissionPolicy`：`"ask"`（默认，转发 UI 审批）| `"bypass"`（全自动，慎用）。
- 推送通知需要 HTTPS 或 localhost；iOS 需先把站点添加到主屏幕再订阅。
- 完整配置项、推送 webhook 通道、环境变量见 [docs/configuration.md](docs/configuration.md)；域名访问（80/443 网关）见 [docs/gateway.md](docs/gateway.md)。

## 已知限制

- 部分功能（如 /btw、目标）需要 Claude CLI ≥ 2.1.139。
- **iOS 尚未真机实测过**：Web Push 代码路径按 Safari 的能力做了降级（通知按钮不可用时落确认页），但作者手上没有 iPhone。如果你试了——无论成不成——欢迎开 issue 告诉我们。
- 回滚依赖文件检查点：compact 边界之前的消息不可回滚；Codex 无文件检查点，只能回滚对话或分叉。
- Codex 不持久化推理过程，AnyPlane 以侧车文件补记（`~/.anyplane/reasoning/`）。
- 运行数据目录 `~/.anyplane/` 不自动清理，由用户自行管理。
- 界面文案目前只有简体中文，i18n 尚未落地。

## 开发与贡献

- 架构决策与开发约定见 [AGENTS.md](AGENTS.md)；发版流程见 [docs/releasing.md](docs/releasing.md)。
- 长文本文档（调研/规划/审计）放 `docs/`，各子目录角色见 [docs/README.md](docs/README.md)；**入库文档不要描述本地仓库路径、密钥位置等机器相关信息**，确有需要写 `*.local.md`（不进 git）。
- 端到端验证脚本在 `server/scripts/`（需服务端已启动，会真实调用 claude/codex CLI）。
- 官方文档本地镜像：`bun run docs:claude` / `bun run docs:codex`，写入 gitignore 的 `docs/claude-code/` 与 `docs/codex/`。
