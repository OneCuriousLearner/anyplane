# Codex 上游行为实测笔记

> 从 AGENTS.md 迁出（2026-09-11 精简）。这里记录的是**读 anyplane 仓库代码读不出的上游行为**，
> 均标注实测版本；上游迭代极快，内容会随版本腐烂——改 codex 后端前以
> `codex app-server generate-ts --experimental`（协议正本）与最新实测为准，本文仅作历史参照。
> 本仓库因此做的设计决策留在 AGENTS.md，不在此重复。

## wire 枚举双轨（0.147.0 实测）

- `thread/start` 的 `sandbox` 是 kebab-case；`turn/start` 的 `sandboxPolicy` 是 camelCase。两处都发，勿混。

## 0.148.0 → 0.153.4 schema 漂移（2026-09-09 探针，从 ROADMAP 方向四迁入）

- 漂移 118 处**全部为新增式**（project/*、turn/settings/update、thread/timeline/list、bedrock、
  mcp event stream 等），**无任何已有方法/通知被移除或改名**；实时流依赖的 delta wire 名逐项核对仍在。
- 值得注意的新形状：ThreadItem 新增 `functionCallOutput` variant（走 translate 未知类型 warn 留痕路径）、
  `agentMessage` 新增可空 `delivery`/`questions` 字段、`subAgentActivity` kind 新增 `completed`、
  `CollabAgentTool` 新增 sendMessage/followupTask/interruptAgent/listAgents。
- 升级 CLI 的固定动作：`check-codex-schema.ts` 对比基线 → 刷新 `codex-schema-baseline/` →
  回归 e2e（`e2e-codex-delta.ts` 探针 + `e2e-codex-streaming.ts` 断言）→ `bun test`。

## 线程占用与卸载

- 线程被其他进程持有时 `thread/resume` 报 -32600（anyplane UI 显示"被占用"）。
- writer lock 是跨进程文件锁（`$CODEX_HOME/thread-writer-locks/`），随线程卸载才释放。
- 不 kill 线程进程：断开订阅后 app-server 在**无订阅且无活动满 `thread_unload_delay_secs` 后卸载**；
  该默认值上游已从 30 分钟改为 60 秒（0.149 实测；`thread_unload_delay_secs = 1800` 可恢复旧行为）。
  卸载更快不影响体验：重新 attach 走 `thread/resume`。

## 上下文水合数据源（0.153.4 实测/源码双证）

- paginated 线程的**冷** resume（线程未被该 app-server 进程加载）在应答后自动补发
  `thread/tokenUsage/updated`——`excludeTurns:true` 廉价路径也发。
- **热** resume（60s unload 窗口内线程仍在内存）不发——环形等首个新 turn（窄窗口优雅降级）。
- legacy 线程 resume 恒不补发；rollout 尾部回扫仅对 legacy 有意义，且随 sqlite 化静默失效。
- **上游线程持久化已切 sqlite**：`~/.codex/*.sqlite`（state_5/logs_2/goals_1 等，上游 `codex-rs/state/`
  模块），`~/.codex/sessions/` 的 rollout jsonl 停止新增（本机最后一个 2026-08-29）。影响面：
  历史读取走 `thread/read` RPC **不受影响**（app-server 自读 sqlite），归档/删除走 RPC 同样不受影响，
  reasoning 侧车是 AnyPlane 自存（`~/.anyplane/reasoning/`）不受影响；只有 rollout 尾部回扫失效
  （见上条，按「找不到即隐藏」优雅降级，不报错）。

## 历史读取（方向四，0.153.4 实测）

- 新线程 0.153 起默认 `historyMode:'paginated'`。
- paginated 历史 = `thread/turns/list`（**默认降序**，必须显式 `sortDirection:'asc'`；内嵌 items
  只有 user/agentMessage 摘要）+ `thread/items/list`（跨 turn 升序分页，entry 为 `{turnId, item}`
  包装，item 与 live `item/completed` 同形同 id）。
- legacy `thread/read includeTurns` 缺 commandExecution/collabAgentToolCall/reasoning（0.153.4 未修；
  rollout 时代的老线程经当前二进制读取同样缺，说明是重建/持久化路径而非单线程数据问题）；
  `turns/list` 对 legacy 可用但内嵌 items 只有 user/agentMessage，`items/list` 对 legacy 报 -32601
  ——**legacy 线程只能继续走 `thread/read includeTurns` 的残缺现状，借不了分页 API 补齐**。
- **paginated 线程首个 turn 在跑期间 `items/list` 暂报 -32601「not supported yet」，turn 落定即恢复**
  （2026-09-24，0.155.1 实测）：新建线程/接力播种的导航恰好在这个窗口打历史接口。
  与 legacy 的永久性 -32601 同码不同义——区分只能靠「线程确为 paginated 且首轮在跑」的语境，
  AnyPlane 侧的处置是 paginated 轨道上重试一次（`history.ts readHistoryForThread`）。

## 回滚与分叉（0.155.1 实测）

- **0.155.1 起 `ephemeral paginated thread/fork` 强制 `excludeTurns: true`**，缺省直接报
  -32600（`ephemeral paginated thread/fork requires excludeTurns: true`）。非 ephemeral 的
  legacy fork 不受影响。AnyPlane 侧已恒传 `excludeTurns: true`（`runEphemeralQuestion`，
  字段自 0.154.0 存在，双版本兼容）。

## 回滚（方向四，0.153.4 实测）

- paginated 走 `thread/revert`：原地截断持久历史，thread id/连接/订阅全保留，完成后服务端发
  `thread/reverted`；`beforeTurnId` 语义是"该轮及其后全部移除"。legacy 无 revert，降级 `thread/fork`。

## 实时流（方向五，0.148 实测）

- `item/agentMessage/delta`、`item/reasoning/textDelta`、`item/commandExecution/outputDelta` 真实到达。
  （deepseek-v4 发 raw content，不发 summaryTextDelta。）
- `item/reasoning/summaryPartAdded` 仅在见过 summary delta 时补 `\n\n` 分段。
- `plan/delta` 官方标注 experimental 且拼接不保证等于成稿。
- **0.148 起子线程实时事件直接推到父连接**（含嵌套孙线程、resume 后同样成立）——
  旧结论"不被转发"已过时。

## 模型侧 flake（不是协议回归，回归时别误判）

- `e2e-codex-streaming.ts` 的 C3/C4/Z 断言依赖"主模型用 collab 工具后收敛"。实测
  deepseek-v4-flash 在 0.148.0 与 0.153.4 **同现 spawn→wait→再 spawn 死循环**，
  直连 app-server（无 AnyPlane 介入）也复现——上游/模型侧问题，与 AnyPlane 及 CLI 升级无关。
  升级回归时这三项失败**不代表协议回归**，看 A/B/C1/C2 即可。
  0.155.1 换 kimi-for-coding 复现同族症状（子代理 turn >380s 无 result），结论不变。
- **msys2 CreateFileMapping 崩溃（2026-09-19，0.155.1 + Windows 实测，根因已定位）**：
  `command/exec` 与 Bash 工具命令在**除 `dangerFullAccess` 外的所有沙箱档**（默认/
  readOnly/workspaceWrite）下，msys2/cygwin 二进制（bash.exe、whoami.exe 等 Git usr/bin
  全体）必现 `fatal error - CreateFileMapping S-1-5-21-…-1001.1, Win32 error 5`；同命令
  `dangerFullAccess` 正常，PowerShell/cmd 全档正常（非 cygwin 不碰共享内存 section）。
  **根因**：0.155.1 起 Windows 沙箱走 restricted token（codex-rs `windows-sandbox-rs/
  token.rs`：`CreateRestrictedToken(DISABLE_MAX_PRIVILEGE | LUA_TOKEN | WRITE_RESTRICTED)`），
  msys2 运行时无法用该 token 创建/打开以其 SID 命名的共享内存 section。上游同类报告：
  openai/codex#12000。**重启 Windows 不能治愈**（与进程泄漏无关；唯一已知缓解是
  `sandboxPolicy: dangerFullAccess`，代价是放弃沙箱）。偶发成功（如 e2e-codex-delta
  turn1 出过 tick-1）的最自洽解释：受限 token 进程在 section 尚不存在时**新建**可以成功，
  一旦本机已有正常 token 创建的同名 section（如长活的 Git Bash 会话），**打开**即
  ACCESS_DENIED——故表现 flaky 且与"谁先起跑"相关。e2e-codex-streaming 的 B 组断言
  在此环境下失败是环境/上游问题，不是协议回归——用 `e2e-codex-delta` 的 outputDelta
  探针验证 wire 通路即可区分。
