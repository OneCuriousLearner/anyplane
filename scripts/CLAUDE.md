---
name: claude-task-cycle-workflow
description: anyplane 自动化维护周期（scripts/claude-task.sh）的执行与审查要点
---

anyplane 的 `scripts/claude-task.sh <task>` 在隔离 worktree 跑 headless claude 并产出 PR（任务 prompt 在 `.claude/tasks/`：simplify / code-review / security-review / test-coverage / test-cleanup）。2026-09-04 跑通全 5 棒周期的经验：

**Why:** 这些坑每周期都会再遇到，事先知道可省一次 CI 往返。

**How to apply:**
- 串行执行、每棒合入后 `git pull` 再跑下一棒（脚本以 origin/master 为基准建worktree）。
- 棒是长任务（实测 15–40 分钟/棒）：用 `setsid nohup bash scripts/claude-task.sh ... & disown` 脱离会话启动（否则后台任务 10 分钟超时杀棒），配 Monitor 盯日志的 `✅/❌` 结束标记，进程消失无标记也要报（异常死亡分支）。**进程存活判定别 `kill -0 $!`**：setsid 是否 fork 取决于调用 shell 的 job-control 状态——fork 时 `$!` 是即刻退出的包装进程，真 runner 换了 PID 且 PPID=1（2026-09-18 曾因此误报异常死亡）。用 `pgrep -f "claude-task.sh <task>"` 找真 PID，或干脆只盯日志标记。**pgrep 必须写成 `[c]laude-task.sh <task>` 方括号形态**（2026-09-21 实测）：Monitor 进程自己的命令行含着同样的搜索串，裸 `pgrep -f` 会自匹配，runner 死了也永远判存活、漏报异常死亡。脚本在 fetch/worktree 阶段的失败（set -e 直死）不会打印 ❌——异常死亡分支是唯一兜底，必须可靠。
- 分支保护要求 review + CI 绿；PR 作者与 gh 登录同为 OneCuriousLearner，自审不计，审查通过后用 `gh pr merge --merge --delete-branch --admin`（仓库惯例是 merge commit，非 squash）。
- Windows CI 对 mtime/路径敏感的测试易红：`hydratedContextOf` 类 mtime 缓存测试重写文件后必须 `utimesSync` 显式推进 mtime；`bun -e` 子进程测试别把 Windows 路径用字符串 replace 拼进脚本字面量（反斜杠被吞），从 `process.env` 读。
- **跨平台测试顺序坑（2026-09-10 周期实测）**：`bun test` 单进程跨文件共享模块实例，文件枚举顺序各平台不同——依赖"全局单态未被前人触碰"的用例（如 warn-once）本地/Windows 绿而 ubuntu 红。修法：被测模块加 `resetXxxForTest()` 复位口，用例开头显式调用，不靠执行顺序。
- 审查重点：simplify 类 PR 核对"等价变换"的求值顺序与 memo 的不可变更新前提；test-cleanup 类 PR 核对"重复覆盖"声称的正本测试确实存在；test-coverage 类 PR 额外核对全局单态（sink/计数器）用例的顺序无关性。
- `gh pr merge --delete-branch` 删不掉被临时 worktree 占用的同名本地分支：先 `git worktree remove` 再 `git branch -D`，顺序反了会报 "checked out at"。
- **5 小时额度暴毙（2026-09-21 实测）**：API 端点 403 "5-hour usage limit" 会让棒以 is_error=true 收场、worktree 保留现场。处置：先查现场 `git log`/`git status`——若零产出（无 commit 无改动，分析期暴毙是常态）直接 `git worktree remove --force` + `git branch -D` 清掉重跑；重跑前 `git rev-parse origin/master` 确认基准未漂移。有产出才考虑 resume。
- **结果 JSON 的 duration_ms/num_turns 只反映收尾段**（2026-09-21 实测）：长棒（1h47m 墙钟）JSON 里 duration_ms 仅 206s、num_turns 12——时间线要以 task-log 文件 mtime 与 commit 时间重建，别被 JSON 时长误导成"棒跑得太快不真实"。
- **第三方 API 端点模型口径**：`--model` 只管主循环；Task 子代理走 `CLAUDE_CODE_SUBAGENT_MODEL`（例如 kimi-for-coding[1M]）——子代理密集型棒（code-review）后台记录 ~96% 是 SubAgent 属预期。端点合法 id 以 `GET $ANTHROPIC_BASE_URL/v1/models` 为准。
- **e2e 收尾回归（2026-09-10 实测）**：配了 authToken 的机器上 e2e 脚本必须带 `ANYPLANE_TOKEN`（WS 与 REST 两侧，REST 曾漏接报假阴性，PR #26 已收口 apiFetch）。`e2e-rewind` 的目标会话必须有**文件改动过的 turn**（纯问答无 checkpoint ⇒ rewindable 恒 false ⇒ "没有可回滚的用户消息"）；rewind 目标若是需审批的消息，resume 重放会把审批路由回 stdio，脚本须自动裁决（已内置）。e2e-handoff 需要 handoff-lab 项目的会话作源（简报关键词断言）。
