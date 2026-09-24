# 资深用户走查：AnyPlane 体验问题（2026-09-22）

> 一次成文的产品走查。对照的是 Claude Code / Codex CLI 里已经形成肌肉记忆的日常，不是「再做一个 TUI」。
> 事实以当天生产界面实测为准。每条下面的「背景」说明代码为什么是现在这样，「推荐」是在现有结构上最小的改法，不是排期。

## 范围

- 界面：已构建的生产前端（桌面 1440×900，以及 390×844 的手机视口）。没有改 `anyplane` 仓库里的代码，也没有在本仓库目录里开会话。
- 会话：在仓库外的临时目录各开了一条 Claude 与一条 Codex。第一轮是只读、改文件审批、`/status`、`/rewind`。第二轮在同一条上继续：Codex 的 `/context`、`/rename`、`/goal`、`/branch`、`/btw`；Claude 的详情抽屉、plan 模式、后台 shell、`/btw`。
- 基线：Claude Code 命令与权限文档（`/plan`、`/permissions`、`/rewind`、`/compact`、`/context`、`/btw`、技能与 MCP），以及 Codex CLI 的 `/permissions`、`/plan`、`/compact`、`/review`。AnyPlane 自己的斜杠审计见 [../audits/2026-08-slash-commands.md](../audits/2026-08-slash-commands.md)。

当天列表接口返回 **187** 条会话。下面的问题都是在这个真实列表上碰到的，不是空账号首启。

## 已经成立的部分

这些路径当天是通的，走查不是为了否定它们：

- 懒启动文案清楚（「浏览中（发送消息时启动 CLI）」），首条消息后 CLI 才起来。
- 流式回复、折叠的思考、工具卡（Read / Edit）和轮次页脚（耗时、token）可读。
- 默认权限下，Edit 会停住等裁决；点「允许」后，临时目录里的文件确实多了一行。
- 工作中可以选「插队 / 排队」，并有一行解释。
- 输入区胶囊能改 mode / model / effort。当天 Claude 显示 `kimi-for-coding[1m]`，Codex 显示 `deepseek-flash` 与「工作区」。
- Claude 的 AI 标题写进了列表（「README.md 目录用途」）。`/rewind` 能按用户消息列出检查点，并给出「仅回滚文件 / 仅回滚对话 / 回滚对话+文件」。
- Claude 的 `/btw` 当天是通的：气泡标了「侧问 / 不进历史」，回答没有再占主线那一轮的 token 页脚。
- `/status` 没有烧一个模型 turn，而是立刻回了 `isn't available in this environment.`（0 tok）。
- 用列表里的真实 `s|` key 打开时，手机布局有返回、标题和输入区，主路径能读。

## 问题

按「资深用户会不会因此放弃远程接着干」排序。编号不是路线图方向号。

### 1. 列表完成不了「找到那个正在等我的会话」

产品卖点是人离开之后，需要裁决时还能接上。当天的列表做不到这件事。

- **没有搜索、筛选、置顶。** 187 条只能靠滚动。行菜单只有「重命名」和「回收站」。
- **排序不是「最近活动」，也不是「需要我」。** `/api/sessions` 先拼全部 Codex 行，再拼全部 Claude 行（`server/src/routes/sessions.ts` 返回 `[...codexRows, ...claudeRows]`）。分组按这个顺序第一次出现的目录展开。结果是：侧栏第一屏全是旧的 Codex 探针，刚建的 Claude 会话在视口之外（实测行顶距视口顶部约 2400px）。
- **等待审批不会浮上来。** 侧栏那一行的状态已经是「等待审批」，但人在桌面首屏看不见它。聊天顶栏同时仍写「请求中…」，和「在等你」不是同一句话。
- **当前会话不会滚进视口。** 桌面双栏里，正在看的那条不在可见列表中，顶栏又还是目录路径（见问题 2），「我在哪条会话里」要靠地址栏。
- **预览是原始转录，不是给人看的摘要。** 多条标题或副标题是 `<command-message>…</command-message>`、`<task-notification>…` 或整段交接简报。Codex 没有标题时，主标题是线程 id 前 8 位（`01a08e4e` 这类）。这和 [../ROADMAP.md](../ROADMAP.md) 方向九一致，这次确认仍然如此：新 Codex 线程的列表项没有 `title`，只有 `lastPrompt`。

**背景：** `/api/sessions` 把两个后端各自按 mtime 排好的数组接成 `[...codexRows, ...claudeRows]`。前端用 Map 插入顺序分组，分组顺序就等于「先遇到的 Codex 目录，再遇到的 Claude 目录」。187 条对扫描成本不是眼下的瓶颈（方向十二的结论是先不优化列表扫描），卡人的是一次全部铺开。副标题来自 `extractMeta`：它只跳过以 `<command-name` 或 `<local-command` 开头的用户消息，`<command-message>` 和 `<task-notification>` 会漏进去。主抄本已经用 `parseUserText` 把这些标签收成斜杠名，列表没走这条。

**推荐：** 服务端合并后按 mtime 排一次再返回，目录内部两种后端自然混在同一时间序里。前端每个目录默认渲染最近 5 条，点「查看更多」再追加 5 条；正在等待审批的行即使落在窗口外也留在分组顶部。当前选中行滚进视口，这件事等问题 2 的 key 对齐之后才点得中。副标题在 `extractMeta` 里丢掉内部标签，与 `parseUserText` 同一口径。这轮不加搜索框，也不把列表改成游标分页。

### 2. 新建会话的地址和列表里的身份不是同一个

Claude 新建后地址一直是 `n|<目录>`，Codex 是 `xn|<目录>`。列表里同一条会话的 key 已经是 `s|<slug>|<sessionId>` 和 `x|<threadId>`。

`web/src/lib/key.ts` 的 `sessionFromKey` 不认识 `n|` / `xn|`。深链还原时，列表里又找不到这个 key，于是地址被清掉，人回到列表。当天把视口改成手机宽度时页面重载，正在看的 Claude 会话就这样丢回了列表；再用列表中的 `s|` key 打开，顶栏变成「外部会话 · 实时跟踪中」。

「外部会话」在代码里指 tail 已有 transcript、而不是本连接 spawn 的进程（`statusLineOf`，`web/src/lib/chatText.ts`）。对刚在这里发出去的会话，这句读起来像「这不是我的会话，而且还在跟踪」。空闲时也没有回到「CLI 空闲」。

同一条链路还有一个可见后果：**打开中的顶栏标题不会跟上后来写上的名字。** `App` 里的 `selected` 在点进去时定格。列表轮询能把 Claude 标题更新成「README.md 目录用途」，顶栏仍显示目录路径。从列表用 `s|` key 重新进入后，标题才是对的。第二轮在 Codex 上 `/rename 体验探针`：列表标题变成了「体验探针」，这条还开着的会话顶栏仍是目录路径。

资深用户会刷新、会从通知点回来、会在列表和会话之间切。这三条今天都不把人送回刚才那条活会话。

**背景：** `n|` / `xn|` 是懒启动键，attach 只握手，首条消息才 spawn。`/clear` 会三层重键并广播 `moved`，所以清会话能跳到新 key。普通首条消息拿到 sessionId 或 threadId 之后没有走这条重键，Hub 继续叫 `n|`，磁盘上的转录被发现成 `s|`。`sessionFromKey` 不认识 `n|` / `xn|`，深链对不上就清掉 hash。顶栏标题读的是点进去时那份 `SessionInfo`；列表标题来自下一轮 discovery（custom-title、ai-title、首条消息）。两边 key 不同，列表刷新写不回这份快照。Codex 接力已经有 `xn|`→`x|` 的 rekey，普通新线程没有复用。人从列表打开 `s|` 时，活进程仍挂在 `n|` 上，这条连接只 tail 文件，状态走 `tailing` 分支，文案是「外部会话」。

**推荐：** 首个 init 或 thread id 出现时，复用现有 rekey 和 `moved`，用 reason 区分「绑定真实 id」和「/clear」。刷新、通知、从列表点进来都落在同一个 `s|` / `x|` 上。同 key 的列表轮询把 title 写回当前选中项，顶栏就跟上 AI 标题和 `/rename`。活会话不再走 tail，状态会显示 CLI 空闲。文案「外部会话」留给真正由本机 TUI 打开、AnyPlane 只在跟踪的那条，这轮不必先改词。

### 3. 审批卡不是 diff，也记不住裁决

Claude Code 的权限对话框是「看 diff → 允许一次 / 本项目不再问 / 拒绝」。当天的 Edit 审批是一块浅红色面板，正文是 `JSON.stringify` 后的参数：

```json
{
  "file_path": "…/README.md",
  "old_string": "- keep this file",
  "new_string": "- keep this file\n- explored",
  "replace_all": false
}
```

换行显示成字面量 `\n`。按钮只有「允许」和「拒绝」，没有「编辑类本会话放行」，也没有从这次裁决生成一条审批规则。规则引擎本身在配置文件里，界面进不去。`/permissions` 在 headless 里属于打不开的 TUI 命令（斜杠审计里的 B 类），面板却照样列出来。

工具卡展开时，`toolDetail` 会把 Edit 收成「旧 / 新」两段纯文本（`web/src/lib/blocks.ts`），仍然不是并排 diff，而且默认折叠。审批卡没有复用这段格式。手机上要裁决一次改动，看到的是 JSON。

等待期间顶栏状态是「请求中…」，不是「等待审批」。人会以为模型还在想。

**背景：** 审批卡对所有工具共用 `JSON.stringify`，Edit 的换行因此变成字面量 `\n`。同文件的 `toolDetail` 已经把 Edit 收成「旧 / 新」两段，审批卡没有调用它。`ApprovalDecision` 只有 allow / deny。审批规则在启动时从配置读入，坏规则会让进程起不来，不适合从锁屏上的一次点击写进配置文件。顶栏「请求中」是因为 `statusLineOf` 让 `phase` 压过 `waiting`；审批卡出现时 phase 往往还是 `requesting`。

**推荐：** 审批正文改走 `toolDetail`。增加「本会话允许这个工具」：只记在这个 Hub 的内存里，裁决仍广播 `approval_auto`，不改配置文件。`waiting` 为真时状态文案用「等待审批」；`compacting` 继续优先于审批。

### 4. 斜杠面板把做得到和做不到混在一起

输入 `/` 时，自有命令（中文描述）在上面，下面是 CLI initialize 握手带回的清单。当天是 **53** 条，描述几乎全是英文。

实测 `/status` 立刻返回不可用。审计里同一类的还有 `/permissions`、`/plan`、`/mcp`、`/diff`、`/skills`、`/help`：资深用户每天用它们换权限、进计划模式、看改动、管 MCP。面板不区分「这里能执行」和「headless 会拒绝」。人要试过才知道。

计划模式并不是完全没有：胶囊里有 `plan`。但肌肉记忆是敲 `/plan` 再写任务，不是先打开胶囊。Codex 的 `/plan`（协作模式）审计里写明未接；`/permissions` 的预设切换，Codex 侧胶囊有「只读 / 工作区 / 免审 / 全开」，斜杠本身仍会进模型或无对应拦截（拦截表里没有 `/plan`、`/permissions`）。

**背景：** 面板是自有命令加上 CLI `initialize` 带回的全量清单。斜杠审计把 headless 里打不开的 TUI 命令标成 B 类，`mergeSlashCommands` 没有用这张表。`/status` 会立刻说不可用，其余 B 类要人逐个试。C 类是技能，本来就会发一轮模型调用，透传是对的。

**推荐：** 合并清单时去掉还没接管的 B 类，C 类留下。Claude 的 `/plan` 拦截成「把权限模式设为 plan」，后面的文字作为下一条用户消息。`/permissions` 拦截成系统提示「在输入区胶囊里改模式」，不要发到模型。Codex 的协作式 `/plan` 与这个权限档不是一回事，这轮不要映射过去。

### 5. 输入区缺少两件每天都在用的事

- **没有 `@` 文件。** 源码里没有 mention。资深用户用 `@` 把文件钉进上下文，而不是让模型自己 Glob。
- **图片只能走文件选择器。** Composer 只处理 `<input type="file">`，没有粘贴处理。截图进对话的习惯是粘贴，不是先存盘。

占位符是 `ᕕ( ◠ڼ◠ )ᕗ`。桌面还能靠胶囊猜能力；手机上模型名被截成 `kimi-for-cod...`，占位符不提示 `/`、图片或审批。

**背景：** 图片进消息的路径已经有了：文件选择器读成 `pendingImages`，随用户消息送出。缺的是剪贴板。`@` 需要一份文件名索引，现有目录接口只返回子目录。

**推荐：** Composer 增加 paste，只接受图片，走现有的 `pendingImages`。`@` 先不做全库模糊搜索。若要补，下一步只列当前工作目录下的文件名，供前缀补全。占位符改成一句能提示 `/` 和图片的短句，颜文字不必留。

### 6. 回滚的两个次要动作看起来像不能点

`/rewind` 面板可用，主按钮「回滚对话+文件」对比足够。旁边的「仅回滚文件」「仅回滚对话」是 `text-muted` 放在 `bg-surface2` 上，叠在已经压暗的遮罩里，当天截图里像禁用。Claude Code 里「只撤文件、对话留着」是常操作，不应该是三个按钮里最难看见的两个。

摘要对反引号不干净：用户原文里的 `` `- explored` `` 在面板里变成了一段断裂的符号。

**背景：** 两个次要按钮是 `text-muted` 放在 `bg-surface2` 上，外层还有一层压暗遮罩，对比度掉到像禁用。摘要函数 `rewindPreview` 已经会去掉命令标签；反引号是用户原文，面板用普通段落换行，长行在反引号处折开。

**推荐：** 次要按钮改成和主按钮同一套字色，只用填充区分主次。摘要继续用纯文本和等宽字体，不为这一行引入 markdown 渲染。

### 7. 折叠的工具卡让错误说法无法当场核对

只读那一轮，模型读完 README 后声称「环境检测出这是 git 仓库」。目录及其父级都不是 git 仓库，界面上也没有分支徽章。结论写在气泡里，Read 的结果是折叠的。要反驳它，得先点开卡片。这不是模型幻觉本身的锅，但远程界面若默认只展示模型的话、不展示它刚读到的原文，人会把幻觉当成环境事实。

**背景：** 工具卡默认收起，是为了长会话还能扫。`ToolCard` 只有流式输出时才默认展开，一轮结束后回到收起。Read 的一行摘要只有路径，正文在折叠区。

**推荐：** 仅「还没被下一条用户消息盖住的那一轮」里的工具卡默认展开。更早的轮次维持收起。不要把历史里所有 Read 都打开。

## 第二轮：上次浅尝和没走到的功能

仍在同一临时目录、同一套生产界面。没有在本仓库开会话，没有推远程。

### 8. `/goal` 会自己再开轮，达成之后芯片还在

在已经结束的 Codex 线程上发送 `/goal 回复中包含 done`。没有新的用户气泡，模型自己又跑了两轮（「收到 done」，然后「done」），上下文从约 10k 涨到约 48.5k。系统行只有一句「已设定目标」。达成之后更多菜单里的目标芯片仍显示这条条件，要再发 `/goal clear` 才清掉，清除本身没有再开一轮。

资深用户设目标是为了让它干到完。这里的缺口是：达成没有产品态（仍像进行中），而且设目标本身就会在无人再输入时烧轮次。

**背景：** Codex 的 `thread/goal/set` 之后，续跑是上游自己的行为，AnyPlane 没有再插一条用户消息。`applyGoal` 只保存 `objective`。协议里的 `ThreadGoalStatus` 含 `complete`，通知里带着，被这个函数丢掉，所以芯片一直像进行中。

**推荐：** 续跑保留，这就是目标。`applyGoal` 认 `status`：`complete` 时清掉芯片，并留一条系统行「目标已达成」。`active` / `blocked` 等仍显示条件。不要在设定时再替用户编一轮提示词。

### 9. Codex 的 `/context` 把人指去一个打不开、也没有明细的详情

`/context` 回了「线程累计：in 9961 / out 2（窗口占用明细请开详情）」。同一行页脚是 `tok ↑10.0k ↓2 · cache 3.7k`，侧问这句没算 cache。新建会话的 key 仍是 `xn|`，`isExistingKey` 不含它，更多菜单里只有复制 id 和「目标」，没有「详情」。即便打开详情，Codex 的 `capabilities.queries` 也只有 `mcp_status`，没有 `get_context_usage`。Claude 那边详情是齐的：System prompt / tools / memory / skills / messages / free space，MCP 行能看到连接状态、工具数、重连和禁用。

`/branch` 在 Codex 上被挡住，文案让人去回滚面板分叉。这和能力声明一致（`branch: false`，文件检查点也没有）。菜单里同样没有「分叉」和「接力」，因为这条会话还没被当成已存在会话。

**背景：** `/context` 的系统行写死了「窗口占用明细请开详情」。Codex 的 `capabilities.queries` 只有 `mcp_status`，没有 `get_context_usage`。详情按钮还要求 `isExistingKey`，新建会话的 `xn|` 不在其中，菜单里就没有详情。用量数字已经在 `state.context` 和页脚里，含 cache。菜单缺项与问题 2 是同一个键。

**推荐：** `/context` 直接引用 `state.context` 和 `usage`（含 cache）。没有 `get_context_usage` 时不要提详情。问题 2 的重键做完后，详情和接力会按现有的 `isExisting` 出现。Codex 的详情里放已经有的 MCP 查询和同一套用量数字，不做 Claude 那种分项分类。`/branch` 继续指向回滚面板，Codex 没有文件检查点，不要做一条假的懒分叉。

### 10. plan 模式能挡住写文件，但没有「计划」可批，模式面板也不收

胶囊切到 `plan` 之后，要求追加一行。模型没有改文件，用正文说明被计划模式挡住、要先退出。没有计划书，也没有 ExitPlanMode 那种批准卡。退出方式是再打开胶囊选回去。

选完模式只收起子列表，面板自己还开着（`StatusPill` 在选中后 `setSub(null)`，不 `setOpen(false)`）。后台任务跑起来之后，这块面板仍然盖在输入区上，和「后台任务」侧栏叠在一起。

**背景：** plan 作为权限档已经能挡住写文件。官方计划书走 ExitPlanMode 或 plan item。AGENTS.md 写明不接 Codex 的 `plan/delta`。面板不关闭是选中回调只收起了子列表。

**推荐：** 选中 mode、model 或 effort 之后关闭整块面板。不接 `plan/delta`，也不做计划编辑器。敲 `/plan` 的习惯由问题 4 的拦截覆盖。

### 11. 后台 shell 被标成已完成时，进程还在跑，停止按钮也不在

让 Claude 执行 `sleep 45 && echo still-going`。模型回复「已在后台启动」之后：

- 侧栏卡片状态是「已完成」，因此没有「停止任务」按钮。
- 同一时刻进程仍在（`sleep 45` 已跑约 30 秒，对应 output 文件仍是空的）。
- 输入区在整个等待期间是「工作中…」，发送按钮换成中断。插队/排队还在，但默认心智是这条会话被占满。
- 约 45 秒后转录里出现「后台任务完成」，模型补了一句输出是 `still-going`。终态通知是有的，中间那段状态是错的。

长命令放后台，正是为了继续说话或随时停掉。现在这两件事在进程还活着的时候都做不到。

**背景：** 后台 bash 的 tool_result 正文是 “Command running in background …”。`settleBucketFromResult` 把任意 tool_result 当成终态，卡片变成「已完成」，停止按钮只在 `running` 时渲染，于是消失。真正结束靠稍后的 `task_notification`。这段等待里 `phase` 仍是 `requesting`，`statusLineOf` 让它压过「N 个后台任务运行中」。输入区变成中断，是因为 CLI 的 session state 仍是 running；排队发送已经接在 busy 分支上。

**推荐：** 正文写明命令还在后台时不要 `markTerminal`，等 `task_notification`。停止按钮会留下来。`activeTaskCount > 0` 时状态文案用「N 个后台任务运行中」，即使 phase 还写着 requesting。输入区在 CLI 报告 running 时继续用现有的中断和排队，不为后台任务再做一种发送。

### 协议里有、界面还没接上的日常能力

下面是对照官方命令和 app-server 方法、这次没有在界面里找到入口的部分。不是要求一次做完。

| 官方习惯 | 现状 |
|---|---|
| Codex `/plan`（协作模式，先出计划再改） | 审计写明未接。Claude 的 plan 只是权限档，见问题 10 |
| Codex `/memories`、`/personality` | `thread/memoryMode/set`、personality 的 settings 没有对应控制 |
| `/skills`、`/hooks`、`/apps`、`/plugins`、`/usage` | 协议有 list/read。Claude 详情只给 skills 的 token 桶，不列名字，也不能开关 |
| `@` 文件、粘贴图片 | 仍没有。图片只有文件选择器 |
| 审批时「本会话/本项目不再问」 | 仍没有。规则只在配置文件 |
| Codex `plan/delta` | AGENTS.md 写明有意不接 |
| 换目录 `/cd`、独立 `command/exec` | 未接 |

**推荐：** 和问题 4、5、10 重合的，按那些问题做。`/memories`、`/personality`、`/apps`、`/plugins`、`/hooks`、`/usage`、`/cd`、`plan/delta` 这轮不做：前几项是账户或清单能力，换目录会拆开现在的会话身份，`plan/delta` 已经明确不接。

## 仍没覆盖

- 推送、锁屏按钮、一键审批 GET 确认页。
- 没有在 `anyplane` 仓库目录里开会话。临时目录上的文件改动没有提交，也没有推远程。
- 界面只有简体中文是 README 已写明的限制。斜杠描述、`/status` 失败文案、胶囊里的 `default(manual)` 仍是英文。
- 手机视口 390×844 下接力链 / 审批卡 / 目标芯片的展示。
- 接力链断开（源会话被回收后再点接力）的容错。

~~推送、锁屏按钮、真正走完的接力、分叉落盘、`/compact` 压缩质量~~ → 2026-09-24 第三轮已覆盖，见下。

---

## 第三轮：补覆盖（2026-09-24）

仍在本地沙盒 `D:\Coder\Agents\anyplane-e2e-sandbox` 实测，桌面 1440×900，桌面 Chrome。本轮把「仍没覆盖」里除推送与 `anyplane` 仓库会话外的项都走了一遍。**没有推送任何内容到远程仓库**，所有文件改动留在本地未 commit。

### 12. `/branch` 在懒启动 `n|` 会话上落盘成双，列表里留死条目

在 `n|<目录>`（懒启动，未 spawn）会话里发 `/branch`：

- URL 跳到 `b|<目录>|<forkSessionId>`。侧栏分组计数从 1 → 2。
- 磁盘 `~/.claude/projects/<slug>/` 出现两个 jsonl：
  - `6c69a82d-…`：fork 时 CLI 写出的孤立 fork（headless `/branch` 的「不切换」产物），从此不再更新。
  - `6737090d-…`：真正的接力主线（fork 后继续写）。
- 手动通过 URL 打开 `s|...|6737090d` 时，顶栏一度是「外部会话 · 实时跟踪中」（tail 分支），直到再发一条消息才回「CLI 空闲」。
- 资深用户看到侧栏两条会以为是「两条并行分支」，实际 `b|` 那条是尸体。

**背景：** 问题 2 的「rekey 缺失」的连带后果。`/branch` 拦下后 AnyPlane 自己做了切换，但没有把「原会话已消失」这件事告诉列表；headless `/branch` 的孤立 fork 文件也没被清理或合并。

**推荐：** `/branch` 完成后广播一次 `moved`，reason 区分「分叉落盘」；同时把孤立的 `b|` 中间产物从列表过滤掉，或在主线上 inline 提示「已分叉到 <新 key>」。

### 13. Claude `/compact` 在 headless 下界面看不到压缩比，也没有分隔线

在上下文 24.3k / 1.0M（2%）时 `/compact`：

- 顶栏「压缩上下文…」持续 38s。
- 聊天气泡出现 `上下文已压缩 ?→?` + `Compacted` + `─ 本轮 38s · 0 tok`。**前后 token 都是 `?`**；页脚累计 token 没涨；「上下文占用 2%（24.3k / 1.0M tok）」按钮数字也没变。
- 磁盘 jsonl 里**没有 `compact_boundary` 条目**。只有一条 `isCompactSummary: true` 的 user 消息（英文 prompt「This session is being continued from a previous conversation…」）。
- 分隔线没出现。原文档「`compact_boundary` 渲染为分隔线」是按交互模式写的；headless 下这条类型根本不写进 jsonl。
- **`isCompactSummary: true` 的英文 prompt 完整渲染在主抄本里，没折叠**。它不在 `<system-reminder>`/isMeta 过滤范围内，把内部摘要 prompt 当成普通用户消息展示了。
- `/rewind` 面板里 compact 之前的用户消息（含 compact summary 那条「（无可显示的用户文本）」）都还能选，没看到「compact 边界之前不能 rewind」的禁用提示。

**推荐：** ① compact summary 识别 `isCompactSummary` 折叠成「已压缩上下文 · 查看摘要」一行；② 「上下文已压缩 ?→?」的前后 token 用同一条 assistant usage 计算；③ 如果 headless 下确实不写 `compact_boundary`，分隔线改用「isCompactSummary 消息出现」作为信号。

### 14. Codex `/compact`：有真实摘要写进 jsonl，但界面什么都没显示

接力过来的 Codex 会话（`x|01a0d297-…`，token 已 ↑3.8M）发 `/compact`：

- 16s 后结束。聊天气泡出现 `上下文已压缩 ?→?` + `─ 本轮 16s · 0 tok`，**没有「Compacted」标签，没有摘要气泡**。
- token 页脚从 ↑3.8M ↓54.2k 涨到 ↑3.9M ↓57.6k——**compact 本身烧了 0.1M token**，但界面一行都没显示这段开销的去向。
- 磁盘 jsonl 里看到一条 `type: "compacted"`，`payload.message` 是**完整的中文交接摘要**（含「现场事实」「已确立的关键决策」「已落地的文件」等小节），质量足够让下一个 agent 接续工作。
- 紧接着在 compact 后发一条「接力摘要里的『现场事实』第一条说的是什么？」，模型正确引用摘要内容回答——证明摘要确实传给了后续调用，**只是前端没展示**。

**推荐：** Codex 的 `compacted` 事件也生成一个折叠的「已压缩上下文 · 查看摘要」气泡，内容取 `payload.message` 前 N 字符。当前接口事件里没有这条，需要在适配器里把 `compacted` 暴露出来。

### 15. Codex 接力后顶部报 `w.messages is not iterable`，之后正常工作

Claude `s|...|6737090d` → 「更多 → ⇄ 接力给 Codex」：

- 接力链 UI 正确：`⇄ 接力链: Claude 16:46 → Codex 16:46`，可互跳。
- URL 自动跳到 `x|01a0d297-…`（接力目标的真实 thread id）——这正是问题 2 推荐的 rekey 行为，**Codex 侧接力已经做到了**，Claude 侧的 `/branch` 和首条消息后没做。
- **Codex 会话页面顶部出现一行 `⚠ 加载历史失败: TypeError: w.messages is not iterable`**。之后 Codex 继续正常工作，但这行报错在界面上留着。
- 疑似 ephemeral fork 刚 spawn 时历史 API 形状未就绪，或 Codex 历史结构与 Claude 不一致时 ingest 没兜底。

**推荐：** 定位 `w.messages is not iterable` 抛出处（大概率在 ingest / 历史水合路径），对「Codex 新线程尚无 messages」做防御；如果接力链目标会话还在 spawn 中，先渲染骨架屏而不是历史接口。

### 16. Codex 审批带中文 `reason` 字段，但 UI 没突出

Codex 接力工作期间，删除 `branch-probe.txt` 的 PowerShell 触发了审批。审批卡正文：

```json
{
  "command": "\"C:\\\\Program Files\\\\PowerShell\\\\7\\\\pwsh.exe\" -Command \"Remove-Item -LiteralPath \\\"...\\\" -Force; Test-Path \\\"...\\\"\"",
  "cwd": "D:\\Coder\\Agents\\anyplane-e2e-sandbox",
  "reason": "清理上个 agent 留下的探针文件 branch-probe.txt（内容为 fork-test-v2），避免混进首次 commit。是否允许在沙盒内删除该文件？"
}
```

- `reason` 是 Codex 给出的中文化解释，比 Claude 侧的纯参数更有信息量。
- 但审批卡只把整段 `JSON.stringify` 展示，`reason` 没单独突出，且 PowerShell 嵌套转义（`\\\"…\\\\…\\\"`）让 command 几乎不可读。
- 顶栏仍是「等待审批」（与 Claude 侧一致，问题 3 复现）。

**推荐：** 审批卡先取 `input.reason`（若有）放在标题下方一行，再把 input 走 `toolDetail` 的格式化；PowerShell 嵌套命令可以只做第一层 unescape 或截断展示。

### 17. 接力目标工作目录与我的笔记目录相同，Codex 把走查笔记当需求写进了 README

接力简报默认目标是「在 <cwd> 继续工作」。我的笔记写在 `<cwd>/notes/`。结果 Codex 接力过来后读到笔记，**主动把走查发现写进 `README.md` 当回归断言**（包括「接力后不得出现 ⚠ 加载历史失败…」等）。

最终落地文件（未 commit，纯本地）：`.gitignore`、`AGENTS.md`、`README.md`、`package.json`、`tsconfig.json`、`scripts/preflight.ts`、`tests/smoke.test.ts`、`tests/support/{env,browser,app}.ts`、`.tmp/commit-msg.txt`。

**推荐：** 接力简报里明确「`<cwd>/notes/` 下的内容是参考笔记，不是当前任务」；或者在简报模板里加一段「工作目录里可能存在测试者留下的笔记文件，请不要把它们当作当前任务输入」。

### 18. Codex 侧栏条目仍只有线程 id 前 8 位，没有 AI 标题

接力出来的 Codex 会话在侧栏显示为 `01a0d297 2s 工作中 …`。AI 标题在 Claude 侧是写进列表的（「README.md 目录用途」那次），Codex 侧一直没出现。

**背景：** 问题 1 末尾已经提过 Codex 新线程没有 `title` 只有 `lastPrompt`。本轮接力场景再确认：接力完成后这条 Codex 线程仍未获得 AI 标题。

## 仍没覆盖（更新）

- 推送、锁屏按钮、一键审批 GET 确认页。
- 在 `D:\Coder\Agents\anyplane` 仓库目录里开会话。
- 手机视口 390×844 下接力链 / 审批卡 / 目标芯片的展示。
- 接力链断开（源会话被回收后再点接力）的容错。
