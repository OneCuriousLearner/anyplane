/security-review 审查 the entire cc-remote repository：覆盖 server/、web/、scripts/ 下全部 TypeScript/TSX 源码。不要只看当前分支的 pending changes——当前分支是新开的、没有 diff，必须主动把全仓库当作审查对象。

以下约束与审查目标同属本任务的强制要求：

- 重点关注：注入、认证与授权绕过、CORS/跨源防护、密钥与 token 泄露、SSRF、路径穿越、不安全的默认值、WebSocket 鉴权缺口。
- 既有设计红线：本仓库 docs/ 与 AGENTS.md 记载了既有的安全设计（如 Origin/Host 一致性校验、审批能力 URL、订阅 endpoint 白名单、authToken 防线），修复时不要破坏这些刻意设计——它们是防线而不是 bug。
- 证据纪律：只修复确认的真实问题（每项给出 file:line 证据）；疑似但无法确认的列入 PR 描述供人工判断。
- 执行环境：本项目只使用 Bun（>= 1.3.13），绝不要用 npm / npx / yarn / pnpm；如需运行测试先 bun install，测试命令 bun test（在工作区根目录运行）。
- 修复后如影响到可测试逻辑，运行 bun test 确认全绿。
- 提交规范：按主题拆分为多个 commit，每个 commit 消息清晰说明修复的安全问题（遵循仓库既有 commit 风格）。
- 范围纪律：精确实现任务要求——不要顺手做任务范围外的重构、抽象或文档；保持改动最小化。
- 无价值不硬改：评估后认为没有值得改动的地方，不要强行制造改动，直接输出结论说明即可。
- 全部完成后：git push -u origin <当前分支>，然后用 gh pr create 创建一个以 master 为 base 的 PR，正文逐项列出：发现（含 file:line 证据）→ 修复 → 残留风险。
- 最后输出一段总结：发现清单（含证据）、修复清单、commit 列表、PR 链接。
