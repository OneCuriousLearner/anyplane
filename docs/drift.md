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
