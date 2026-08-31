/code-review {review-effort} --fix server/ web/ scripts/

review 完成后，按以下要求收尾（这些不是 review target，是你的后续工作指令）：

1. 逐项复核 --fix 落到工作区的每一处修复，确认合理；如发现 review 误判导致的错误修复，回退该处并在 PR 描述中说明理由。
2. 你独立确认的、--fix 未覆盖的其他真实问题，可以补充修复；疑似但无法确认的问题列入 PR 描述，不要强行改。
3. 全部修复后运行 bun test 确认全绿（先 bun install；本项目只使用 Bun，绝不要用 npm / npx / yarn / pnpm）。
4. 按主题拆分为多个 commit，每个 commit 消息清晰说明改动意图（遵循仓库既有 commit 风格）；不要顺手做任务范围外的重构、抽象或文档，保持改动最小化。
5. git push -u origin <当前分支>，然后用 gh pr create 创建一个以 master 为 base 的 PR，正文说明：发现的问题（含 review 报告的与你独立确认的）、修复清单、回退的误判修复及理由。
6. 如果评估后认为没有值得改动的地方，不要强行制造改动；直接输出结论说明即可。
7. 最后输出一段总结：发现了哪些问题、修复了哪些、回退了哪些、commit 列表、PR 链接。
