# 交付编年史（已完成方向的交付记录）

> 从 ROADMAP 迁出（2026-09-12 拆分）。ROADMAP 只保留**未来时**——待排期方向与决策依据；
> 方向一旦标记完成，交付记录搬到这里，ROADMAP 原位只留一行索引（方向编号保持不变，
> 代码注释里的「方向N」仍能在 ROADMAP 搜到并跳转到本文对应节）。
>
> **本文是历史档案，不再更新**。内容反映交付当时的事实，后续演进以代码为准；
> 上游行为实测结论另见 `research/`，本文只记「我们做了什么、为什么这么做」。
> 按日期倒序。

---

## inbox 装配注入（InboxChannel）——2026-09-19

定性：hub↛push 红线此前靠 `socket.ts` 豁免（`addInboxClient` / `inboxSnapshot` /
`removeInboxClient`）。与 `InboxSink` 同模式：实现留在 `push/inbox.ts`，装配层
`initInbox()` 一并注入 `InboxChannel`。hub 生产代码零 push import，biome 撤掉
`socket.ts` 整段 override。

**刻意不做**：搬家改名（批次 C）、不改 inbox 扇出/快照语义。

review 收口：单测锁 add/remove 各一次；inbox 开连接先取 Channel 再挂 keepalive（未装配不漏定时器）。

## hub 编排收口 BackendPort（/clear 与接力）——2026-09-19

定性：合入机械两档后的全仓勘察里，唯一高层越层是 hub 为 `/clear` 与接力直连
`claude/backend.keyFor` / `parseKey` / `processManager.rekey`。`rekeySession` 在 handoff
路径已经走 port，`/clear` 没走同一口。

**做了什么**：`BackendPort` 补 `keyForExisting`（claude 内 `sanitizePath` 作 slug，codex
忽略 cwd），`rekeySession` 从可选改为必有；`resolvedSessionKey` 处理「已是 s|/x| 则原样」。
`hub/callbacks.ts` 与 `hub/handoff.ts` 生产代码不再 import 具体 backend / processManager。
Biome 红线④：hub 生产路径禁直连 `claude/backend|processManager|port` 与
`codex/backend|runtime|port`（`*.test.ts` 豁免，镜像 routes）。

**刻意不做**（下一批）：inbox 装配注入、搬家改名、processManager 抽纯函数、13.5。

review 收口：`socket.ts` 豁免改为只放行 push（红线④仍锁具体后端）；`/clear` 单测补进程 map 与 `s|` 二次重键。

## AI 维护残留机械清理（PR #58 / #59）——2026-09-19

定性：仓库的 AI 维护债是**重构残留**（过期指针、双写壳、巨型文件、同形映射各写一份），
不是典型 slop。分两档只做机械清理，不改语义、不动 13.5。

**第一档（PR #58）**：过期 `AGENTS.md` / 审计指针；Biome 把 list/history/modelNames 收到
`BackendPort` 后才能禁 `discovery`/`backend` 直连；`isCodexKey` 前缀判定进 `port.ts`；
`sanitizePath` 再导出删除；`setDraft` 去双写名；斜杠分区表 + `conversation_reset` 不变量。
review 收口：`readHistory` 必须 await（`JSON.stringify(Promise)` 曾是 `"{}"`）、列表
`Promise.allSettled`（避免 `await` 打断 unhandledRejection 即致命退出）、`SessionInfo.live` 恢复。

**第二档（PR #59）**：`SessionList` 抽出通知菜单 / 行操作 / 分组行（本体 476 行）；
`handleCli` 按 type 拆函数，入口走 `CLI_INGEST_TYPES` 穷尽分发；
`cliContentToHistoryBlocks` web/server 同形（签名对齐 + 夹具对拍），图片仍只在
`discovery` 的 `onImage` 落盘。两份审计只加「已落地 / 仍有效」头，正文不改。

**刻意不做**（留给后续维护者，清单在 ROADMAP 方向十三「待排期」）：AgentEvent、
processManager 会话类、两套摘要口径、会话类统一、ensure 时序红线根治、真 CLI e2e 进 CI。

**验证**：PR #58 后 702/0；PR #59 含 review 补测后 720/0。chrome-devtools：列表分组、
通知菜单（页内/推送/webhook/测试）、行菜单（重命名/回收站）。

## 方向十二（续）：Codex 会话发现改读盘优先——2026-09-14

方向十一评审发现「状态探测经 ensureRpc 永久拉起 app-server」时实证出更深的既有行为：
`/api/sessions` 的 codex 线程发现（10s 轮询）本身就会永久拉起 app-server（闲置实测
~120MB RSS），失败时每轮重试无退避。本次把会话发现改为三轨：

- **app-server 已运行**（有 live 会话）→ RPC 全保真（含 live status），零新增成本。
- **未运行 → 读盘**（`backends/codex/discovery.ts`）：扫 rollout 文件头 + `session_index.jsonl`，
  镜像上游 `rollout/list.rs` 的 HeadTailSummary 与 `filters.rs` 的 source 映射
  （{cli,vscode,exec,mcp}），名字以 session_index 为准（同名后写胜出）；**不读 state_N.sqlite**
  （版本号内嵌文件名是明确的内部格式，且列表页用不到 sidecar 元数据）。
- **读盘失败 → RPC 兜底 + 60s 失败退避**（防崩溃重试循环）；漂移跳线：目录非空找不到
  rollout 文件、或全部文件解析不出 session_meta，抛错回退而非静默空列表。

两个只有真实数据才抓得到的 bug（均已修并锁回归）：① fork 文件会把父线程的
session_meta 拷进第二行（上游 list.rs:1145 同款注释），解析被覆盖会产生父线程幻影行
（本机 104 行中 37 行是幻影）——只认第一条 session_meta；② resume 续跑产生同 id
多文件，需按 thread id 去重（取最新 mtime，preview/createdAt 从旧文件回填）。

评审第二轮又修十一处（recall 模式 15 条中采纳 13 条）：
① live RPC 失败也落读盘（原来只在读盘失败时落 RPC，单向兜底）；② **app-server 闲置
10min 自动回收**——进程一旦拉活即恒活会让读盘轨成死代码，回收条件只看「无 live 会话
句柄且无 ephemeral 收集器」；③ readdir→stat 竞态不再中止整轮扫描；④ 瞬时 IO 错误
不写缓存（一次抖动曾被固化成线程长期消失）；⑤ readdir 错误码区分（ENOENT=空列表，
EACCES/EIO 走兜底）；⑥ 漂移跳线只认 rollout-* 文件（.DS_Store/骨架目录不再假触发），
不可识别后缀（.jsonl.zst 压缩形态）计入跳线；⑦ sawSessionMeta 需拿到字符串 id
（上游改名 id 时跳线必须有效）；⑧ **入列要求 preview**（上游 list.rs:819-820 硬要求，
本机实测 5 个零用户消息线程在 RPC 轨本就不可见）；⑨ 扫描预算对齐上游 210 行且按
完整换行截断；⑩ 双轨统一去重与统一过滤口径（archived 补上 sourceKinds——
**行为变化**：`modelProviders: []` 让换过 provider 的用户的历史线程全部可见，
此前上游默认只回当前 provider 的线程）；⑪ 退避按 active/archived 分离。
已知取舍：磁盘格式是内部实现不是协议面，故所有识别规则都标注上游源码出处；
读盘行不带 live status（外部活跃的 codex 会话显示离线，attach 后 WS 状态接管）；
名字只取 session_index（sqlite 双写备份不读）。

## 方向十一（续）：Dockerfile、双后端登录状态页、公网一键脚本——2026-09-14

方向十一剩余三项全部交付；「`bun` 进 optionalDependencies」维持原判（先用 launcher 数据说话）。

- **Dockerfile（单阶段 all-in-one）**：`node:22-bookworm-slim` 基底 + npm 官方分发装
  `bun@1.4` 与双 CLI——codex 的 bin 是 node 启动脚本，镜像必须带 Node，这是选 node 基底
  而非 bun 基底的唯一原因。构建期 `bun install --frozen-lockfile` + `bun run build`。
  入口 `bun cli/anyplane.ts`（跳过 node launcher 包装层：PID 1 即服务进程，`docker stop`
  的 SIGTERM 直达优雅关闭）。默认 `ANYPLANE_HOST=0.0.0.0`，复用「非回环必须 token」守卫
  实现 fail-closed。版本锚点走 `--build-arg`；CI 新增 docker build job。
  **双 CLI 默认钉已验证版本（非 latest）**：latest 构建会把未经任何验证的 CLI 组合装进镜像，
  protocol-drift CI 的漂移检出对 docker 用户就毫无保护价值——钉版让漂移期间用户天然停在
  好版本上，CI 检查通过后 pin 前移（一行 PR）；bun 维持 minor 轨（1.4.x）吃 patch。
  **本机实测（2026-09-14）**：TencentOS 无特权容器里 dockerd 需 `--iptables=false`
  （NAT 不可用），构建改走 buildah `--isolation=chroot --storage-driver=vfs`；
  镜像构建、fail-closed 拒绝启动、带 token 起服务、双探针在容器内全通。
  **凭证卷默认改推命名卷**：容器 CLI 对挂载的宿主 `~/.claude`/`~/.codex` 可写，
  版本比宿主新时会把宿主配置/状态向前迁移（codex 带版本 sqlite 状态尤其敏感）——
  「替用户更新 CLI」的真实风险点在凭证卷而不在镜像内安装；
  直挂宿主目录降级为「共享登录态但需钉版本」的可选项（README / gateway.md 同口径）。
- **双后端登录状态页**：新端点 `GET /api/backends/status`（60s 缓存 + single-flight，
  与前端轮询同频，探针成本不随轮询放大）。
  Claude 侧探测用官方轻量子命令 `claude auth status --json`（2.1.270 实测有
  `loggedIn/authMethod/apiProvider`），比 ROADMAP 设想的 `initialize.account` 握手便宜一个量级；
  `oauth_token` 在 JSON 里不细分 env/setup-token，统一归「Token」。
  Codex 侧走 `account/read`：`account=null + requiresOpenaiAuth=false` 即自定义 provider
  （API-key 组织用户的典型形态），这条语义实测确认（本机 deepseek 配置）。
  **评审驱动的四处修正**：① `claude auth status` 退出码语义是 `loggedIn ? 0 : 1`——
  未登录退出 1 但 stdout 仍是合法 JSON，初版探针把非零退出误判 `unknown`（容器实测抓出，
  提取纯函数 `parseClaudeAuthStatusOutput` 并补回归测试）；② codex 探测改**一次性
  spawn+kill**（会话在跑则复用共享连接）——`ensureRpc()` 会永久拉起 app-server，
  违背懒 spawn 红线；握手参数抽成 `handshakeAppServer` 与 ensureRpc 共用防漂移；
  ③ 探针 stderr 持而不读会在子进程写满管道时阻塞到超时误报 unknown，改为同步消费；
  ④ 缓存含 unknown（不缓存会让「app-server 启动即崩」演变成 spawn 崩溃重试循环）。
  前端 `BackendStatusCard` 自决可见性——双后端可用不占版面，有问题或空列表（首次上手）
  才出现；DirPicker 警示与状态卡共用 `backendFixHint` 唯一文案源。
  容器 UI（双后端未登录态）已经 chrome-devtools 截图验证。
  **已知边界（非本项引入，未动）**：`/api/sessions` 的 codex 线程发现本身就会
  ensureRpc 永久拉起 app-server（10s 轮询），失败时每轮重试 spawn——懒 spawn 语义
  在会话发现层的取舍是另一笔账。
- **公网配方一键脚本**（`bun run public-access <funnel|cf-quick|caddy>`）：只做隧道创建与反代，
  不碰账号体系。**未配 authToken 一律拒绝执行**——隧道层暴露在服务端启动检查之外，
  token 防线从「靠自觉」升级为脚本硬门槛。逻辑层 `run()` 的全部副作用经 RunDeps 注入，
  测试在进程内覆盖（评审发现旧 spawn 集成测试只隔离 HOME，仓库根 anyplane.config.json
  会穿透 token 门槛，本机跑 bun test 可能真执行 `tailscale funnel`）；包装层薄壳 +
  顶层异常兜底（配置解析错误给可读一行而非 unhandled rejection 堆栈）。
  CF 命名隧道涉账号与 DNS，明确不在脚本范围内。

## 方向十二（部分）：上量前的运行韧性——2026-09-12

前三项已按风险完成；第四项（会话列表 O(n)）只做了隔离实验与方向选择，尚未修改生产路径，仍在 ROADMAP。

- **全局异常兜底**：`uncaughtException` / `unhandledRejection` 已与 SIGINT/SIGTERM 汇入同一个
  关闭协调器，复用 `server.stop(true)`、双后端 `disposeAll()` 与 5 秒强退保护。
  正常信号退出码为 0，致命异常/超时为 1；关闭中再遇 fatal 只升级退出码、不重复清理。
- **Codex 上帝文件拆分**：`backends/codex/runtime.ts` 从约 1,435 行降到 353 行，形成
  `mapping.ts`（纯映射）、`history.ts`（历史双轨）、`session.ts`（单线程状态机）与
  `runtime.ts`（app-server/RPC/demux/注册表）四个边界。公开 import 面保持兼容，
  拆分不混入协议或行为变更；双轨历史、partial 输出、审批等待与子线程路由测试原样跟随。
- **编排层风险补测**：原「18 个无同名 test」的统计已过时（此前已有 2 个 hub 测试）。
  本轮新增 28 个 routes/hub 测试，覆盖全部 routes 的关键分支，以及 hub 的状态节流、
  attach 单播补放、回滚互斥、回调广播与死审批清理；进程关闭协调器另有 5 个测试。
  `/clear` 三层重键、真实 CLI attach/退出竞态、handoff 全链仍保留给 e2e，
  不为类型文件或一行转发制造形式测试。

## 方向十一（部分）：分发与首次上手——2026-09-12

- **npm bin 改 Node launcher**（`cli/anyplane.mjs`）。原 bin 指向 `#!/usr/bin/env bun` 的 `.ts`，
  没装 Bun 的机器上 npm shim 只抛 `'"bun"' 不是内部或外部命令`——不说缺什么也不说怎么装。
  目标用户多是 npm 装 claude/codex CLI 过来的，**没装 Bun 是常态而非例外**。
  **红线**：已在 Bun 运行时必须直接 `import` 不套子进程——多一层包装会吞 Ctrl+C，
  绕过 `server.stop(true)` 的子进程树清理（见 AGENTS.md 的 Windows 注意事项）。
  改造后 `bunx` 路径行为与改造前逐字节一致，回归面只有 Node 路径。
- README 英文化与中文分离（中文移至 `README.zh-CN.md`）；官网 iOS 表述分平台化、
  Bun 门槛同步全平台 ≥ 1.4.0。

## 方向七：长会话虚拟列表与初始定位重构——2026-09-09

尾部窗口化方案上线。**交付记录与两次回退的根因已独立成文**：
[`research/2026-09-12-transcript-windowing.md`](research/2026-09-12-transcript-windowing.md)
（回退实录的保质期远长于交付记录，且代码里多处注释指向它）。
尚未动手的 4 条可选优化留在 ROADMAP。

## 方向四：Codex 迁移 Paginated 历史模式与 thread/revert——2026-09-09

**定论**：`thread/revert` 已发布且非实验，原地截断 durable history + 保持 thread id + 会话 key 不变，
体验远好于 `thread/fork`（后者每次回滚产生一条孤立垃圾线程，且 sessionKey 变化需要重定向导航）。
但 `thread/revert` 仅支持 `history_mode: "paginated"` 的线程，因此必须系统性迁移历史读取链路。
迁移同时是**历史完整性的修复路径**——legacy `thread/read includeTurns` 缺三类 item，
codex 会话刷新后工具卡会凭空消失（上游实测细节见
[`research/2026-09-11-codex-upstream-behavior-notes.md`](research/2026-09-11-codex-upstream-behavior-notes.md)）。

前置：本机 codex 已从 0.148.0 升级 0.153.4（2026-09-09，单独 PR）。

**实施步骤（全部落地）**：
1. **新线程创建**：`thread/start` 显式传 `history_mode: "paginated"`（0.153 起上游已默认 paginated，
   显式传降为防御性措施）。
2. **历史读取分页重构**：`readHistory` 从已 deprecated 的 `thread/read includeTurns: true`
   迁移为 `thread/turns/list` + `thread/items/list` 分页，同时解决超大历史读取慢的问题。
3. **双轨兼容分流**：既有历史会话仍为 legacy，`readHistory` 按 `thread.history_mode` 自动分流；
   回滚也按 mode 选择：paginated 走 `thread/revert`，legacy 降级走 `thread/fork`。
4. **回滚时序**：`thread/revert` 原地生效后，前端清理当前 turn 之后的消息并刷新状态，无需换 key 导航。

**交付明细**：
- 服务端：`thread/start` 显式 paginated；`readHistory` 按 `historyMode` 双轨分流
  （paginated：turns/list **显式 asc**（默认降序，实测）+ items/list 跨 turn 分页归组；
  legacy：维持 thread/read）；`revertAt`/`historyModeOf`；`thread/reverted` 通知 →
  cli 系统消息入环广播；paginated resume 跳过 rollout 回扫（0.153 冷 resume 自动补发 tokenUsage）。
- port：`rewindConversation` 双轨——paginated 原地 revert（清 hub.cliRing 防重连复活
  "被回滚的未来"，广播 `reverted` 就地截断）；legacy 维持 fork + 导航。status 下发 historyMode。
- 前端：RewindPicker 按 historyMode 切换「回滚到此处」/「从此处分叉」文案；
  `reverted` 事件就地截断（**排除**所选消息——beforeTurnId 语义，与 claude rewound 的
  保留目标不同）；cli `thread_reverted` 触发权威历史重载（5s 回声去重）。
- 验证：`bun test` 446 全过（新增 5 项：双轨分页/asc/锚点/孤儿 turnId/reverted 通知）；
  `server/scripts/e2e-codex-paginated.ts` 全绿（真实服务端+模型：历史工具卡完整、
  revert 截断、原地续聊、legacy fork 降级）；分 turn 超时 + 失败轨迹 dump 入脚本。
- 已知边界：冷/热 resume 的 tokenUsage 补发差异与 writer lock 时序见 AGENTS.md；
  e2e 脚本需用唯一 cwd（xn key 跨次复用会撞服务端残留 Hub）。

## 方向五：Codex 实时流与思考增量对齐（Delta 通知接入）——2026-09-07

**定论**：此前 Codex 大多等 `item/completed` 整块到达才显示，思考过程依赖
`~/.anyplane/reasoning/` 侧车落盘，子代理转录需前端 8 秒定时轮询。接入 app-server
原生 Delta 通知后全面消灭（探针实测结论见
[`research/2026-09-11-codex-upstream-behavior-notes.md`](research/2026-09-11-codex-upstream-behavior-notes.md)，
其中「子线程事件直接推到父连接」推翻了 AGENTS.md 旧结论，无需 resume 子线程）。

- 服务端：`item/reasoning/summaryPartAdded`（摘要分段补 `\n\n`，仅见过 summary delta 时）；
  `outputDelta`/`terminalInteraction` 尾部追加、`mcpToolCall/progress` 取最新，300ms 追尾合并为
  **partial tool_result**（`partial:true` 标记——前端更新卡片文本但保持运行态；cliRing 不占序号，
  重连由终态 `aggregatedOutput` 兜底；缓冲尾留 32KB）。
- collab 父子事件链转发：`subAgentActivity started`/`collabAgentToolCall` End 注册子线程路由，
  子线程 `item/completed` 翻译为 claude sidechain 形状（`parent_tool_use_id`=子线程 id，uuid 与
  历史同口径）进侧栏桶；孙代理 `task_started` 携带 `parent_tool_use_id`+`spawn_depth` 血缘；
  子线程 reasoning 同写侧车（侧车条目新增 `itemId` 锚点，live/历史去重不叠加，顺带修复主线
  思考块重连补发可能重复的隐患）。子线程 delta/tokenUsage/turn 级事件不进桶（桶无草稿概念）。
- 前端：`pairToolResultPartialIn`（保 pending、过期丢弃、不进乱序缓冲）；工具卡 streaming
  时强制展开（Thinking 同款行为）；`taskStarted` 读取 `parent_tool_use_id`。
- 验证：`bun test` 437 全过（新增 27 项）；`server/scripts/e2e-codex-streaming.ts` 真实
  server+模型全链路（A 正文/思考增量先于 result；B partial 先于终态且终态完整、append 增量标记；
  C 侧链转录先于 task_notification）；浏览器实测。
- 侧车维持原角色（离线历史兜底，live 从不读它）；**终态拉取无条件保留一次**（审查发现：
  live 转发使"桶非空即跳过"守卫常真，中途接入的客户端会永久缺早期 item——uuid 去重已幂等，
  代价仅终态一次 RPC）。
- **medium 审查修复轮**（8 条存活发现全修）：终态拉取改**全量重建**（append 会把早期 item 追加到
  live 覆盖段之后打乱时序）且桶已驱逐时丢弃结果（防重建出永不驱逐的僵尸 running 卡）；partial 改
  **append 增量**下发（全量重发在 32KB 缓冲 × 300ms 窗口下放大约 100 倍下行，远程/蜂窝场景不可接受；
  MCP 进度保持替换语义）；ToolCard 开合改派生值（用户点过以用户为准，不再被 streaming 翻转顶掉）；
  子线程注册收编 `registerSpawnedChildren` 单份实现（路由地基防两处拷贝漂移）；子线程未知 item 类型
  warn 留痕（对齐宽松解析红线）；e2e 脚本收编 `e2e-lib`（connect 支持 ANYPLANE_TOKEN——此前 lib 消费者
  对带 token 服务端全灭；新增 spawnAppServer 共享 stdio harness，消除与 e2e-codex.ts 的静默分叉）；
  e2e 总超时正确退 1（原先空断言集超时退 0，挂死会被 CI 当绿）。
- 已知边界：attach 中途接入运行中的 collab 子线程，注册前事件跳过（warn 留痕），终态拉取兜底。

## 方向六：架构解耦与上帝文件重构（BackendPort 抽象）——2026-09-07

**定论**：`index.ts`（1800+ 行）和 `Chat.tsx`（2000+ 行）承担了过多混合职责，双后端在 `index.ts`
散落 20 余处 `isCodexKey` 分支。此项为**纯架构解耦重构**，绝不与任何行为改动混杂，独立开分支推进。

**已交付**（PR #15）：
- **服务端 BackendPort 契约**：`backends/port.ts` 定义接口，`portFor(key)` 是编排层唯一的后端分支点；
  状态/句柄/生命周期/消息/回滚/侧问/查询/handoff/审批/REST 管理全域收编进 claude/codex 两个适配器（S1.1–S1.7），
  `isCodexKey` 从编排层清零（只剩 key 元数据读取）。装配经 `initBackendPorts` 显式注入 HubServices，
  适配器不反向 import 编排层。
- **index.ts 拆分**：`hub/`（registry/callbacks/messages/lifecycle/status/broadcast）与 `push/` 物理切出（S2.1），
  `routes/` REST 四文件切出（S2.2），index.ts 收口为纯装配层。
- **Chat.tsx 拆解**：纯函数与斜杠拦截表下沉 lib（F1）→ 展示子组件 ChatHeader/Composer/DetailDrawer（F2）→
  useTaskBuckets（F3）→ useTranscriptIngest（F4）→ useSessionSocket（F5）。
- **merge 前审查修复轮**（medium 审查 8 条存活发现，1164e66）：ensureForSend 异常防护（挪进 try）、
  `deliverApproval` 共享投递核（自动/手动裁决同路）、approval_auto 摘要口径唯一化（`summarizeInput` 上移 util.ts
  成唯一正本，事件直接带 `detail`，前端删自建口径）、btw 双端共享信封、codex `threadRpc` 收敛与归档列表复用
  `toSummary`、/clear 重键加后端守卫、e2e-push 恢复全路径断言并修复 HTTP 鉴权缺口。

**验证**：`bun test` 410 全过（含新增 summarizeInput 口径单测）；e2e-ws / e2e-slash / e2e-approval / e2e-push
真实 CLI 全链路绿；浏览器实测会话列表、回收站归档/恢复、发消息、codex btw 均正常。
零行为改动红线守住。未来评估第三后端（OpenCode/Gemini）时以 BackendPort 为承重结构。

## 方向三：公网接入（不自购云服务器）——2026-08-27

**定论**：优先级 Tailscale funnel > Cloudflare Tunnel > 家宽 IPv6 直连；都不需要自购 VPS。
三套配方 + 安全红线 + 手机蜂窝验收清单已写入 [`public-access.md`](public-access.md)
（含「通知投递 vs 审批回执」双路径模型与故障排查表——"通知到了、按钮点不动"的唯一根因是
publicUrl 入方向不可达）。authToken + 手机 ntfy 审批已实测通过。

| 方案 | 花费 | 第三方可见性 | 备注 |
|---|---|---|---|
| Tailscale funnel | 免费 | 边缘节点只转发加密 TCP，TLS 在本机终止 | 一条命令，首选 |
| Cloudflare Tunnel | 免费 | CF 边缘终止 TLS（可见明文），换来 Access 认证层 | 要稳定域名 + WAF 时选 |
| 家宽 IPv6 + DDNS | 零 | 无第三方 | 国内家宽多有公网 v6；注意运营商入站过滤与自身防火墙 |

## 控制通道与管理面三项——2026-08-27

原属 ROADMAP「已验证但暂不做」小节中已落地的部分；该小节保留的是**决定不做**的决策记录。

- **`claude agents --json --all` 状态增强**：`backends/claude/agents.ts` SWR 轮询
  （15s TTL + 后台刷新，listSessions 同步热路径零阻塞）；pid 文件优先、daemon 兜底——
  独有价值是 `kind:background` 后台 agent（无 pid 文件）的存活状态。
  （control.sock 深度集成维持**不做**的结论，理由留在 ROADMAP。）
- **MCP 管理面板**：claude 详情抽屉 MCP tab 结构化面板（状态/工具数/scope/配置摘要/错误），
  重连（mcp_reconnect）与启停（mcp_toggle，持久化 settings 与 TUI 同语义）；
  query 通道加 extra 传参复用为动作通道。codex 侧维持 mcpServerStatus/list 只读直出。
  浏览器实测重连/禁用/启用全通过。
- **`generate_session_title` 控制通道**：首条真实 user 消息 × 首个 init 双条件触发
  （`maybeGenerateTitle`，按 sessionId 去重，/clear 后新会话再生成）；CLI persist 写 ai-title
  进 transcript，discovery 标题链（custom-title > ai-title > summary > 首条消息）自动接住，
  无需 AnyPlane 侧落状态。实测 4 项全过。

## 方向一：推送通知（手机审批闭环的最后一环）——2026-08-25

- 服务端 `push.ts`：自实现 VAPID + aes128gcm（不依赖 web-push——其 node:https 假定 TLS）。
  订阅注册表 `~/.anyplane/push-subscriptions.json`（per-subscription 能力密钥），
  VAPID 密钥 `~/.anyplane/vapid.json`。
- inbox 事件（approval/done/error）fan-out；审批推送内容详细
  （工具名 + 命令摘要 + 项目名——锁屏脱敏交给 OS）。
- **通知直接审批**：能力 URL（`/api/approval-action?k&r&d&s=<secret>`），SW 通知按钮回 POST 即裁决，
  不开页面；绕开 authToken（能力模型），仅对 pending 中的 requestId 有效。
- 前端：sw.js push/notificationclick、订阅面板（列表页铃铛）、`#s=<key>` 深链。
- 验证：`server/scripts/e2e-push.ts` 15 项全过（mock push service + 独立实现解密反证加密正确 +
  能力审批 + 403 拒绝 + 410 清理）。

### webhook 通道——2026-08-27

配置项 `pushWebhooks` + `publicUrl`；ntfy http action 真一键审批，Bark/Server酱 落
`GET /api/approval-page` 确认页（防预览误触）；webhook 能力密钥 = HMAC(vapid 私钥, 渠道标识) 派生，
不落新状态。验证：`server/src/push.test.ts` webhook 段 7 项单测 +
真实服务端 mock 渠道活体全链路（审批 fanout/按钮 POST/确认页/done 扇出）。

### iOS 通知按钮降级——2026-09-12

**平台能力查证**：Safari（iOS 与 macOS）**完全忽略** notification `actions`，且不实现
`Notification.maxActions`（caniuse：iOS Safari 至 26.6 仍 Not supported；Apple Web Push 文档：
通知表面只保留 title/body/tag/data，图标固定为 Web App 自身图标）。按钮在 iPhone 上根本不渲染——
**「锁屏一键审批」这条核心卖点在 iOS Web Push 上不成立**，用户只看到「需要审批」却找不到怎么批。
152 之前的 Firefox 桌面同理。

`sw.js` 已按 `maxActions` 运行时探测降级（**不靠 UA**：iOS 上任何浏览器壳都是 WebKit）：
不支持时不挂按钮、裁决入口折进 body、`notificationclick` 直达 `GET /api/approval-page` 确认页
而非完整应用壳。**零服务端改动**——`validSecret` 本就同时接受订阅密钥与 webhook 密钥，
直接复用 approval-action 上已补全的能力密钥即可。单测锁死两条分支（`web/src/sw.test.ts`，
放 src 而非 public 旁边：public 会被原样拷进 `web/dist`）。

能力矩阵：Android/桌面 Chrome 一步（通知按钮），iOS/旧 Firefox 两步（通知 → 确认页）。
**iOS 上要回到一步审批只有一条路——ROADMAP 方向二的原生壳。**
