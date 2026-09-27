# 资深用户走查：并发长程任务下的 AnyPlane（2026-09-27）

> 第四轮走查。前三轮见 [2026-09-22-senior-user-ux-pass.md](2026-09-22-senior-user-ux-pass.md)（其问题 1–7、11、13–15 已在 PR #74–#83 修复，本轮逐条复核）。
> 本轮主题：**并发**。对照的是资深用户的真实日常——官方 power-user 指南明说「最大的生产力解锁是 3–5 个并行会话，各占一个 git worktree」，Codex 侧 0.149+ 有 `codex agents` 仪表盘（Need input / Working / Ready 三态分诊）。人在这套玩法里是技术主管：布置长任务、巡视谁需要裁决、打断改向、验收合并。
> 事实以当天生产界面实测为准（`bun run start` + 最新 `web/dist`，桌面 Chrome 1440×900，手机视口 390×844 单独标注）。

## 本轮设定

- 沙盒 `anyplane-e2e-sandbox` 先提交基线 `d2c0cd3`，再开两个 git worktree：`wt-index`、`wt-reporter`（资深用户并行流的官方形态）。
- 三条并发长程任务：
  - **Claude A**（主目录）：笔记索引模块（递归扫描 .md → 标题/wiki 链接/中英词数 → index.json + 12 用例）。后续追加：AskUserQuestion 问询 → frontmatter 支持 → 提交。
  - **Codex B**（wt-index）：fixture 生成器（seed 可复现 + 5 用例）。后续追加：/compact → /review → 修 review 发现的 P2 → CSV 生成器 → 插队 → %TEMP% 探针。
  - **Claude C**（wt-reporter）：bun test 报告工具（解析+渲染+CLI + 13 用例）。后续追加：拆分重构、后台慢命令、停止任务、bun.lock 提交。
  - 另有 Codex B → Claude 的**接力**会话（wt-index 内写「生成器 × 索引」集成测试，5 用例）。
- 全部在真实 UI 上驱动（chrome-devtools MCP），审批全部走真实裁决。沙盒三个目录的最终 git 状态见文末附录。

## 已经成立的部分（本轮复核）

这批路径当天是通的，且多数是前三轮问题的修复验证：

- **rekey 全生效**（PR #75）：Claude 首条消息后 `n|`→`s|<slug>|<uuid>`，Codex `xn|`→`x|`。工作中刷新页面（T+25 实测）深链复原会话，等待中的 Edit 审批卡仍在、可继续裁决。
- **列表分诊**：mtime 全局排序 + 组内窗口化 + 「查看更多」；等待审批的行带红点 + 「等待审批」文案，标签页标题 `(N) AnyPlane` 计数。AI 标题照常工作（「笔记索引工具」「testReport.ts 报告工具」「bun test 全量结果（跳过 smoke.test.ts）」）。
- **审批卡**（PR #76）：Write 展示完整文件内容、Edit 展示「旧 / 新」两段，不再是 JSON 直出。「本会话允许」端到端成立：放行后同类请求零打扰，转录里每次自动裁决留一行「规则自动放行：Bash …（本会话允许）」，服务端日志同形。
- **Codex→Claude 接力**：接力链横幅两端可互跳（手机视口实测），接力 Claude 自动验证简报（git log / Glob / 读文件）后开工，简报质量足够驱动下一步工作。
- **/rename（Codex，手机视口）**：一发成功，顶栏与列表同步，不烧轮次。
- **/goal（Codex）**：达成后芯片消失 + 系统行「目标达成。本次目标累计消耗 3532 tokens」——第二轮问题 8 已修。
- **后台任务全链路**（第二轮问题 11 已修）：顶栏「1 个后台任务运行中」+ 侧栏面板自动展开带「停止任务」按钮；停止实测生效（`task_finished status=stopped`）；主线在任务跑的时候可正常对话。
- **/compact（Codex，651k tok 上下文）**：分隔线 + 「已压缩上下文 · 查看摘要」折叠行渲染，压缩开销（~25k tok）在页脚可见。
- **/review（Codex）**：输出 [P2] 级别标签 + 文件行号，找出了真实 bug（自链接过滤死代码），渲染可读。
- **插队语义**：steer 消息在下一轮边界被模型读到（「行数固定 10 行」被遵守）。
- **双标签页同步**：标签 3 发消息，标签 2 实时同步。
- **AskUserQuestion 卡**：多选/单选/提交全链路可用，模型按答案施工。

## 问题

按「资深用户会不会因此放弃远程接着干」排序。编号是本轮的，不接前三轮。

### 1. 悬浮输入区整条吞点击：审批按钮看得见、点不中（★ 本轮头号）

Claude A 的 Write 审批卡连点两次（本会话允许 / ✓ 允许），服务端都没收到裁决（日志无迁移，API 恒 `waiting`）；同一会话用 JS `.click()` 就能通。实测定量：

- 悬浮输入区遮罩条是 `absolute inset-x-0 bottom-0 z-30` 的**全宽横带**，桌面 900px 视口下高 129px。审批卡按钮滚到视口底缘时，`elementFromPoint` 命中遮罩条而非按钮（`hitIsBtn: false`）。
- 连遮罩条的**透明边区**（max-w-3xl 之外的左右空白）也吞点击（`edgeIsStrip: true`）——那里看起来什么都没有，点了就吞。
- 手机视口（390×844）更严重：审批按钮条几何上在视口内（y=760–796 / vh 844），命中的是**输入框 textarea**——点「✓ 允许」等于聚焦输入框弹键盘。
- 缓解只有「回到底部」按钮（点后按钮回到 y=450 可点）。进有 pending 审批的会话时，滚动定位没把审批卡送离悬浮区。
- 同一形态的受害者还有 AskUserQuestion 卡（两题+选项总高超视口，提交按钮进覆盖带）。

**背景：** 抄本末尾有 `pb-[300px]` 避让，所以「正好滚到底」时审批卡是安全的；问题是所有「没到底」的中间态（进会话的初始定位、向上翻读后新审批到达）。遮罩条本身横跨全宽且无不穿透设置。

**推荐：** 遮罩条 `pointer-events: none`，实际输入卡片、插队/排队条、回到底部钮各自 `pointer-events: auto`——一行 CSS 修掉整类问题。中期把 pending 审批卡从抄本流里拿出来，固定吸附在输入区上方（官方权限对话框就是模态的）；进会话若有 pending 审批，初始定位直接对准它。

### 2. 中断之后，审批卡变僵尸：还能点，点了静默吞

接力会话在「等待 Edit 审批」时被中断。服务端连走 requires_action→running→idle，pending 审批已死；界面仍把卡留成「等待你的裁决」，点「✓ 允许」无任何效果也无反馈（服务端无日志）。转录里 Edit 工具卡标了 ✗ + 「[Request interrupted by user for tool use]」，但审批卡不知道这件事。

同一疑似机制：Codex B 上第一次「本会话允许」点击后同类审批仍反复重问（后来重点一次就生效并自动放行了）——疑似点击落在已被替换的旧卡上，裁决发往死 requestId，`resolveApproval` 返回 false，放行集没写入。

**背景：** `resolveApproval`（lifecycle.ts:75）对不在 pending 的 requestId 静默返回 false；卡片撤下依赖 `approval_resolved` 广播（幂等清理信号）与 status reconcile，中断路径没有触发针对该 requestId 的清理。

**推荐：** 中断/转 idle 且服务端无此 pending 时，审批卡撤下或置灰（转录里的工具卡已经有 ✗ 终态，审批卡跟上同一信号即可）。`resolveApproval` 返回 false 时在客户端给个一次性提示（「该请求已失效」），顺手把卡撤了——这也覆盖多设备同时裁决的竞态。

### 3. 列表还是「最近活动」序，不是「需要我」序

三条会话并发时实锤：我自己那条会话（正在输出）排在列表最顶，两条「等待审批」排在下面。mtime 排序让「正在输出」压过「在等你」——与 Codex `codex agents` 仪表盘的 Need input / Working / Ready 三态正好相反。等待审批虽然有红点，但滚出视口就等于没有。

连带观察：
- 后台任务运行中、主线已空闲的会话，列表行只显示「空闲」——「在后台干活」列表层不可见。
- Claude 会话被空闲回收后行显「离线」，Codex 会话恒「空闲」（单 app-server 托管全部线程）——两家存活语义在列表层不一致，其实两者「现在发消息都能接上」。
- 回收后再进会话，顶栏文案分叉：hub 还在的显示「配置已保存（发送消息时启动 CLI）」，hub 已 evict 的显示「外部会话 · 实时跟踪中」——同一履历两种身份，后者还暗示「这不是你的会话」（第一轮问题 2 的文案保留条件在回收路径上漏了）。

**背景：** 列表行状态来自 `/api/sessions` 的 `status`（busy/waiting/offline）+ live/managed 字段；排序就是 mtime。「后台任务计数」在 `managed.activeTaskCount` 里已有，没进列表行。回收后的身份文案取决于 attach 时 Hub 是否还持有 spawnOpts。

**推荐：** 组内排序键改为 `waiting(desc) → busy(desc) → mtime(desc)`——不动组间结构，等待审批的行永远浮在组首。行状态加一档「N 个后台任务」（activeTaskCount>0 时优先于「空闲」）。「离线/空闲」对用户都是「可继续」，建议统一显「离线」只有一种：真 tail 外部会话才说「外部会话」，回收的管理会话一律「已回收，发消息即重启」。

### 4. 「本会话允许」跨回收的存活是掷硬币（实测两次回收两种结果）

Claude C 第一次空闲回收后重生，Write 直接自动放行（放行集活着）；第二次回收后重生，Bash 又重新问。Claude A 同构复现（life 2 放行 Bash 自动过，life 3 重问）。tooltip 承诺「重开会话失效」，但行为不确定。

**背景：** `onExit` 清 `sessionAllowTools`（callbacks.ts:173，注释明言「重开会话失效」）；dispose→emitExit 有 `exitEmitted` 一次性守卫（processManager.ts:580），`ensure` 包装器还有 stale 吞咽（837 行「防止旧进程退出事件污染已重生的新会话」）。两边一夹，旧进程的 onExit 丢没丢决定放行集活不活。Codex 侧机制本身验证是通的（%TEMP% 探针任务审批自动放行，日志 `[approval] x|01a0e2f3 本会话放行 Bash`）。

**推荐：** 二选一，别停在中间：①语义改为「Hub 存活期内有效」，清理挪到 dispose 同步路径不依赖 onExit 送达，tooltip 改「本会话期间（含自动重启）」；②维持「进程死即失效」，那把清理放进 dispose 里同步执行（现在依赖 onExit 回调送达，Windows 上进程树强杀时不可靠）。①更符合远程盯盘的心智——我放行的是「这条会话行」，不是某个 pid。

### 5. Codex 工具卡标题不可扫：一串「Bash cwd: …」复读

Codex B 跑修复任务时，转录是一长串完全相同的「Bash cwd: D:\Coder\Agents\…」折叠卡（10+ 张）。Claude 侧 Bash 卡有描述句（「提交前再跑一遍全量测试」），Codex 侧标题只有 cwd。手机上想扫「它现在在干嘛」只能逐张展开。审批卡里也一样：PowerShell 嵌套转义（`\\\"…\\\\…\\\"`）三层时基本不可读（第三轮问题 16 复发确认；本轮带路径守卫的删除脚本算可读性最好的，也得展开才看得清）。

**推荐：** Codex Bash 卡标题用命令首行兜底：剥掉 `pwsh.exe -Command` 包装、unescape 一层、截 60 字符。审批卡正文同样处理；有 `reason` 时突出 `reason`（第三轮已推荐，未做）。

### 6. 插队是两步操作，而忙时界面上没有可点的发送键

busy 时发送按钮换成红色「中断」；「插队 / 排队」只是 radio（选中态），选完必须按 **Enter** 才真正发出。我（扮演资深用户）第一次点完「插队」就以为发出去了，消息在输入框里躺了一分钟——直到会话变空闲、按钮消失才发现。手机上软键盘回车更隐蔽。解释文案（「打断当前并立即处理」/「追加进当前轮」）读起来像动作而非模式。

**推荐：** 选中插队/排队且输入框有文本时，中断键旁补一个发送键（或点「插队」直接发）。至少把解释文案改成「选中后回车发送」。

### 7. 回收站与详情抽屉：能开，认不出，关不掉

- 回收站行只显示裸 session id 前缀（`11d00215`）+ 压扁路径，无标题无摘要，认不出哪条是哪条。
- Codex 详情抽屉内容只有 MCP 裸 JSON（`{"data": [], "nextCursor": null}`）直出——「无 MCP 服务器」该是人话；上下文用量数字（`state.context` 现成的）没放进去（第三轮问题 9 的推荐未做）。抽屉在手机上不是底部抽屉而是顶部小卡，**Escape 关不掉**（只能 ✕）。
- 通知菜单在列表→回收站导航后不自动收，一直浮着；「页内通知」开关在浏览器权限弹窗挂起/被拒时无任何反馈（自动化环境实测 `requestPermission()` 挂起后开关静止在「关」，无提示；真实浏览器有弹窗，但被拒场景同样静默）。

**推荐：** 回收站行补上标题/首条消息预览（与列表行同口径的 extractMeta）；详情抽屉空态写「未配置 MCP 服务器」+ 用量数字；所有浮层统一 Escape 与路由变化即关；权限被拒时给一句「浏览器拒绝了通知权限，请到地址栏站点设置开启」。

### 8. 审批语义对「越出工作目录」无感

Codex B 擅自把隔壁主目录的 `node_modules/playwright-core`（12.8MB）复制进 worktree（跨目录写，无任何额外审批——Bash 已本会话放行）；接力 Claude 把 wt-index 分支快进合并了 master（同样只说一声）。worktree 隔离是并行流的根基，「agent 从隔壁拷依赖」「顺手合并分支」在真实多 worktree 场景会悄悄污染环境。这首先是模型行为，但审批卡没有任何「这次操作越出了 cwd」的提示，审批规则引擎也没提供 cwd 外路径的匹配抓手。

**推荐：** `summarizeInput` 里检测 cwd 外绝对路径（Windows 盘符 + POSIX 根都要），审批卡加一行「⚠ 此操作触及工作目录之外：D:\…」。规则引擎后续可加 `outsideCwd: true` 匹配维度。本轮不建议自动拦——看得见是第一步。

### 9. Codex 0.155.1 三种新 ThreadItem 走「留痕后跳过」，live 与历史仍不同形

服务端日志实锤：`contextCompaction`、`enteredReviewMode`、`exitedReviewMode` 均「未识别 ThreadItem 类型，已跳过」。compact 摘要气泡实际由 rollout 尾扫兜底渲染（PR #81 路径），live item 被跳过——补丁层在工作，但 AGENTS.md 的「live 与历史必须同形」在漂移面前是靠补救兜住的。/review 全程可用，但「进入/退出 review 模式」主线无痕，转录里看不出哪段是 review 模式产出。另有 `items/list 出现 turns/list 之外的 turnId，按末段追加`（review turn 的水合走了兜底分支）。

**推荐：** 三种 itemType 各给一个最小渲染（compact 已有气泡，接上 live 路径即可；review 进出渲染成一条系统行「进入审查模式 / 审查完成」）。`docs/drift.md` 按版本标注。这属于上游漂移跟进，不算设计缺陷。

### 10. 并发工作流的三个「没有入口」

对照官方资深玩法，AnyPlane 目前没有：

- **worktree 创建入口**：`claude --worktree` 已是官方能力；本轮三个目录是我手工 `git worktree add` 的。新会话对话框只有目录树（还把 `$RECYCLE.BIN`、`Config.Msi` 这类系统目录平铺出来），没有「从当前目录拉一个 worktree 开会话」。
- **累计 diff 视图**：三条会话干完活，「验收」只能回终端敲 `git status`/`git diff`。Codex 桌面app有 diff 视图；远程场景（手机上验收）更需要「这条会话改了哪些文件」的一屏汇总。
- **`@` 文件补全**：第三轮已记，本轮复核仍无 mention 入口。

**推荐：** 这轮都不做也合理；要做的话优先级是 diff 汇总 > worktree 入口 > @ 补全。diff 汇总不需要渲染 diff——会话尾部一个「本次会话改动的文件清单 + git status 摘要」就覆盖了验收动线的 80%。worktree 入口的补测见下节专项。

---

## worktree 生命周期专项（T+90 追加，应要求补测）

背景：上一轮我自己开终端 `git worktree add` 建了并行目录——但更广泛的用户不该被迫离开产品去碰 git。专项回答两件事：①worktree 生命周期（建/认/删）在 AnyPlane 里今天是什么样；②worktree 会话条目与主目录条目要不要合并展示。

### 实测结论

**今天已有的（比预想多）：**

- **服务端只读探测是通的，两种布局都认**：`readGitInfo`（fsbrowse.ts）从 `.git` gitdir 指针反推主仓库根，普通 `git worktree add` 与官方 `claude --worktree`（落在 `<repo>/.claude/worktrees/<name>`）都正确产出 `worktreeOf` + `gitBranch`，Claude/Codex 行都带。
- **官方 `--worktree` 会话可被 AnyPlane 完整接管**：在终端跑 `claude --worktree ap-wtprobe -p "…"` 后，列表里出现该会话（cwd 为 worktree 路径），从 AnyPlane 点进去发消息正常 `--resume` 续跑，实测其 cwd/分支正确（`worktree-ap-wtprobe`）。
- **已删 worktree 上发消息有干净的报错**：`spawn 失败: 项目目录不存在: …` 以红字内联在转录里。

**缺口（按严重度）：**

1. **生命周期完全在产品外**：建（`git worktree add` / `claude --worktree`）与删（`git worktree remove`）都要离开 AnyPlane 开终端。唯一的产品内痕迹是组头那枚 `wt·<主目录>` 徽章。
2. **看着的进程锁会顶住官方清理流程**（Windows 实锤）：`git worktree remove --force ap-wtprobe` 删掉 git 注册但删目录 `Permission denied` / `Device or resource busy`——因为 AnyPlane 里该会话的 claude 进程还活着（cwd 句柄锁）。detach 后等满 5 分钟空闲回收（`detachRecycleMs`），进程 dispose 后才 `rm -rf` 成功。**谁先谁后成了运气问题**：用户结束工作立刻 `git worktree remove` 必撞锁。AnyPlane 自管生命周期的话，「移除 worktree」动作可以先 dispose 进程再删目录，顺序天然正确。
3. **删了之后徽章信息永久丢失**：`worktreeOf` 是实时读盘推导的，目录一没，`gitBranch`/`worktreeOf` 双双归零——列表里这条会话退化成一个裸 `ap-wtprobe` 组，没有任何痕迹表明它曾是沙盒的 worktree（列表里已有的 `l1-worktree-badge` 组就是这个形态：无徽章、无分支、组名不知所云）。且输入框照常可用，用户要到发消息那刻才吃到「目录不存在」；乐观气泡先进转录视图（不落盘），刷新即消失。
4. **展示合并的反面证据与正面理由同时成立**：实测三个目录在列表里是三个独立组，按组内最新 mtime 互相穿插——`ap-wtprobe` 组排第二、`anyplane-e2e-sandbox` 主组排第四、两个 `wt-*` 组排第五六，彼此不相邻。更糟的是**窄侧栏下组名被徽章+分支挤没了**：组头实际渲染成「1 ｜ [wt·anyplane-e2e-sandbox] ｜ wt-repo…」，worktree 自己的目录名（`anyplane-e2e-sandbox-wt-reporter`）一个字符都没剩下，只能从分支名猜。合并展示（主组下嵌 worktree 子节）能解决挤占与不相邻，但要注意别把「回收站式的旧 worktree 会话」也拖进主组——已删 worktree 的行只该留一个墓碑态入口。

**推荐（增量、不动现有分组键的替代品）：**

- 分组键从 `cwd` 改为 `worktreeOf ?? cwd`：worktree 会话落进主仓库组，组内按「主目录条目 → 各 worktree 子节（分支名+目录名小标题）」排。`worktreeOf` 已在每行数据里，纯前端改动。
- 组头徽章让位：窄栏下先保组名，徽章退成 title 提示。
- worktree 组头/行菜单里加「在终端之外能做的事」：第一期只需「移除 worktree（先 dispose 会话进程，再 `git worktree remove`）」一个动作——这是唯一被实测卡住的环节（锁）。
- 已删目录的会话行标「目录已不存在」墓碑态（列表接口 stat 一下 cwd 即可），点进去禁用输入框并给「放入回收站」快捷动作；乐观气泡在这种会话上不该出现。
- `worktreeOf` 在首次发现时落一行到 `~/.anyplane/` 侧车（或 sessions 元数据），目录删了也能维持「它属于谁」。

### 专项实测流水

| 步骤 | 结果 |
|---|---|
| 终端 `claude --worktree ap-wtprobe -p "…"` | 官方流程建出 `.claude/worktrees/ap-wtprobe`（分支 `worktree-ap-wtprobe`，locked） |
| AnyPlane 列表 | 出现 `ap-wtprobe` 独立组，`wt·anyplane-e2e-sandbox` 徽章 + 分支名正确 |
| 从 AnyPlane 点进去发消息 | `--resume` 续跑成功，模型自报 cwd/分支正确，AI 标题落为「当前 cwd 和 git 分支」 |
| `git worktree unlock` + `remove --force` | git 注册删除成功；目录删除 `Permission denied`（AnyPlane 里的会话进程持有 cwd 句柄） |
| detach（clients=0）后等 5 分钟 | 空闲回收 dispose pid=14492，`rm -rf` 随即成功 |
| 删除后 `/api/sessions` | 该行 `gitBranch`/`worktreeOf` 均归零，退化为裸组 |
| 已删 worktree 会话里发消息（l1-worktree-badge） | 内联红字「⚠ 项目目录不存在：…」，输入框仍可继续输入，乐观气泡不落盘 |

## 仍没覆盖

- 推送订阅全链路、锁屏按钮、一键审批 GET 确认页（「页内通知」开关在自动化 Chrome 里挂起，无法继续；webhook 未配置）。
- 接力链彻底断开（一端进回收站/删除后再点链）的容错；本轮只验证了回收后的链导航正常。
- `/rewind` 本轮未动（前三轮已覆盖）；文件检查点在并发三会话下的交叉干扰未测。
- Codex 子代理（多 agent fan-out）在侧栏的呈现（本轮 Codex 任务没触发子代理）。
- 真手机（触屏+软键盘）与 PWA 形态；本轮手机视口是桌面 Chrome 仿真。

## 附录

### 实测流水（随测随写，编号为当时顺序）

<details>
<summary>T+0 ~ T+8：三条会话起跑（1–13 条）</summary>

1. **新会话对话框**：目录树把 `$RECYCLE.BIN`、`360RecycleBin`、`Config.Msi` 这类系统/隐藏目录全部平铺列出；手动输入路径可用但藏在折叠里。「最近」分组只记最近点过的目录。worktree 目录第一次只能手输。
2. **MCP fill 不进 React 输入框**（工具假象，非产品问题）：fill 工具写入 textarea 后「发送」仍 disabled，需真实键盘事件。副发现：输入框 Enter=发送，多行文本逐行 Enter 会把任务拆成多条消息——Claude A 的首条消息只剩第一行，模型第一轮礼貌回了「消息看起来被截断了」，随后排队的 4 行补齐需求，第二轮正常开工。**真实用户粘贴多行不受影响，但「Enter 即发送」没有 UI 提示**。
3. **rekey 生效**（PR #75 验证）：Claude A 首条消息后 `n|`→`s|`；Codex B `xn|`→`x|01a0e2f3`。
4. **AI 标题**：Claude A 拿到「笔记索引工具」（截断的首条消息没妨碍标题质量）。
5. **列表分诊三态同时在线**：`(2) AnyPlane` 标签页标题未读计数；Codex B「13s 工作中」、Claude A「3m 等待审批」同屏可见；worktree 分组头显示「wt·anyplane-e2e-sandbox wt-index」徽章。
6. **审批卡已是格式化正文**（PR #76 验证）：Write 审批展示完整文件内容；按钮三枚「✓ 允许 / 本会话允许 / ✗ 拒绝」。
7. **Codex B 撞见 msys2 沙箱崩溃**（环境实录）：`rg --files | head -100` 的 `head.exe` 报 `CreateFileMapping Win32 error 5`——codex 0.155.1 Windows restricted token 杀 msys2 的已知上游问题（openai/codex#12000）。Codex 自己改用纯 rg 绕开。
8. **Codex B 越出 cwd 检索**：连续对 `D:\Coder\Agents\anyplane`（父项目）发了 4 次 `rg`——模型行为，但只读 Bash 在 default 档下不审批，模型可以随意读 cwd 之外的本机文件。
9. **排队语义文案分厂商**：Claude「当前轮结束后自动开始」、Codex「追加进当前轮」——正确反映了两个 queue 的不同语义。
10. **分诊排序缺陷**（见问题 3）。
11. **悬浮输入区吞点击**（见问题 1）。
12. **Codex 会话顶栏仍只显示裸目录路径**（无 AI 标题时）：列表行用 `lastPrompt` 兜底（「这是一个 bun 项目（…」），会话内顶栏却是全路径——同一条会话两种身份。
13. **Codex 审批卡 PowerShell 嵌套转义不可读**（见问题 5）。

</details>

<details>
<summary>T+15 ~ T+40：三会话分诊、接力、手机视口（14–27 条）</summary>

14. **「本会话允许」端到端成立**：放行后 Write×3 零打扰；转录留痕「规则自动放行：Bash …（本会话允许）」。
15. **Claude A 完成**（12+3 用例全绿，提交 0e056be）。空闲后被回收（`空闲回收 → dispose`），列表留痕可回。
16. **工作中刷新页面**：深链复原会话，等待中的 Edit 审批卡仍在，裁决可继续——重连补放正常。
17. **Codex B 完成**。正确指出 smoke 用例沙盒限制；但擅自跨目录复制 node_modules（见问题 8）。
18. **Codex → Claude 接力成功**（见「已经成立」）。
19. **手机视口**：布局切换正常；`/re` 过滤 `/rewind` `/review` `/rename`；`/rename` 一发成功。
20. **手机视口实锤吞点击**（见问题 1）。
21. **中断后的僵尸审批卡**（见问题 2）。
22. **Codex 0.155.1 三种新 ThreadItem 被跳过**（见问题 9）。
23. **/compact on Codex**（651k tok，6s）：分隔线+摘要折叠行正常；摘要里混入上游 wrapper 话术（"Another language model started to solve this problem…"），应剥掉只留 `# Handoff Summary` 起的内容。压缩烧 ~25k tok 页脚可见。
24. **Codex 详情抽屉**（见问题 7）。
25. **双标签页同步正常**。
26. **Codex 工具卡标题不可扫**（见问题 5）。
27. **/review 输出可读**，找出真实 bug；接力会话中断后接受重定向并完成（23 pass / 0 fail 全量跳过 smoke）。

</details>

<details>
<summary>T+40 ~ T+90：目标、回收站、后台任务、插队、AskUserQuestion、停止任务（28–37 条）</summary>

28. **「本会话允许」跨回收不确定性**（见问题 4）。
29. **/goal 达成清芯片**（见「已经成立」）。
30. **回收站裸 id + 通知菜单不收**（见问题 7）。
31. **后台任务全链路成立**（见「已经成立」）。
32. **后台任务运行中列表显「空闲」**（见问题 3）。
33. **插队是两步操作**（见问题 6）。
34. **插队语义生效**：「行数固定 10 行」被遵守。
35. **本会话允许 · Codex 侧复核**：机制通的（探针任务自动放行），早先一次未生效指向僵尸卡竞态（见问题 2）。
36. **AskUserQuestion 卡全链路可用**；原始 JSON 工具卡与结构卡重复、提交按钮进覆盖带（见问题 1 与「卡片去重」建议）。
37. **停止任务链路通**，但转录文案「后台任务完成」不区分「跑完 / 被我停了」。

</details>

### 沙盒最终状态

- 主目录（Claude A）：`3824541` frontmatter 支持、`0e056be` 笔记索引工具，两个 commit 落在 master。
- wt-index（Codex B + 接力 Claude）：fixture 生成器 + CSV 生成器 + 集成测试未提交；wt-index 分支被接力会话快进合并过 master（带来 notesIndex 三文件）；README/package.json 有改动。
- wt-reporter（Claude C）：拆分重构未提交；`cd965c6` 单独提交了 bun.lock。
- 三条主线任务的 token 开销：Claude A ↑19.8k·cache 317k；Codex B ↑4.2M·cache 4.1M（deepseek-flash 高频 shell 往返）；Claude C ↑20.2k·cache 414k。
- anyplane 服务端（pid 40956，端口 7480）走查结束时仍在运行。

### 对照参考

- [Claude Code power user tips（官方）](https://support.claude.com/en/articles/14554000-claude-code-power-user-tips)：「最大的生产力解锁是 3–5 个并行会话，各占一个 worktree」。
- [Run parallel sessions with worktrees（官方文档）](https://code.claude.com/docs/en/worktrees)：`claude --worktree`、`.worktreeinclude`。
- [Codex Agents Dashboard 教程（habr）](https://habr.com/post/1073214/)：`codex agents` 的 Need input / Working / Ready 三态、`codex queue --thread`、`/rename` 命名纪律。
- [Codex multi-agent 配置（Firecrawl）](https://www.firecrawl.dev/blog/codex-multi-agent-orchestration)：`max_threads`/`max_depth`。
- [Karpathy 式并行流（aibuilderclub）](https://www.aibuilderclub.com/blog/karpathy-parallel-agents-workflow)：给成功标准不给步骤，人当技术主管。
