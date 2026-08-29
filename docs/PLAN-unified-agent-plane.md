# AnyPlane 统一 Agent 控制面实施计划

> 日期：2026-08-17。前置实验（双向接力验证）已通过，结论与数据见文末附录。

## 背景与目标

AnyPlane 目前只支持 Claude Code（stream-json NDJSON 驱动 `claude -p`）。本计划把它升级为**双后端本地 Agent 控制面**：

- 接入 Codex（`codex app-server`，JSON-RPC over stdio，官方协议、有 `generate-ts` 类型生成）
- 以 **cwd（项目目录）为轴**组织 UI，同一目录下 Claude 会话与 Codex 线程并排
- 实现**接力（handoff）**：一个 agent 自写交接简报，另一个 agent 带简报进场继续工作（实验已验证双向可行）
- 计量**只算 token 不算钱**：不使用任何回传费用字段或本地估价；分后端分桶展示，不跨后端合并总数（tokenizer 不同，token 不可通约）

明确不做：自建公网 relay/NAT 穿透（交给 Tailscale 等）；OpenAI/Anthropic API 适配层（CLIProxyAPI 已覆盖）；transcript 跨后端字节级互转；修改官方 CLI。

## 阶段 0：认证与暴露面（1-2 天，先行）

- `config.ts` 增加 `authToken`（`ANYPLANE_TOKEN` 环境变量覆盖）。
- 未配置 token：只绑 `127.0.0.1`，启动打印警告；配置后允许 `--host`/config 绑定局域网地址。
- WS upgrade（`/ws/sessions/:key`）与全部 `/api/*` 统一校验（`Authorization: Bearer` 或 `?token=`）。
- 启动时打印带 token 的完整 URL + QR（依赖 `qrcode`），手机扫码直达。
- README 补 Tailscale serve/funnel 与反代 TLS 两套配方。
- 验收：无 token 时 curl/WS 一律 401；带 token 正常；`bun run server/scripts/e2e-ws.ts` 适配后通过。

## 阶段 1：后端抽象层重构（Claude 行为零变化）

目标：把"Claude 专有"从 Hub/WS 层剥离，定义后端无关接口。**这是最大风险点，靠现有 5 个 e2e 脚本回归兜底。**

- 新目录 `server/src/backends/claude/`：迁入 `processManager.ts`、`discovery.ts`、`tailer.ts`。
- 新接口 `server/src/backends/types.ts`：

```ts
interface AgentBackend {
  name: 'claude' | 'codex'
  listSessions(): Promise<SessionSummary[]>        // cwd、标题、更新时间、状态
  readHistory(key): Promise<HistoryMessage[]>      // 统一历史块
  attach(hub, opts): AgentSession                  // 懒启动/订阅
}
interface AgentSession {
  sendUserText(text, mode?: 'steer' | 'queue')     // steer=busy 时插队；queue=排队
  interrupt(): void
  respondApproval(requestId, decision: UnifiedDecision)
  setModel(model): void; setPermissionMode(mode): void; setEffort?(e): void
  rewind?(target): Promise<void>                   // claude: conversation/both;codex: 仅 conversation
  sideQuestion(question): AsyncIterable<delta>     // /btw;codex 用 ephemeral fork
  dispose(): void
}
type UnifiedDecision = 'allow' | 'allow_session' | 'deny' | 'cancel'
```

- sessionKey 方案：Claude 保持 `s|slug|sid` / `n|cwd` 不变（兼容）；Codex 新增 `x|<threadId>` / `xn|<encodeURIComponent(cwd)>`（threadId 全局唯一，`thread/read` 可直接反查 cwd，不受 slug 删除影响）。
- 审批决策映射：claude `allow/deny` ↔ 统一 `allow/deny`；codex `accept/acceptForSession/decline/cancel` ↔ 四选一。Claude 侧 `allow_session` 映射为 `allow` + `updatedPermissions`（destination: session）。
- 验收：现有 e2e 脚本（smoke/e2e-ws/e2e-approval/e2e-slash/e2e-rewind）全部通过；前端无感。

## 阶段 2:Codex 后端（核心，1.5-2 周）

传输：**stdio NDJSON**（ws 是 experimental，不用；unix socket 留作以后）。一个 app-server 进程托管全部 Codex 线程，服务端单例 `CodexRuntime` 按 `threadId` 解复用。

- 探针先行：`server/scripts/e2e-codex.ts`——spawn `codex app-server`，initialize（`capabilities.experimentalApi: true`）→ `thread/start` → `turn/start` → 收事件 → `turn/interrupt` → `thread/resume`。本机 codex 0.147.0。
- 用 `codex app-server generate-ts --experimental` 生成 TS schema 存 `server/src/backends/codex/schema/`（gitignore，构建时生成；锁定 codex 版本要求）。
- JSON-RPC 客户端：id 池、pending map、`-32001` 过载指数退避重试、initialize 握手（`clientInfo.name = "AnyPlane"`）。
- 概念映射（已核实）：
  - 会话发现 `thread/list`（cwd/archived/searchTerm 过滤、分页）替代 slug 扫描
  - 历史 `thread/resume`（`excludeTurns` + `thread/turns/list` 分页）替代 readHistory+tailer
  - 发消息 `turn/start`；流式 `item/agentMessage/delta`、`item/reasoning/*`、`item/commandExecution/outputDelta`
  - 工具卡：`commandExecution`/`fileChange`/`mcpToolCall` 的 `item/started→item/completed`
  - 审批：`item/commandExecution/requestApproval`、`item/fileChange/requestApproval`、`item/permissions/requestApproval` → 统一四决策
  - busy 权威信号 `thread/status/changed`（idle/active/systemError）
  - 中断 `turn/interrupt`;compact `thread/compact/start`；改名 `thread/name/set`
  - 模型目录 `model/list`（含 `supportedReasoningEfforts`，消灭 `/api/config` 硬编码）
  - `/btw` = `thread/fork` + `ephemeral: true` + `turn/start`（不落盘）
  - rewind 仅 `thread/revert`（实验性，只截对话不回文件；UI 隐藏 rewind_both）
  - busy 时发消息：`turn/steer`（插队）或 `thread/queue/add`（排队）——与 Claude 的 `priority` 字段统一为 `sendMode`
- 回收语义：无订阅者的 thread 由 app-server 30 分钟自动卸载（与现有 idleTimeout 语义对齐），AnyPlane 只负责断开订阅，**不 kill 进程**。
- 已核实的坑：
  - **workspace-write 沙箱下 `.git` 只读**（实验实测 commit 报 128)——默认 spawn 配置需放开 .git 或用 `dangerFullAccess`/自定义 permission profile;UI 要暴露这个选择。
  - paginated thread 单进程写锁：用户在 TUI/VSCode 开着同一 thread 时 `thread/resume` 报 `-32600`,UI 显示"被占用"。
  - 登录态：`account/read` 检查；未登录时 UI 引导 `account/login/start`（支持 apiKey)。
- 验收：`e2e-codex.ts` 全链路（列表/历史/问答/审批/中断/改名/compact/ephemeral fork)。

## 阶段 3:项目工作台 UI(0.5-1 周）

- `SessionList.tsx` 从扁平列表改为两级：项目（cwd) → 会话。REST 聚合层把 Claude `listSessions()` 与 Codex `thread/list` 按 cwd 归并。
- 项目行显示 git 分支 + 各后端会话数 + token 用量汇总（分桶）。
- 会话行加后端徽标（🟠/🔵);Chat 页顶部在同目录存在另一后端会话时显示快捷切换条。
- `blocks.ts` 抽象为后端无关块模型（text/thinking/tool/plan/compact-boundary/approval),Claude 路径渲染不变。

## 阶段 4：接力（handoff)(1 周，差异化核心）

实验已验证的机制落地为产品功能：

- `POST /api/handoff { fromKey, toBackend, detail: 'brief'|'standard'|'detailed' }`:
  1. 源后端 fork 摘要：Claude 用现有 `/btw` 机制（`--fork-session --resume` 一次性问答）;Codex 用 `thread/fork ephemeral:true` + `turn/start`。提示词要求输出：项目目标/进度/对话内决策/文件清单/下一步。
  2. 创建目标会话：首条 user 消息 = 简报 + "你在 \<cwd\> 接替另一个 agent，先用 git status/diff 和关键文件确认现场再动手"。(Claude 也可叠加 `--append-system-prompt-file`;Codex 可叠加 `developer_instructions`，首消息方案为最通用实现。)
  3. 血缘写 `~/.anyplane/lineage.json`（源 key→目标 key、时间、简报、源 token 统计）。
- UI：会话页"接力"按钮（可选简报详细度）；接力链渲染为虚拟时间线，段间用 compact_boundary 同款分隔线（"⚡ 接力 Claude→Codex · 简报 N tokens")；双向互链。
- 提示文案诚实标注：目标 agent 首轮需重建上下文（读现场），给出源会话 token 统计供参考。
- 验收：`server/scripts/e2e-handoff.ts` 双向各一次，断言目标会话产出了与"对话内隐藏设计"一致的行为（复刻本次实验）。

## 阶段 5:Token 计量（无费用）（2-3 天，可提前穿插）

- 统一 `SessionUsage`:`{ backend, inputTokens, outputTokens, cacheReadTokens?, cacheWriteTokens?, reasoningTokens? }`。
  - Claude: `result.usage`（input/output/cache_read/cache_creation);**`total_cost_usd`、`modelUsage[].costUSD` 在聚合层丢弃，不进 UI**。
  - Codex: `thread/tokenUsage/updated` + `turn/completed` usage;`account/rateLimits` 只用 `usedPercent`（配额百分比）。
- 展示：会话头部/列表行分后端分桶（`🟠 12.3k in / 4.1k out / 98k cache`;`🔵 8.2k in / 2.0k out / 5.0k reasoning`)。不做跨后端合计。
- 接力简报消耗也记账并入 lineage。

## 阶段 6:Claude 协议深挖 quick wins（穿插，每个 0.5-2 天）

1. `prompt_suggestion`(initialize 传 `promptSuggestions: true`)——移动端下一步建议
2. slash command 补全（`system/init` 的 `slash_commands`;`reload_plugins` 刷新）
3. 会话详情抽屉（`mcp_status` / `get_settings` / `get_context_usage`)
4. `--replay-user-messages`（多浏览器端同步自己发的消息）
5. 后台任务管理（`stop_task` / `cancel_async_message`)
6. 会话改名：离线会话向 jsonl 追加 `custom-title` 行（在线会话不碰；Codex 用 `thread/name/set`)

## 阶段 7（后置）：跨会话收件箱 + 通知

全局 WS 频道 `/ws/inbox` 汇总各 Hub 的 approval_request/waiting/完成/错误；PWA + Notification API（tab 隐藏时）;Web Push(VAPID，需 HTTPS，与阶段 0 联动）。等统一后端稳定后一次做对。

## 风险与防护

- **CLI 协议漂移**：本机 claude 2.1.220 vs 快照 2.1.88。写脚本对照 `claude-code/src/entrypoints/sdk/controlSchemas.ts`/`coreSchemas.ts` 提取 subtype 清单与 `protocol.ts` diff;NDJSON fixture 回放 harness 把回归测试与真 CLI 解耦。
- **Codex 版本绑定**:app-server schema 随版本生成，启动时校验 codex 版本并警告。
- **并行双开同目录写冲突**:UI 默认串行（接力），并行场景引导 git worktree(Claude `--worktree`,Codex `writableRoots` 指向 worktree)。
- **认证未落地前不暴露局域网**（阶段 0 是硬门槛）。

---

## 附录：接力可行性实验记录（2026-08-17,/data/workspace/handoff-lab)

**流程**:Claude 建项目（add/list + 口头设计 search 语法）→ fork 自写简报 → Codex(deepseek-v4-flash）进场实现 search → Codex 继续（list --tag + 口头设计 export 格式）→ Codex 写简报 → Claude 进场实现 export → 独立验证。

**结果**:

| 检验点 | 结果 |
|---|---|
| 两个方向的目标 agent 均先确认现场（git log/读源码）再动手 | ✅ |
| 对话内隐藏设计(search `tag:` 语法；export frontmatter/排版/文件名规则）跨后端无损传递 | ✅ 逐字相符 |
| 测试：9 → 15 → 18 → 25 passed;4 个 commit 链完整 | ✅ |
| 简报自带环境坑提醒（无 pip 用 ensurepip、勿动交接文件）并被遵守 | ✅ |
| 发现的坑：codex `workspace-write` 沙箱 `.git` 只读（commit 128);`codex exec` 的 `--sandbox` 必须放在 `resume` 子命令前 | 已记录 |

**Token 用量**（只计 token):

| 环节 | input | cache_read | output | reasoning |
|---|---|---|---|---|
| Claude 建项目 | 38,335 | 182,272 | 6,724 | — |
| Claude 写简报 | 13,072 | 21,760 | 626 | — |
| Codex 实现 search | 168,137 | (cached 162,432) | 8,112 | 4,991 |
| Codex list --tag + 设计 | 161,210 | （增量） | 12,502 | 7,544 |
| Codex 写简报 | 30,521 | （增量） | 1,924 | 1,213 |
| Claude 实现 export | 17,016 | 297,984 | 5,821 | — |

（Codex 侧 turn.completed 的 usage 为线程累计值，表中第 4、5 行为差分。)
