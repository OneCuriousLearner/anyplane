# 抄本尾部窗口化与初始定位（方向七实录）

> 从 ROADMAP「方向七」与文末「抄本窗口化 / 虚拟列表」两节合并迁出（2026-09-12）。
> 前两版方案都回退了，第三版（2026-09-09）的每条设计约束都直接对应其中一个坑——
> **回退根因比交付记录更值得长期保留**，故独立成文。
> 红线摘要在 AGENTS.md 前端章节；代码在 `web/src/hooks/useTranscriptScroll.ts`
> 与 `web/src/lib/transcriptWindow.ts`。ROADMAP 只留尚未动手的可选优化。

## 结论（第三版，2026-09-09 已上线）

`web/src/hooks/useTranscriptScroll.ts` 承接 Chat 全部滚动逻辑，窗口纯函数在
`web/src/lib/transcriptWindow.ts`（单测覆盖）；Chat/Transcript 接入切片与稳定 key。

- **初始定位（硬前提）**：首个非空抄本在 `useLayoutEffect` 以 `auto` 直达底部（绘制前完成），
  完成前扩窗门控恒关；会话切换的重置效应跳过首次挂载（实测：挂载即重置会清掉同帧 layout 锚点，
  扩窗门控永久关闭——fixture 首跑即逮到）。
- **扩窗门控**：仅「方向向上 + 距顶 < 480px + 初始定位完成」触发；本仓库不存在程序化向上滚动
  （跟随/回底/锚定补偿全部向下），方向向上 ⟺ 用户主动上翻（滚轮/touch/拖滚动条全覆盖）。
  锚定补偿与回底重置的钳位滚动套 200ms 豁免窗防回链。
- **窗口策略**：行数 >120 启用，初始只挂尾部 80 行，上翻按 60 行/段扩窗；prepend 后按
  scrollHeight 增量补偿 scrollTop（视口内容不跳）。atBottom 期间窗口随行数漂移保持尾部
  （跟随滚动钉底，顶部卸载不可见）；离开底部冻结起点；回到底部（滚动或 ↓ 按钮）恢复尾窗收敛。
  只向上生长不向下收缩——超长会话读到顶部时 DOM 会涨回全量，记录的取舍。
- **稳定 key**：Transcript 行 key 从索引改为内容派生（msg.id / 首块 key），
  扩窗平移不再 remount 已展开的思考/工具卡。
- **验收 fixture**：`web/transcript-fixture.html`（仅 Vite dev 提供，不进生产构建）合成 322 行
  混合抄本 + 分页数据源（首载 46 轮、20 轮/页 prepend），`?autorun=1` 自检四段场景
  （打开定位/流式追加有界/上翻扩窗+翻页锚定无跳变/回底收敛），
  chrome-devtools MCP 实测 14 断言全绿；真实会话集成冒烟（含直播流）通过。

## 前两版的回退根因

跟随滚动 rAF 合帧（流式输出曾每 token 一次 smooth scrollTo，移动端积 jank）
是早期落地的纯收益项，第三版沿用。**另外两条试过都回退了，根因是同一个：
与「打开会话即滚到最新」打架。**

`content-visibility:auto`（跳过视口外排版绘制）：视口外行按 `contain-intrinsic-size`
占位，首绘时 `scrollHeight` 被显著低估，滚到底会落空——实测打开长会话停在对话中段
并弹出「回到底部」按钮。绘制收益不值得换掉主行为。要用必须连初始定位一起重做
（例如初始定位完成前不启用、或对尾部若干行豁免）。

**窗口化（只渲染尾部 N 行、上翻扩窗）** 回退原因：

- 扩窗判定**不能用消息数**：活动分组把多条消息并成一行，rows 与 messages 差着量级，
  用消息数会导致条件恒真、持续扩窗
- 首绘时 `scrollTop` 恒为 0，若不加「初始定位已完成」守卫，会立刻扩窗并把视图钉在顶部，
  与自动滚到底互相打架
- 加了守卫后仍观察到初始位置不在底部：跟随滚动的 rAF 与新内容 commit 的时序，
  叠加 `behavior:'smooth'` 的动画目标会用到过期 scrollHeight

当时的结论（第三版照此执行）：要做就得连「初始定位」一起重设计——初始用 `auto` 直达底部
并在 layout 阶段完成，扩窗只由**用户主动输入**（wheel/touchmove）触发而非任意 scroll 事件。
**验收必须拿真实长会话**（> 200 行）跑，本仓库现有会话都不到 50 行，测不出来
（第三版因此才有了合成 fixture）。

## 窗口化实测逮出的两个存量 bug（2026-09-09 用户报告长会话复现）

1. **claude 历史 300 条硬截断**：`readHistory` 固定 `slice(-300)`，更早消息永不下发——
   窗口化上翻后才用户可见。已改为 `before` 行号游标分页（页间零重叠，`subagents` 仅首页下发），
   前端窗口扩到顶且 hasMore 时自动翻页 + 锚定 prepend（`ingest.prependHistoryMsgs`：
   全量重建工具索引顺带完成跨页配对）。实测 860 条会话 3 页、1726 条会话 6 页完整到顶，
   首条消息逐字命中。
2. **历史 agent 桶复活**：`subagents` 全量下发但主线消息被 300 条窗口截断，窗口外 agent 的
   tool_use 不在 `finished` 集合 → 全被误判未完成建桶 → hydrateTasks 判终态 → 30s 齐消失。
   修复为 `selectHistoryBuckets` 纯函数口径：只为「调用在已加载窗口内且未配对终态」的建桶，
   窗口外/已完成一律不建（真在跑的由 status activeTasks 权威水合兜底）。

## 审查修复轮（/code-review medium，8 项全修）

翻页响应的分页纪元守卫（在途期间 applyHistory/reset 重置过坐标系即作废）+ catch 补会话切换守卫
（错误卡不再写进新会话）；replay_gap 重载按「已加载数+500」保载拉取（append-only 下零漂移；
tail_reset 内容截断仍全量重置）；hasMore 期间推迟孤儿 tool_result 浮现（其 tool_use 可能在未加载页，
翻页时跨页配对完成）；翻到更早页时对首页留存的 subagents 做 add-only 补建桶；
扩窗 setState 走 flushSync 与同 lane 的 WS draft 更新隔离（锚定补偿不再混入尾部增量）；
哨兵 JSX 合一（对齐 fixture 形态）；onReachTop 与哨兵对 codex 关门（防方向四落地后渲染出死控件）。
