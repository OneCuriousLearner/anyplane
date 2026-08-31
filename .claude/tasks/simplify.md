/simplify 审查并修复 the entire cc-remote repository：覆盖 server/、web/、scripts/ 下全部 TypeScript/TSX 源码。不要只看最近 diff 或当前分支 pending changes——当前分支是新开的、没有 diff，必须主动把全仓库当作审查对象。按复用、简化、效率、altitude 清理标准执行并应用修复。

以下约束与审查目标同属本任务的强制要求：

- 执行环境：本项目只使用 Bun（>= 1.3.13），绝不要用 npm / npx / yarn / pnpm；如需运行测试先 bun install，测试命令 bun test（在工作区根目录运行）。
- 修改后如影响到可测试逻辑，运行 bun test 确认全绿。
- 提交规范：按主题拆分为多个 commit，每个 commit 消息清晰说明改动意图（遵循仓库既有 commit 风格）。
- 范围纪律：精确实现任务要求——不要顺手做任务范围外的重构、抽象或文档；保持改动最小化。
- 无价值不硬改：评估后认为没有值得改动的地方，不要强行制造改动，直接输出结论说明即可。
- 全部完成后：git push -u origin <当前分支>，然后用 gh pr create 创建一个以 master 为 base 的 PR，标题与正文说明本次任务做了什么、关键改动有哪些。
- 最后输出一段总结：做了哪些改动、commit 列表、PR 链接。
