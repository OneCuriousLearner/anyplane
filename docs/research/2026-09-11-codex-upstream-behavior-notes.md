# Codex 上游行为实测笔记

> 从 AGENTS.md 迁出（2026-09-11 精简）。这里记录的是**读 anyplane 仓库代码读不出的上游行为**，
> 均标注实测版本；上游迭代极快，内容会随版本腐烂——改 codex 后端前以
> `codex app-server generate-ts --experimental`（协议正本）与最新实测为准，本文仅作历史参照。
> 本仓库因此做的设计决策留在 AGENTS.md，不在此重复。

## wire 枚举双轨（0.147.0 实测）

- `thread/start` 的 `sandbox` 是 kebab-case；`turn/start` 的 `sandboxPolicy` 是 camelCase。两处都发，勿混。

## 线程占用与卸载

- 线程被其他进程持有时 `thread/resume` 报 -32600（anyplane UI 显示"被占用"）。
- writer lock 是跨进程文件锁（`$CODEX_HOME/thread-writer-locks/`），随线程卸载才释放。
- 不 kill 线程进程：断开订阅后 app-server 在**无订阅且无活动满 `thread_unload_delay_secs` 后卸载**；
  该默认值上游已从 30 分钟改为 60 秒（0.149 实测；`thread_unload_delay_secs = 1800` 可恢复旧行为）。
  卸载更快不影响体验：重新 attach 走 `thread/resume`。

## 上下文水合数据源（0.153.4 实测/源码双证）

- paginated 线程的**冷** resume（线程未被该 app-server 进程加载）在应答后自动补发
  `thread/tokenUsage/updated`——`excludeTurns:true` 廉价路径也发。
- **热** resume（60s unload 窗口内线程仍在内存）不发——环形等首个新 turn（窄窗口优雅降级）。
- legacy 线程 resume 恒不补发；rollout 尾部回扫仅对 legacy 有意义，且随 sqlite 化静默失效。
- **上游线程持久化已切 sqlite（`~/.codex/*.sqlite`，rollout jsonl 停止新增）**。

## 历史读取（方向四，0.153.4 实测）

- 新线程 0.153 起默认 `historyMode:'paginated'`。
- paginated 历史 = `thread/turns/list`（**默认降序**，必须显式 `sortDirection:'asc'`；内嵌 items
  只有 user/agentMessage 摘要）+ `thread/items/list`（跨 turn 升序分页，entry 为 `{turnId, item}`
  包装，item 与 live `item/completed` 同形同 id）。
- legacy `thread/read includeTurns` 缺 commandExecution/collabAgentToolCall/reasoning（0.153.4 未修）；
  `items/list` 对 legacy 线程报 -32601（借不了分页）。

## 回滚（方向四，0.153.4 实测）

- paginated 走 `thread/revert`：原地截断持久历史，thread id/连接/订阅全保留，完成后服务端发
  `thread/reverted`；`beforeTurnId` 语义是"该轮及其后全部移除"。legacy 无 revert，降级 `thread/fork`。

## 实时流（方向五，0.148 实测）

- `item/agentMessage/delta`、`item/reasoning/textDelta`、`item/commandExecution/outputDelta` 真实到达。
  （deepseek-v4 发 raw content，不发 summaryTextDelta。）
- `item/reasoning/summaryPartAdded` 仅在见过 summary delta 时补 `\n\n` 分段。
- `plan/delta` 官方标注 experimental 且拼接不保证等于成稿。
- **0.148 起子线程实时事件直接推到父连接**（含嵌套孙线程、resume 后同样成立）——
  旧结论"不被转发"已过时。
