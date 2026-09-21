# Codex ThreadItem 曾静默丢弃五种（踩坑实录）

> 从 AGENTS.md 迁出并独立成文（2026-09-21）。旧稿曾误写入
> `2026-09-11-codex-upstream-behavior-notes.md`；按文档地图，踩坑实录单独留档。
> 决策（未知 type 留痕后透传/跳过、live/历史必须同形）留在 AGENTS.md。

## 版本

- 协议基线：codex app-server schema **0.148.0–0.153.4** 的 `ThreadItem` union 已含这五种
  （对照 `server/scripts/codex-schema-baseline/v2/ThreadItem.ts` 与
  `docs/research/2026-09-11-codex-upstream-behavior-notes.md`）。
- 本仓库补齐：anyplane **v0.1.3**（`docs/releasing.md`：ThreadItem 补齐 5 种，live/历史同形）。

## 事实

live（`itemStarted` / `itemCompleted`）与历史（`itemsToHistory`）必须同形，否则刷新页面
卡片凭空消失。早期实现丢过：

- `hookPrompt`
- `dynamicToolCall`
- `imageView`
- `sleep`
- `imageGeneration`

用了 hooks 或生图的会话抄本会凭空缺块。

`collabAgentToolCall` / `subAgentActivity` 有意只走侧栏桶、不进主线——这不是丢弃，
是分流。其余未知 type 现行路径是 `log.warn` 留痕后透传或跳过，禁止再静默丢。
