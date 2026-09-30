# 多批次 PR 计划（2026-09-29）

> 依据：`.tmp/决策文档.md` 已填版。本文是执行跟踪表——每 PR 完成后勾掉并填 PR 号。
>
> **范围确认**（从勾选读出）：批次 A–D 全修 + E1 / E2 / E3 / E4。
> - E2 确认本期做（用户 2026-09-29 补充，原漏勾）。
> - E1 子决策 1 的 busy 处理确认按默认「拒绝并提示先中断」。

## 执行纪律（每个 PR 同此闸）

1. 从最新 `origin/master` 开分支；收尾前 `git fetch`，主干有更新先 rebase。
2. `bun run verify` 全绿 → 按 `REVIEW.md` 过一遍 → 开 PR。
3. **chrome-devtools MCP 实测（立规项）**：凡动前端/交互/协议，必须在真实浏览器走完用户路径才算完成；Composer/审批卡/列表类带桌面 1440×900 + 手机 390×844 双视口。实测结果写进 PR 描述。
4. PR 检查全绿（含 Windows 矩阵与镜像构建），红了修同一 PR；合入权只在用户。
5. commit message 中文一行、无 AI 署名。

## 顺序与依赖

```
PR-1 (D1+D4) ─→ PR-2 (D2+D3) ───────────────────────────→ PR-11 (E4)
PR-3 (A1-3) ─→ PR-4 (A4-6) ─→ PR-5 (C3) ─→ PR-6 (B) ─→ PR-7 (C1+C2) ─→ PR-8 (E1) ─→ PR-9 (E2)
                                                                 PR-10 (E3，独立)
```

- **D 最先**：codex 已升 0.158.0，刷基线 + 回归顺势做完，止住每周 CI 漂移噪音；后续所有 codex 侧改动建立在新基线上。
- **A 其次**：痛点最直接；A1–A3 同属「点不中 / 点了没反应 / 发不出去」一簇；A4–A6 是独立小修一簇。
- **C3 单独一个 PR**：本轮最大前端改动，且必须在 A1/A2 之后——同一张审批卡的交互先修对，再做吸附重构。
- **C1+C2 排在审批区域稳定后**（A、C3 都落地）。
- **E1 在 B 之后**：合并展示 + 墓碑态是生命周期动作的 UI 基础。

---

## PR-1　`fix/drift-codex-158-baseline`（批次 D1 + D4）　规模 S

- [ ] `check-codex-schema.ts --update` 刷基线 → 复跑确认零漂移（本地已是 0.158.0）
- [ ] `check-claude-protocol.ts --update`（`mcp_read_resource` 入清单）
- [ ] `docs/drift.md` 新增一节（倒序）：claude SDK 0.3.283/284 = 客户端控制请求、零影响；codex 51 处 = additive + 废弃 `thread/rollback` 移除（AnyPlane 用 `thread/revert` 不受影响）
- [ ] 真 CLI e2e 回归（升级必查，0.155.1 的教训）：① msys2 沙箱探针——`CreateFileMapping Win32 error 5` 在 0.158.0 是否仍崩（结果决定沙盒绕法与 issue 结论）；② `ephemeral fork 强制 excludeTurns` 行为是否变化；③ 接力 / /review / /compact e2e 复跑
- [ ] D4：SW 注册加 `updateViaCache: 'none'`（独立小 commit）
- **实测**：服务起、页面加载、DevTools Application 面板 SW 注册正常、控制台无错
- **收尾**：CI 绿后评论并关 issue #84、#85（指向 drift.md 新章节）
- 风险：低

## PR-2　`fix/codex-name-updated-and-compact-wrapper`（批次 D2 + D3）　规模 S

- [ ] D2：剥 Codex compact 摘要上游 wrapper 话术，只留 `# Handoff Summary` 起的内容
- [ ] D3：接住 `thread/name/updated` 通知（现被 default 分支静默丢），复用 `thread_reverted` 的 system 消息范式广播；前端标题就地更新
- **实测**：① `/compact` 后摘要气泡无 wrapper 话术；② 终端里对同一线程 `codex` 改名的同时，AnyPlane 已 attach 页面标题实时跟上（跨客户端实测）
- 依赖：PR-1（在 0.158.0 基线上做适配器行为改动）
- 风险：低

## PR-3　`fix/composer-hit-and-approval`（批次 A1 + A2 + A3）　规模 M

- [ ] A1：`Composer.tsx:215` 悬浮条 `pointer-events: none`，输入卡片/插队条/回到底部钮各自 `pointer-events: auto`
- [ ] A2：中断路径清 `hub.pendingApprovals` 并推 status/approval_resolved（客户端 reconcile 现成）；WS 裁决落空（`resolveApproval` 返回 false）时给该客户端「该审批已处理或失效」提示并撤卡
- [ ] A3：选中插队/排队且输入框有文本时，中断键旁补发送键
- [ ] A3 备注项：**调研「消息发出前撤回并重新编辑」**——claude-code 交互模式排队消息可撤回编辑；查 AnyPlane 排队消息在 server 侧还是已写 stdin。server 侧内存队列则可撤回（做「撤回排队消息」），已写 stdin 则不可撤回 → 在研究文档标注放弃及原因
- **实测**（09-27 复现场景，双视口）：① 审批卡滚到视口底缘，真实点击「✓ 允许」生效（不再被遮罩吞）；② 等待审批时中断 → 卡撤下，点击不再静默；③ busy 时选插队 → 发送键出现、点击发出、下一轮边界被模型读到；④ 手机上点审批按钮不再聚焦输入框
- 风险：低-中

## PR-4　`fix/ux-small-batch`（批次 A4 + A5 + A6）　规模 M

- [ ] A4-1 回收站 claude 行补 title/lastPrompt（`ArchivedEntry` 字段现成）
- [ ] A4-2 Codex 详情抽屉：MCP 空态写人话；静态用量区（`state.context`）；接 Escape（PopupPanel 范式）
- [ ] A4-3 通知菜单路由变化即收
- [ ] A4-4 通知权限 denied/挂起各给一句人话提示
- [ ] A4-5 目录列举过滤系统/隐藏目录（`$RECYCLE.BIN`、`Config.Msi` 等，fsbrowse 层）
- [ ] A4-6 「后台任务完成」文案区分跑完/被停（`status=stopped` 数据现成）
- [ ] A4-7 AskUserQuestion 卡片去重（只留结构卡）；占位符补 Enter 发送/换行键提示（先确认换行键）
- [ ] A5 `toolSummary`/`toolDetail` Bash 分支：argv 数组 join、剥 `pwsh -Command` 包装、unescape 一层、截 60 字符
- [ ] A6 验证 `/branch` 孤立 fork 文件今天是否还以独立行出现、可否 resume；可 resume 则标注不关代码、不可 resume 才加过滤
- **实测**：逐项过真实界面（回收站、Codex 详情抽屉 Escape、目录选择器、后台任务停止后文案、Codex Bash 卡标题可扫、审批卡 PowerShell 可读）
- 风险：低

## PR-5　`feat/pending-approval-pin`（批次 C3）　规模 L

- [ ] pending 审批卡从抄本流拿出，固定吸附在输入区上方（官方权限对话框即模态）；AskUserQuestion 待答卡同属此位
- [ ] 进会话若有 pending 审批/提问，初始定位直接对准它
- [ ] 守住抄本窗口化三条红线（初始定位先于窗口化；扩窗只认向上滚动；行 key 内容派生）——评审重点
- **实测**（双视口）：① 任意滚动位置审批卡都固定可点；② 进有 pending 的会话直接看到卡；③ 长会话翻读历史时卡不晃、不误触；④ 裁决后卡消失、抄本位置不跳
- 依赖：PR-3（A1/A2 先修对交互）
- 风险：本轮最高（窗口化红线区）

## PR-6　`feat/list-triage-and-worktree-merge`（批次 B1 + B2 + B3）　规模 M-L

- [ ] B1：组间排序——有 waiting 行的组整体浮到列表最前（组间再按各自 max mtime）；全局「需要我」区**不做**（用户标注短期不议）
- [ ] B2：**只做**行状态「N 个后台任务」档（activeTaskCount>0 且非 waiting/busy 时优先于「空闲」）；离线/回收/外部会话文案**不动**（用户明确）
- [ ] B3：分组键 `worktreeOf ?? cwd`——worktree 会话落进主仓组，组内「主目录条目 → 各 worktree 子节（目录名+分支小标题）」；窄栏徽章退 title
- [ ] B3-1 墓碑态：列表行带 `dirExists` 信号（逐行 existsSync）；目录已删的行标「目录已不存在」，会话内禁用输入框 + 「放入回收站」快捷动作
- [ ] B3-2 worktreeOf 落 `~/.anyplane/` 侧车（首次发现时记 cwd→worktreeOf，不自动清理），目录删了归属还在
- **实测**（三目录 worktree 沙盒复现，双视口 + 窄侧栏）：waiting 组浮顶、后台任务档、worktree 合并分组与窄栏组名、删目录后墓碑态与禁用输入框、归属信息不丢
- 风险：中

## PR-7　`fix/approval-semantics`（批次 C1 + C2）　规模 S-M

- [ ] C1 采用②：放行集清理放进 `dispose()` **同步路径**（不再依赖 onExit 送达），消除掷硬币；tooltip 维持「重开会话失效」（现在终于为真）；codex 侧确认 app-server 死亡时各 hub 同步清
- [ ] C2 `summarizeInput` 检测 cwd 外绝对路径（Windows 盘符 + POSIX），审批卡加「⚠ 此操作触及工作目录之外：…」；规则引擎 `outsideCwd` 维度**不做**（用户：Codex 自己该管的）
- [ ] **C2 同仓库家族豁免（E1 备注推导）**：agent 受用户之托在自建 worktree 里干活是官方鼓励的玩法，若每次写文件都弹警示 = 警报疲劳。对候选路径 walk up 找 `.git` 比**共同 git commondir**：与会话 cwd 同一家族（主仓 ↔ 其任何 worktree，含会话中途新建的）不警示；跨仓库/碰系统路径（09-27 从隔壁项目拷 node_modules 那类）才警示。审批路径不热，两次文件读可接受
- **实测**：① 放行 → 等空闲回收 → 重生后同类工具**必重问**（确定性验证，两次结果一致）；② 让 agent 碰**异仓库**路径 → 警示行出现；③ 让 agent 在会话内建 worktree 并写文件 → **不**弹警示（家族豁免生效）
- 依赖：PR-3、PR-5（审批区域稳定后改语义）
- 风险：低-中

## PR-8　`feat/worktree-lifecycle`（批次 E1）　规模 M-L

- [ ] 移除动作：新端点校验 cwd 确为 worktree（`readGitInfo` 现成）→ dispose 该 cwd 会话进程 → `git worktree remove` → 删不掉时兜底重试/明确报错；busy 会话**拒绝并提示先中断**（已确认）
- [ ] **dirty 两步走（E1 备注推导，这是常见路径不是边角）**：agent 干完活的 worktree 几乎必然有未提交改动（09-27 三个 worktree 全以此收尾），而 `git worktree remove` 对 dirty 树默认拒绝。先不带 `--force` 试；被拒时把「N 个已修改 / M 个未跟踪」摆进确认框，用户显式勾「丢弃未提交改动」才走第二步强制——**绝不静默 --force**
- [ ] **不碰分支**：移除只删目录与注册，确认框注明「分支 worktree-x 保留」；删分支是将来独立动作
- [ ] 创建入口：DirPicker「从当前目录拉 worktree 开会话」→ 服务端 `git worktree add` → 直接开新会话；落盘 **主仓同级 `<repo>-<名>`**，分支默认 `worktree-<名>`
- [ ] **项目首次 shell out git**：git 缺席时入口隐藏降级；注意 fsbrowse 纯读纪律的边界注释
- [ ] **来源无关（E1 备注）**：移除/展示不区分 worktree 来自用户终端、AnyPlane 创建、还是 agent 在会话里自建（`claude --worktree` / bash `git worktree add`）——校验一律走 `readGitInfo`；agent 自删的情形不拦截（墓碑态接住，Windows 锁致 git 报错是 agent 自己的上报路径，无数据损失）；嵌套 `claude --worktree` 会话以「外部会话」行进合并组，可接管（09-27 已实测）
- **实测**：产品内创建 → 干活 → 移除全链（重点复现 09-27 的 Windows 进程锁场景：会话活着时移除应成功——先 dispose 的顺序优势）；busy 时移除被拒有提示；**dirty 树移除先被拒、确认后强制成功**；agent 会话内自建 worktree → 出现在合并组、可被移除；git 缺席降级（临时改 PATH 模拟）
- 依赖：PR-6（B3 展示基础）
- 风险：中

## PR-9　`feat/diff-summary`（批次 E2）　规模 M

- [ ] 服务端按会话 cwd 跑 `git status --porcelain`（复用 PR-8 的 git 子进程基建；git 缺席/非 git 目录隐藏入口）→ 前端渲染改动文件清单（M/A/D 分组）+ 分支摘要；不渲染真 diff
- [ ] 位置：侧栏标签页化——「后台任务 / 改动」两页签共存（用户备注：参考后台任务侧栏形态，vscode 式多页签侧栏）
- **实测**：会话干活后打开「改动」页签 → 文件清单与 `git status` 一致；后台任务与改动两页签切换不互扰；非 git 目录会话入口隐藏
- 依赖：PR-8（git 子进程基建）
- 风险：中

## PR-10　`feat/at-file-completion-p0`（批次 E3 P0）　规模 M

- [ ] 服务端新端点：按会话 key 反查 cwd 列单层文件（**红线：root 服务端锁定，不接客户端任意路径**；沿用 /api 鉴权守卫）
- [ ] Composer `@` 触发面板，前缀补全，键盘语义复用斜杠面板（↑↓/Tab/Esc/Enter）
- [ ] 暴露面说明进 PR 描述（文件名进列表=目录名→文件名升级，与目录列表接口同级风险）
- **实测**：`@` 弹面板、前缀过滤、键盘选择、选中文件进输入框并随消息发出；`../` 与绝对路径注入被拒
- 依赖：无
- 风险：中（暴露面）

## PR-11　`feat/codex-ai-title`（批次 E4）　规模 M

- [ ] codex port 补 `afterUserSent`：首条真实 user × 线程无 name → ephemeral 隐藏线程（approval never、read-only、30s、`output_schema` ≤36 字符）→ `thread/name/set` 写回（写前 `thread/read` 复查仍空；手动改名过的不覆盖；按 threadId 去重）
- [ ] 标题生成用**会话当前模型**（用户选定）；`capabilities.aiTitle` 翻真
- [ ] 成本说明进 PR 描述（每新会话一次真实模型调用）
- **实测**：新 Codex 会话发首条消息 → 列表/顶栏出现 AI 标题；`/rename` 改过名的线程不被覆盖；标题生成失败时静默降级不影响主线
- 依赖：PR-2（D3 的 name/updated 通道）
- 风险：中（与主 turn 并行，注意速率额度）

---

## 执行跟踪

| PR | 分支 | 状态 | PR 号 | 实测记录 |
|---|---|---|---|---|
| PR-1 | fix/drift-codex-158-baseline | ✅ CI 全绿，待用户 code-review | #86 | msys2 矩阵探针（仍崩）；fork excludeTurns 探针（仍强制）；接力双向 PASS；/review+/rename PASS；/compact UI PASS；SW 注册 DevTools 复核；issue #84/#85 已关 |
| PR-2 | fix/codex-name-updated-and-compact-wrapper | ✅ review 轮 CI 复绿，待用户合入 | #87 | D2 三路径剥离实测；D3 本端去重+外部回声+顶栏即时更新实测；review 四条低危全修并复验（finding-1 场景实测通过）；上游 name/set 广播探针 |
| PR-3 | fix/composer-hit-and-approval | ✅ review 轮 CI 复绿，待用户合入 | #88 | A1 双视口穿透探针+真实点击裁决落盘；A2 中断撤卡/双标签自愈/死 id 反馈行；A3 插队点击入轮回复+排队点击入队；review 三条全修并复验（steer 拆轮清审批实测、ensure 转发堵漏）；撤回调研进 research |
| PR-4 | fix/ux-small-batch | ✅ review 轮 CI 复绿，待用户合入 | #89 | A4-1 回收站标题行实测；A4-2 静态用量区/MCP人话/Escape实测；A4-3 菜单即收实测；A4-4 denied toast（mock permission）实测；A4-5 根层过滤保留+深层 recovery 不藏（review 修）；A4-6「已停止」文案实测；A5 codex 卡标题命令化实测；A6 /branch 单文件+可 resume 验证（无需代码） |
| PR-5 | feat/pending-approval-pin | ✅ CI 全绿，待用户 code-review | #90 | C3 四场景实测：scrollTop=0 卡位不变可点（①③）、reload 进会话卡吸附在输入区上方（②）、裁决后卡消失且 scroll 不跳（④）；AskUserQuestion 吸附+选择提交全流程；手机视口命中可点；横带穿透保持 |
| PR-6 | feat/list-triage-and-worktree-merge | ✅ review 轮 CI 复绿，待用户合入 | #91 | B1 waiting 组实测浮到第一；B2「1 个后台任务」档实测；B3 单组 22 行+wt 子节三连+窄栏无挤占实测；B3-1 行徽/墓碑条/归档动作全链实测；B3-2 侧车归属+删后保留实证；review 五条全修并复验（墓碑+pending 审批共存可裁决 codex 实测）；排障：路径归一、busy 口径、旧 bundle 测试假象 |
| PR-7 | fix/approval-semantics | ✅ review 轮 CI 复绿，待用户合入 | #92 | C1 实测（7481 短回收 probe server）：「本会话允许」→ 关页 → 5s 回收+dispose 日志实证 → 重开发同类 Write **必重问**（审批卡再现，不再自动放行）；C2 双端实测：异仓库路径警示行出现（⚠+路径+「同仓库 worktree 不提示」）、worktree 路径无警示且「规则自动放行（本会话允许）」；排障：首版「保险箱+喂回」在 stale swallow 下复活放行集（探针实证）→ 改进程层权威（rememberTool 写进程层、命中查进程层、dispose 同步焚毁、无喂回无复活）；登录提示关闭（本 PR 插队）：✕ 关闭→刷新保持→重启复现 全链实测；review 四条全修并复验（POSIX mangling 平台门控、win32 段级大小写实测：模型发全小写树内路径无警示、outsidePaths 三处同删、残留注释清理） |
| PR-8 | feat/worktree-lifecycle | ✅ review 轮 CI 复绿，待用户合入 | #93 | 创建实测：DirPicker「拉 worktree 开会话」→ ap-c1-main-pr8demo 落盘主仓同级、分支 worktree-pr8demo、git worktree list 注册、直接开会话；干活实测：会话内 Write work-output.txt（worktree 树内审批卡无警示行，family 豁免同律）；移除实测（dirty 两步走）：第一步确认框→409 升级「0 已修改/1 未跟踪」→第二步「丢弃改动并移除」→目录删+worktree 注销+分支保留；busy 拒绝实测（探针）：wt1 会话 busy 时 remove 409「有 1 个会话正在工作，请先中断再移除」；移除后列表行墓碑徽+会话内墓碑条实测；review 四条全修并复验（含空格路径单测实证、f2 探针：spawned 会话 dirty 第一步保活仍 spawned） |
| PR-9 | feat/diff-summary | ✅ 自 review+右栏调宽 CI 复绿，待用户合入 | #94 | 端点实测：git-status 按会话 key 反查（s| tail 态经 handoffSource fallback 覆盖）→ branch/4 文件分组/counts 逐字正确；非 git 目录 available:false；侧栏两页签实测：「后台任务/改动」页签出现（git 可用无任务也显示开关）→「改动」分支 wt-test+摘要「1 修改·1 删除·2 未跟踪」+分组渲染（新增 staged/删除 seed/未跟踪 loose+wt）与端点逐字一致→切回「后台任务」互不扰；排障：git-status cwd 反查补 handoffSource（s| 外部会话 tail 态）；自 review 五条处置（①git status --porcelain --branch 单调用②tab 随 sessionKey 复位③非 git 目录入口口径=维持现状（用户拍板）④rename/冲突分组粗粒度=可接受降级⑤切会话清旧数据）；右栏调宽（本 PR 插队）：拖动 380→720 clamp 顶+aside 实宽 720+记忆 720→双击恢复 380+aside 实宽 380+记忆 380，与左栏等价 |
| PR-10 | feat/at-file-completion-p0 | ✅ review 轮 CI 复绿，待用户合入（P0+P1 codex 双端实测补完） | #95 | 端点实测：fs-complete 单层列举正确、双重/三重编码注入均 400；@ 面板实测（claude）：@ 触发/过滤/Tab/Enter/Esc/句中替换前文不动；全链：发出「读一下 @wt.txt」agent 真读到；自 review 无 findings；**codex x| 盲区（用户实测发现）**：改 listSessions 行兜底，codex 会话 @ 出 25 项、@cod 过滤剩 codex/、Tab 采纳续探；review 三条全修（isComposing 守卫、atIdx 复位、删死代码）；**P0+P1 codex 双端补测（用户拍板）**：P0 @ 补全/改动摘要已修无盲区；P1① C1 放行集 codex「本会话允许」→ 空闲退订+放行集失效日志实证 → 重生必重问；P1② codex 中断撤卡（serverRequest/resolved 自愈）实测卡撤下回空闲——无新盲区；排障：windows runner 卡死取消重跑全绿 |
| PR-11 | feat/codex-ai-title | ⬜ | | |
