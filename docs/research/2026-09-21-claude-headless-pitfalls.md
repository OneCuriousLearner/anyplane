# Claude headless 实测：上下文占用与 system/init 时序

> 从 AGENTS.md 迁出（2026-09-21）。这里是**读仓库代码读不出的上游行为与踩坑数字**，
> 按写入当时的事实留档；上游会变，以协议正本与最新实测为准。
> 本仓库因此做的设计决策留在 AGENTS.md（口径、双条件标题、列表禁离线水合）。

## 版本

- 窗口启发式翻车：Kimi 网关实测（`k3-256k` / `k3[1M]` + `CLAUDE_CODE_MAX_CONTEXT_TOKENS=256000`），
  探针 `server/scripts/probe-context-usage.ts`。anyplane **v0.1.3** 改用官方
  `get_context_usage` 的 `maxTokens`（`docs/releasing.md`）。
- `system/init` 时序：Claude Code headless stream-json **live 流实测**。官方 SDK 类型把
  `init` 标成 system subtype，未标成 spawn 事件；本仓库按每个 query turn 的首包处理。

## 上下文占用口径

- **不要读 `result.usage` 的 input 侧**。它是本 turn 各 API 调用的累计；多调用 turn
  结束会把环形占用虚增近翻倍。权威口径是最后一条**主线** assistant 的 `message.usage`
  （input + cache，不含 output）。
- 窗口大小以官方 `get_context_usage` 的 `maxTokens` 为权威。模型名启发式只是首见兜底：
  实测 `k3-256k` 无后缀被算成 200k（实为 256k）；`k3[1M]` 有后缀被算成 1M，但 env
  上限压到 256k——两个方向都推不出窗口。
- 权威值按 model 持久化（同模型窗口不变）。transcript 的 `message.model` 缺 `[1m]`
  后缀，离线水合需靠 sessionId→model 反查，不能信抄本上的短名。
- 离线水合若在 `/api/sessions` 列表端点逐行做，是 N 行 × 文件读。单会话 attach
  才允许读 transcript 尾部补占用。

## `system/init` 不是 spawn 事件

`system/init` 是每个 query turn 的首条流消息，不是进程启动时发出。
纯控制查询（`mcp_status` 等）的会话在首个真实 turn 之前没有 init。

后果（决策在 AGENTS.md，这里只记因果）：

- AI 标题必须「首条真实 user 消息 × 首个 init」双条件，只挂一路会漏。
- 前端在权威 idle 且不存在合法草稿时自清陈旧草稿，否则服务端重启/断线后
  「生成中」永挂。
