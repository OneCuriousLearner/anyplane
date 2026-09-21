# 后台任务侧栏水合（踩坑实录）

> 从 AGENTS.md 迁出（2026-09-21）。数字与复现是成文当时的事实；
> 红线摘要在 AGENTS.md 前端节，代码在 `web/src/hooks/useTaskBuckets.ts`。

## 版本

- 复现口径写在 `useTaskBuckets.ts` 的 `selectHistoryBuckets`：历史窗口约 **300 条**，
  窗外 **20 个** subagent 被误判未完成。宽限期镜像官方协调器面板 `PANEL_GRACE_MS`
  （本仓库 30s）。
- 事件面：Claude Code 的 `task_started`（live-only，不落盘）+ 历史 `subagents`；
  Codex 侧桶键为子线程 id，`collabAgentToolCall` 另出主线卡。未钉单一 CLI 小版本——
  这是 AnyPlane 水合规则踩坑，不是某次上游 schema 漂移。

## `task_started` 是 live-only

该事件不落盘。中途接入的客户端如果只靠历史重建，running 桶首绘即终态。
必须用 status 事件携带的服务端权威 `activeTasks` 水合补建。

## 历史 `subagents` 的回填窗口

只回填同时满足这两条的 subagent：

1. Agent/Task `tool_use` 在**已加载历史窗口内**
2. 主线 `tool_result` 缺失

已完成的、以及调用落在分页窗口之外的，都不建桶。

反例：300 条窗口外 20 个 subagent 被误判未完成 → 复活 → 水合判终态 → 约 30s 齐消失。

## 终态只有一种语义

挂 `evictAfter` 宽限期驱逐（镜像官方 `PANEL_GRACE_MS`），驱逐即永久。
外部会话（tailer 路径）以主线 `tool_result` 为唯一终态信号，走同一套。

Codex 侧桶键统一为子线程 id；`collabAgentToolCall` 必须同时出主线 Collab 工具卡
（Begin 建卡、End 配对），否则主线看不到任何工具调用。
