# 13.5 中立领域事件模型（AgentEvent）——规划文档

> 2026-09-19 立。**本文档是规划，不是动工**——13.5 的时机红线原文：
> 「在确定要接第三家之前不要动；但必须在接之前动完，不能等接的时候临时改」。
> 「动」指改生产代码路径；现在做规划的理由：13.3（capabilities/注册表）与 13.4（store/双写）
> 刚交付，设计上下文最新鲜，且 ROADMAP 无其他阻塞事项。本文档沉淀设计，触发条件到来时按稿施工。

## 一、现状精确盘点（13.1/13.3 之后，比评审时好了一截）

审计发现一（2026-09-17）的定性是「Claude 协议被当成中立契约」。13.1/13.3 落地后现状分化——
**形状已中立，词汇表仍 vendor-anchored**：

已中立（无需再动）：

| 面 | 现状 |
|---|---|
| WS 边界类型 | `CliMsg` 是 protocol 包的宽松 wire 形状（`type: string` + 索引签名透传，`protocol/src/events.ts:13`），vendor 丰富解析留在各后端内部 |
| 能力差异 | `capabilities` 声明是唯一权威（13.3），前端按能力渲染 |
| 审批 / btw / handoff / moved / replay 等旁路事件 | `ServerEvent` 判别联合本就是中立词汇（`kind:` 判别符），不涉 stream-json |
| 历史面 | `HistoryMessage`/`HistoryBlock` 在 protocol 包，已中立 |
| REST 面 | 注册表分发（13.3），无 vendor 分支 |

仍 vendor-anchored（13.5 的真正对象）：

| 位置 | 耦合内容 |
|---|---|
| `server/src/backends/types.ts:4-9` | 「统一边界 = Claude stream-json 形状」的决策原文；`CliMessage` 正本在 `claude/protocol.ts` |
| `codex/translate.ts` | **58 处** stream-json 词汇构造点（`type: 'assistant'/'stream_event'/'user'/...` 分布实测）——翻译器输出目标是 claude 词汇表 |
| `web/src/hooks/useTranscriptIngest.ts` `handleCli` | 前端按 stream-json 的 `type`/`subtype` 枚举分发：`stream_event`（SSE 块增量）/ `assistant` / `user` / `system`（init/status/task_*/compact_boundary）/ `result` / `control_response` |
| `SessionState` 语义口径 | busy/usage/context 的字段语义对齐各家官方 statusline（13.1 已注释口径差异），属「语义近似映射」而非词汇问题 |
| 40 处「实测/逆向/私有」标注 | claude 私有 subtype（`side_question`/`generate_session_title`）走旁路控制通道，不进事件主流，中立化不覆盖它们 |

**结论**：13.5 是**词汇表中立体**，不是类型形状中立化。Claude stream-json 从「全系统通用货币」
降级为「claude adapter 的 wire format + 翻译源」。

## 二、AgentEvent 设计草案

判别联合，`kind` 判别符与既有 `ServerEvent` 同风格。词汇表以**两后端现有消费的并集**为准
（不是凭空设计——从 handleCli 的分支与 translate.ts 的构造点反推）：

```ts
export type AgentEvent =
  // ---- turn 生命周期 ----
  | { kind: 'turn_started'; sessionId: string; model?: string }        // ← system/init
  | { kind: 'turn_completed'; ok: boolean; durationMs?: number; usage?: TokenUsage; errorText?: string } // ← result
  | { kind: 'run_state'; state: 'idle' | 'running' | 'requires_action' } // ← session_state_changed / thread status
  | { kind: 'phase'; label?: string }                                  // ← system/status（compacting 等）
  // ---- 消息与流式增量 ----
  | { kind: 'message'; role: 'assistant' | 'user'; blocks: EventBlock[]; uuid?: string; msgId?: string }
  | { kind: 'block_start'; msgId?: string; index: number; block: EventBlockKind } // ← content_block_start
  | { kind: 'block_delta'; index: number; text?: string; thinking?: string; json?: string } // ← content_block_delta
  | { kind: 'blocks_commit' }                                            // ← message_stop（草稿固化信号）
  // ---- 工具结果 ----
  | { kind: 'tool_result'; toolUseId: string; text: string; isError: boolean; partial?: boolean; append?: boolean }
  // ---- 后台任务 ----
  | { kind: 'task_started' | 'task_progress' | 'task_updated' | 'task_notification'; /* 现行字段平移 */ }
  // ---- 边界与兜底 ----
  | { kind: 'compact_boundary'; preTokens?: number; postTokens?: number }
  | { kind: 'control_error'; error: string }                           // ← control_response subtype=error
  | { kind: 'unknown'; raw: Record<string, unknown> }                  // 宽松解析原则的对应物：未知一律透传为 unknown，不静默丢弃
```

设计要点：

- **流式与成稿的二元性保留**：`block_start/block_delta/blocks_commit` 与 `message` 并存——
  这是两后端都已对齐的事实模型（codex delta 已翻译成 stream_event），不另起炉灶。
- **`unknown` 兜底是一等公民**：沿用 claude 适配器的宽松解析原则（未知字段/未知 type 透传），
  中立化不能以「联合里没有」为由丢事件（codex 侧曾丢五种 type 的教训）。
- **审批不在 AgentEvent 里**：审批走既有 `ServerEvent` 旁路（已中立），不重复建模。
- **EventBlock/TokenUsage 复用 protocol 包现有类型**，不新造。

## 三、分阶段迁移路径（触发条件到来后按序施工）

每阶段独立 PR、可回退；全部阶段完成前 stream-json 词汇表不下线。

- **阶段 0 · 定义**：AgentEvent 进 `@anyplane/protocol`（纯类型零运行时，本包惯例）+
  与现状词汇表的映射测试（穷举 handleCli 分支 ↔ kinds 一一对应）。验收：typecheck + 映射表穷举测试。
- **阶段 1 · 服务端双发**：两 adapter 各自把事件翻译成 AgentEvent；WS 在 `cli` 之外并行下发
  `agent` 事件（ServerEvent 加一个变体）。前端只读不动。验收：e2e-mock 扩展 mock 双发断言
  两流逐条等价（mock 可控，最适合做等价性证明）；真实 CLI e2e 抽查。
- **阶段 2 · 前端切换**：ingest 新增 AgentEvent 入口（同一归并核心，输入换词汇表）；
  灰度开关（`?eventModel=agent` query 或 localStorage）A/B 对照同一抄本渲染。
  验收：窗口化 fixture 四段场景在两条输入路径下同绿 + 真实会话 chrome-devtools 对照。
- **阶段 3 · 退役**：`cli` 事件下线，stream-json 降为 claude adapter 内部 wire；
  codex translate.ts 的输出目标改 AgentEvent（58 个构造点逐个迁移）。验收：全量测试 +
  e2e-mock + 一周观察期无回归。

**红线沿用**：ingest 唯一实现（live/tail/历史三路共用同一归并核心，词汇表切换只在入口处翻译）；
live 与历史同形；窗口化三红线区改动必须 fixture 全绿（**前置依赖：fixture S3 存量失败须先修复**，
见 ROADMAP 方向七段落——验收基线坏了的时候不能做大规模渲染链路改造）。

## 四、触发条件与明确不做

**启动阶段 0 的信号**（任一）：确定接入第三家后端（Gemini CLI / Cursor CLI 等）并给出目标日期；
或上游 claude 协议出现破坏性词汇变更且翻译层兜底成本超过中立化成本（漂移周报评估）。

**明确不做**：
- 不为假想需求提前抽象——触发信号到来前，以上全是纸面。
- 不覆盖 claude 私有 subtype（side_question/generate_session_title）——它们走 capabilities
  守卫的后端旁路通道，不进事件主流。
- 不改 SessionState 的字段语义（busy/usage 口径差异由适配器各自对齐官方，中立化不消灭语义差异）。
- 不动审批/能力声明/REST 注册表（13.1/13.3 已中立）。

## 五、风险清单

| 风险 | 缓解 |
|---|---|
| 双发期两流不等价（翻译 bug 藏在并行期） | 阶段 1 的 mock 等价性断言是硬卡口；不等价不进阶段 2 |
| ingest 入口分叉（违背唯一实现原则） | AgentEvent 入口只翻译词汇，归并核心共享；PR 审查盯死 |
| codex 翻译层 58 个构造点迁移漏点 | 阶段 3 配对照表逐个勾销；未知 type 一律 unknown 兜底不丢 |
| 渲染链路大改撞上窗口化红线区 | fixture 先行修复 + 四段场景两路径对照绿才合并 |
