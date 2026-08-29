# 斜杠命令全景审计（2026-08）

> 目的：AnyPlane 的斜杠命令面板与拦截层的对齐基准。斜杠命令是重要一环，改动相关逻辑前先读本文。
> 信息源：claude-code 2.1.88 源码快照 + commands.md 文档镜像（~2.1.238）+ codex 仓库 HEAD(1f41cc5d92)+ headless 实测（claude 2.1.220 / codex 0.148.0）。

## 三路事实源

| 源 | 内容 | 给 AnyPlane 的意义 |
|---|---|---|
| claude initialize 握手 | `commands: [{name, description}]`（内建 + 插件 + 用户/项目命令 + 技能合成，按机器/项目动态变化） | 面板事实源：spawn 时 `promptSuggestions:true` 握手获取，落 `state.slashCommands` |
| codex app-server | **无命令清单暴露**（initialize 仅 user_agent/codex_home/platform 字段） | codex 面板清单由 AnyPlane 自维护（FALLBACK 静态表） |
| AnyPlane 自有命令 | btw/branch/goal/rewind + 面板兜底表 | 见下方重合核对 |

## 关键机制事实（实测 + 源码双重确认）

- **claude 未知斜杠**：ASCII 命令名 → 本地回 `Unknown skill: xxx`（local-command-stdout，不进模型）；像路径或含非 ASCII → 原样进模型（烧一个 turn）。
- **codex 任何斜杠文本** → 原样进模型。app-server 无斜杠解析（`turn_processor.rs` 直通输入）；斜杠分发全部在 TUI 层（`chatwidget/slash_dispatch.rs`）。**codex 侧有对应物的命令必须前端拦截，不能透传。**
- **claude 官方 /btw**：headless 下是空操作（`<BtwSideQuestion>` JSX 在非交互分支被置空）→ AnyPlane 用 `side_question` 控制通道实现（headless 唯一正解）。
- **claude 官方 /rewind**：headless 下 `openMessageSelector` 缺席直接 skip 无输出 → AnyPlane RewindPicker + rewind_conversation/rewind_files 是唯一正解。
- **claude 官方 /branch**：headless 下会写 fork 会话文件但**不切换**（context.resume 缺席）→ 透传会造孤儿 fork 会话，必须全形拦截（含参数）。
- **claude /clear（别名 /reset /new）**：headless 下触发 `conversation_reset`（带 new_conversation_id）→ 新 init（新 session_id）→ 后续 turn 落在**新会话**，旧 transcript 原样保留。AnyPlane 处理：Hub + ProcessManager + WS data.key 三层重键，`moved` 事件驱动前端导航到新会话页。
- **claude /exit //quit**：headless 下真杀进程 → AnyPlane 拦截并提示用归档。
- **claude /goal**(2.1.139+)：Stop hook 驱动跨 turn 续跑；goal 激活时 result 只在条件达成后到达；评估反馈以 "Stop hook feedback" user 消息上流。goal 状态不进 stream-json，AnyPlane 从出站文本跟踪。
- **codex /goal**:`thread/goal/set|get|clear` + `thread/goal/updated|cleared` 通知，goal 是 durable 的（重连可回读）。
- **codex /btw(/side)**：官方是 `thread/fork`(SideConversation 持久侧线程）+ `inject_items` + `turn/start`;AnyPlane 用 ephemeral fork 一次性问答（不占地儿，语义更贴合侧问）。

## AnyPlane 自有命令 vs claude 内建（重合核对）

| AnyPlane | claude 内建 | 关系 |
|---|---|---|
| `/btw <q>` | `/btw`(B 类，headless 无效） | 同引擎包装（side_question 控制通道），拦截合理 |
| `/branch [名字]` `/fork` | `/branch`(2.1.212+)/`/fork` | 同名不同体：内建 headless 残废/造孤儿文件；AnyPlane 懒分叉（b| key）是正解。全形拦截 |
| `/goal [条件\|clear]` | `/goal` | 透传 + hub.goal 跟踪 + chip |
| `/rewind` `/checkpoint` `/undo` | `/rewind` 等（headless 无操作） | 拦截 → RewindPicker |
| `/compact` | A 类可用 | claude 透传；codex 拦截 → `thread/compact/start` |
| `/context` | A 类可用 | claude 透传；codex 拦截 → 本地用量摘要（无对应 RPC） |
| `/review [说明]` | `/code-review` 别名（C 类技能） | claude 透传；codex 拦截 → `review/start`(inline，无参=uncommittedChanges，有参=custom) |
| `/rename <名>` | A 类 local | claude 透传；codex 拦截 → `thread/name/set` |
| `/new` | `/clear` 别名 | claude 透传（走 conversation_reset 重键）；codex 拦截 → 导航 xn| 新线程 |
| `/exit` `/quit` | headless 杀进程 | 拦截 + 提示归档 |

## claude 内建命令 headless 分类（速查）

判定依据：`processSlashCommand.tsx`——`local` 多数可用；`local-jsx` 在非交互会话里没提前 `onDone` 就置空（B 类静默无效）。

- **A 类（headless 可用，透传即可）**：/advisor /branch(⚠ 造孤儿，已拦截） /clear /compact /context /cost /effort（带参） /exit(⚠ 杀进程，已拦截） /export（带文件名） /fast（带参） /files /goal /heapdump /keybindings /model（带参） /radio /reload-plugins /reload-skills /release-notes /rename /stickers /tag /voice
- **B 类（TUI 弹窗，headless 静默无效）**：/add-dir /background /btw（已被我们接管） /bug /cd /chrome /color /desktop /diff /feedback /focus /fork（已被我们接管） /help /hooks /ide /login /logout /memory /mcp（无参） /permissions /plan /plugin /privacy-settings /remote-control /resume /rewind（已被我们接管） /sandbox /schedule /skills /stats /status /statusline /stop /tasks /teleport /theme /tui /upgrade /usage /workflows ……
- **C 类（发模型 turn，技能/工作流）**：/batch /claude-api /code-review(/review) /dataviz /debug /deep-research /design-sync /doctor /fewer-permission-prompts /init /insights /loop /recap /run /security-review /simplify /subtask /team-onboarding /verify ……（技能按环境动态出现）
- **别名表**：/bg→/background；/share→/bug；/reset /new→/clear；/review→/code-review；/settings→/config；/usage /stats→/cost；/app→/desktop；/quit→/exit；/ios /android→/mobile；/allowed-tools→/permissions；/rc→/remote-control；/continue→/resume；/checkpoint /undo→/rewind；/routines→/schedule；/remote→/session；/bashes→/tasks；/tp→/teleport

## codex TUI 命令 → app-server 对应物（已核实）

**有 RPC 对应物（可被 AnyPlane 拦截映射）**：
/model(model/list+settings/update) /permissions(settings/update) /memories(thread/memoryMode/set) /review(review/start)✅已接 /rename(thread/name/set)✅已接 /new(thread/start)✅已接 /archive(thread/archive，列表页已有） /delete(thread/delete，**我们不接**——回收站策略不物理删除） /resume(thread/list+resume) /fork(thread/fork，回滚面板已有） /compact(thread/compact/start)✅已有 /plan(settings/update collaborationMode，与我们权限预设不同轴，未接） /goal(thread/goal/*)✅已接 /side /btw(thread/fork+inject_items，我们用 ephemeral fork) /cd(thread/fork 或 start 换目录，复杂未接） /stop(thread/backgroundTerminals/clean) /clear(thread/start)✅已接（=/new) /personality(settings/update) /mcp(mcpServerStatus/list，详情抽屉已有）

**仅信息/账户类**:/usage(account/usage/read) /skills(skills/list) /hooks(hooks/list) /apps(app/list) /plugins(plugin/list) /logout(account/logout) /feedback(feedback/upload) /import(externalAgentConfig/*)

**纯 TUI/本地（无需对齐）**:/ide /keymap /vim /experimental /copy /raw /diff /mention /status /pwd /theme /pets /ps /quit /title /statusline /rollout /debug-* 等

## 遗留注意事项

- claude `/clear` 透传后 UI 靠 `moved` 事件跳新会话页；新 transcript 未落盘前 parseKey 无法反查 cwd（进程存活期无影响）。
- claude `/goal` 需要 CLI ≥2.1.139；旧版会回 `Unknown skill`，chip 状态会误置（低频，暂不防）。
- codex 无命令清单 API：新增 codex 命令支持 = 前端拦截表 + runtime sendControl 映射，两处同步加。
- ~~面板测试缺口~~ ✅ 已关闭（2026-08-27）：合并/去重/前缀过滤抽为 `web/src/lib/slashCommands.ts` 纯函数，单测 `slashCommands.test.ts` 11 项。
