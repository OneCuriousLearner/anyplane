# 协议漂移代办（长期维护）

CI 周报（`.github/workflows/protocol-drift.yml`，每周一）发现漂移会开 `protocol-drift` issue。
本文档归档每次漂移的**评估结论与后续代办**——issue 关掉之后，代办与决策依据以本文为准。

## 处理流程

1. 按 issue 指引本地跑 `check-claude-protocol.ts` / `check-codex-schema.ts` 看明细。
   注意 CI 总是用**最新发布版**跑（codex 走 `@openai/codex` npm 包、claude 走
   `@anthropic-ai/claude-agent-sdk` 的 `sdk.d.ts`），本地 CLI 版本落后时本地会显示
   "无漂移"——以 CI 报告的上游版本为准，先升级本地 CLI 再刷基线。
2. 逐项评估：是否影响现有链路（删改字段 = 破坏性，必须改代码；纯新增 = additive，
   通常只需刷基线）。codex 侧拿不准时查 codex-rs 源码确认实况，不凭猜。
3. `--update` 刷基线，**复跑一次确认零漂移**，提交。
4. 本文新增一节（倒序，最新在上）：漂移内容、评估结论、代办（含「不做的决策」——
   防止将来重新论证）。
5. 关闭 issue。

## 2026-09-19

### codex 0.154.0 → 0.155.1：19 处真实 schema 变更，全部 additive；另有 3 条运行时行为漂移

本地 codex 升到 0.155.1 后 v0.2.0 发版前 e2e 暴露三个异常，顺藤摸瓜完成本次漂移评估。
基线刷新到 861 个类型文件。

**行尾误报修复（工具链）**：`check-codex-schema.ts` 此前对全量文件逐字节比较——Windows 上
`core.autocrlf=true` 把基线签出为 CRLF，而 `generate-ts` 输出恒为 LF，导致**无漂移时也
误报 122 处假变更**（本次 127 处里仅 19 处为真）。已改为比较前归一 `\r\n`→`\n`。

| 变更 | 评估 | 代办 |
|---|---|---|
| `ClientRequest` +4 RPC（`memory/status`、`thread/attachment/add|list|remove`、`userVerification/cancel`） | 记忆状态查询、线程附件管理、身份验证取消——与 AnyPlane 控制面无关 | 不接入 |
| `ServerNotification` +`thread/attachment/updated` | 附件变更通知，我们不消费附件 | 不接入（宽松解析透传） |
| `FeedbackUploadResponse` +6 字段 | 反馈上传应答，不使用的端点 | 无 |
| `v2/index.ts` +14 导出 | 新类型 re-export | 无 |

**运行时行为漂移（schema 看不出的三条，裸 app-server 探针复现，与 AnyPlane 代码无关）**：

1. **`ephemeral paginated thread/fork` 强制 `excludeTurns: true`**（0.155.1 新增校验，缺省报
   -32600）——`handoff.ts` 的 codex→claude 接力因此断裂。已修：`runtime.ts` 的
   `runEphemeralQuestion` 恒传 `excludeTurns: true`（字段在 0.154.0 schema 已存在且可选，
   一次性问答不读 fork 的 turns，双版本兼容）。
2. ~~spawn_agent 子代理 turn 挂起~~——**复评后非 0.155.1 回归**：与
   `docs/research/2026-09-11-codex-upstream-behavior-notes.md`「模型侧 flake」节已记载的
   spawn→wait 死循环同族（0.148.0/0.153.4 同现），本次只是换了模型复现，按既有结论处理。
3. **服务端 spawn 的 app-server 里 shell for-loop 一律 cygwin fork 崩溃**
   （`fatal error - CreateFileMapping … Win32 error 5`）——裸 app-server 两种 spawn 方式均复现、
   直跑 Git Bash 正常，根因为 e2e 硬杀进程泄漏的 msys 共享内存 section 被长命父进程持有
   （Bun Windows 句柄继承问题家族），重启 Windows 自愈；非协议问题，详见
   `docs/research/2026-09-11-codex-upstream-behavior-notes.md`「模型侧 flake」节。

## 2026-09-17（issue #31 / #32）

### claude SDK 0.3.274：controlSubtypes +2（#31）

新增 `get_hooks_listing`、`list_permission_rules`；stdoutTypes / systemSubtypes 无漂移。

- **评估**：均为**客户端 → CLI** 的控制请求 subtype，是上游开放给客户端的新查询能力；
  CLI 不会反向要求 AnyPlane 响应它们。AnyPlane 不发这两个请求，现有链路零影响，直接刷基线。
- **代办（可选 feature，未排期）**：UI 展示会话 hooks 列表 / 权限规则列表，
  走与 mcp_status 相同的控制通道。价值低，等有用户诉求再做。

### codex 0.153.4 → 0.154.0：36 处 schema 变更，全部 additive（#32）

本次同步把本地 codex CLI 升级到 0.154.0 并刷新基线（847 个类型文件）。逐项评估：

| 变更 | 评估 | 代办 |
|---|---|---|
| `ClientRequest` +4 RPC（`userVerification/delete`/`enroll`/`status`/`verify`） | 用户身份验证流程，与 AnyPlane 控制面无关 | 不接入 |
| `v2/Thread` +`environments`/`originator`/`daybreakEnabled`（均可空） | 宽松解析直接透传 | 无 |
| `ThreadListParams` +`originators` 过滤 | 官方注明仅 hosted 后端支持，local app-server 拒绝非空值 | 不用 |
| `ThreadMetadataUpdateParams` +`daybreakEnabled` | 保存客户端 Daybreak 选择 | 不用 |
| `McpServerStatus` +`toolsError` | 工具发现失败原因字段 | 可选：MCP 面板展示（未排期） |
| `ResponseItem` +`configuration_update` | **已查证，不可达 AnyPlane**，见下 | 无 |

**`configuration_update` 实况查证**（codex-rs 源码，0.154.0）：

- 它是 codex core **harness 自产的历史项**（`session/reasoning_effort.rs` 经
  `record_annotated_conversation_items` 写入历史），用途是跨 resume/compact 钉住
  per-model reasoning effort；门控在 `Feature::ReasoningEffortOverride` +
  `use_responses_lite` + OpenAI provider 之下。
- **不会转成 ThreadItem**：app-server 的 `thread_processor.rs` / `bespoke_event_handling.rs` /
  `thread_state.rs` 对它零引用——既不进 `itemStarted`/`itemCompleted` 实时事件，
  也不进 `turns/list` 历史。app-server 另有测试明确拒绝客户端伪造注入。
- AnyPlane 的 codex 历史走 RPC ThreadItem、live 走 item 通知、rollout 只读文件头
  （session_meta + 首条用户消息）——三条路径都碰不到它。**无需透传处理，无代办**。
