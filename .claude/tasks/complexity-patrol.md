运行并处置 anyplane 全仓的复杂度告警：先跑 `bun scripts/complexity-report.ts` 拿到定量候选清单（行数 / 单函数长度 / hook 密度 / git 变更热点），再对每个 **NEW** 文件做**定性裁决**（判定标准与既有裁决先例见 `docs/complexity-baseline.md`，先读它再动手）。

背景：「巨石」是定性概念（职责混叠 + 状态纠缠 + 不可测），脚本的阈值只是触发器——`docs/complexity-baseline.md` 里既有反例：813 行的 translate.ts 刻意不拆（拆了破坏 live/历史同形红线），而 209 行的 App.tsx 组合根也可能是合理内聚。**不得把"命中阈值"当"必须拆分"**。

处置流程（每一步都要做）：

1. 运行 `bun scripts/complexity-report.ts`，列出全部 NEW 告警文件。
2. 逐个深读 NEW 文件（本轮重点嫌疑从高到低：SessionList.tsx hooks=34 + 变更 44 次、DirPicker.tsx hooks=26、App.tsx、其余按报告优先级），按基线文档的定性标准裁决：
   - **确认巨石且有清晰拆分边界** → 实施拆分。拆分必须尊重仓库红线（见 AGENTS.md：live/历史同形、port.ts 契约叶子不 import 适配器、store/ref 分层、零行为改动优先）。
   - **大但内聚 / 纠缠是领域不变量** → 不做手术，把该文件路径加入 `scripts/complexity-report.ts` 的 `BASELINE`，并在 `docs/complexity-baseline.md` 的"大但内聚"表补一行不拆的理由（写清是哪条定性判据判它无罪）。
3. 全部裁决完毕后，在 `docs/complexity-baseline.md` 的"裁决日志"新增一节（倒序、最新在上，对齐 drift.md 范式）：日期、每个 NEW 文件一句定性结论、手术内容、**不做的决策**（防止将来重新论证）。
4. 如有手术改动：`bun run verify` 必须全绿。
5. 提交：手术改动与 BASELINE/文档更新分开 commit（BASELINE 增补单独一个 commit，消息说明本轮裁决结论）；commit 风格遵循仓库惯例。
6. 全部完成后：git push -u origin <当前分支>，用 gh pr create 创建以 master 为 base 的 PR，标题与正文说明：本轮裁决了哪些文件（各给一句结论）、做了哪些拆分、PR 链接。
7. 最后输出总结：裁决清单（每个 NEW 文件一句定性结论）、手术内容、commit 列表、PR 链接。

以下约束与任务目标同属强制要求：

- 执行环境：本项目仅使用 Bun（版本门槛见 AGENTS.md），绝不要用 npm / npx / yarn / pnpm。
- 范围纪律：只处置 complexity-report 报告的 NEW 告警文件与既有裁决文件的排期手术，不要顺手重构范围外的代码；拆分以"解耦"为目的，机械性搬家（无纠缠收益）不做。
- 无价值不硬改：若裁决后认为所有 NEW 文件都不值得拆分，只做 BASELINE 增补与文档更新，不要强行制造手术。
- 测试纪律：动了可测试逻辑就补/迁单测（就近 `*.test.ts`）；verify 半截输出不算过。
