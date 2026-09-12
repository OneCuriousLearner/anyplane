/code-review {review-effort} --fix server/ web/ scripts/ cli/

review 完成后，按以下要求收尾（这些不是 review target，是你的后续工作指令）：

审查纪律（与收尾同属强制要求）：

- 全仓审查，不要只看当前分支 pending changes（当前分支是新开的、没有 diff）。历史存量问题也在范围内，不要把目光收成「最近改过的文件」。
- 不要把对象锁成 TypeScript/TSX：`web/public/sw.js`、`cli/anyplane.mjs` 与各目录下的 JS 都在范围内。
- 本任务只找正确性、跨文件契约分裂、静默失败。Reuse / Simplify / Efficiency / altitude 是 `simplify` 的职责，本轮不要借审查做重构。
- 对照 AGENTS.md 红线核查（修复时不要破坏刻意设计）：三层重键（Hub / 进程 map / 存活 WS `data.key`）、Hub 在会话句柄存活期间不得删除、busy / requires_action 时绝不回收、Codex live 与历史同形、上下文占用口径（不用 `result.usage` 的 input 侧）、抄本滚动三条红线。
- 涉及重键 / 回滚 / 重连补发的修复，PR 正文点名建议跑哪条 e2e（`e2e-handoff` / `e2e-rewind` / `e2e-ws` 等）；只跑 `bun test` 不能当作这些链路已验证。

1. 逐项复核 --fix 落到工作区的每一处修复，确认合理；如发现 review 误判导致的错误修复，回退该处并在 PR 描述中说明理由。
2. 你独立确认的、--fix 未覆盖的其他真实问题，可以补充修复；疑似但无法确认的问题列入 PR 描述，不要强行改。
3. 全部修复后运行 bun test 确认全绿（先 bun install；本项目只使用 Bun，绝不要用 npm / npx / yarn / pnpm）。
4. 按主题拆分为多个 commit，每个 commit 消息清晰说明改动意图（遵循仓库既有 commit 风格）；不要顺手做任务范围外的重构、抽象或文档，保持改动最小化。
5. git push -u origin <当前分支>，然后用 gh pr create 创建一个以 master 为 base 的 PR，正文说明：发现的问题（含 review 报告的与你独立确认的）、修复清单、回退的误判修复及理由。
6. 如果评估后认为没有值得改动的地方，不要强行制造改动；直接输出结论说明即可。
7. 最后输出一段总结：发现了哪些问题、修复了哪些、回退了哪些、commit 列表、PR 链接。
