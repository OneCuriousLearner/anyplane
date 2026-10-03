# Codex 0.158.0：rollout 已持久化 reasoning（paginated 线程）

2026-10-02 实测（codex-cli 0.158.0，Windows，deepseek-flash 与 GPT 系模型均现）：

- rollout（`~/.codex/sessions/**/rollout-*.jsonl`）出现 `response_item` 中 `payload.type: "reasoning"`
  的记录，`content: [{type: "reasoning_text", text: …}]` 带全文（`summary` 恒为空数组——
  供应商摘要在 `content` 而非 `summary`，`reasoningText()` 的镜像去重分支因此是主路径）。
- `thread/items/list`（paginated 历史投影）与 live `itemCompleted` 同形同 id 返回这些
  reasoning item——与 live 流 committed 思考块、anyplane 侧车条目的 `itemId` 三者同键。
- 直接后果：anyplane 侧车（`~/.anyplane/reasoning/`）与该线程 items **双源并存**，
  历史读取若照旧回插会把同一思考渲染两遍（侧车组插轮首 + inline 原位各一份，
  实测序列「思考1 思考2 思考3 思考1 文本1 …」）。修复：`turnsToHistory` 回插前按
  itemId 主键 + 文本兜底（无 itemId 的旧侧车条目）对当轮 inline reasoning 去重。
- 背景：`reasoningStore.ts` 头注释的「rollout 不持久化 reasoning」是 0.14x 时代
  （thread/turns/list full 视图只有 userMessage+agentMessage）的实测，0.158 起失效。
  同一线程内可能并存两种侧车条目（早期写入无 itemId、后期有）——去重必须两级。
- 侧车不退役：legacy 线程 items 仍无 reasoning（上游缺口未修）；且侧车是
  「live 期间任何plane 看到的思考」的自产记录，上游投影丢 payload 时仍是兜底。

验证方式：`bun run dev` 起新 codex 会话跑一轮带思考的 turn，重进会话数思考块；
或直接 grep rollout：`grep -c '"type":"reasoning"' rollout-*.jsonl`。
