# AGENTS.md

AGENTS.md 只放读代码读不出的东西——设计哲学与决策原因；代码现状速查一律不写（保质期短且必然腐烂）。
在实测踩坑之前，先穷尽官方的协议正本，或者基于 Terminal 真实执行 `claude` / `codex` 命令得到的结果来推断。
做链路验证时非必要不使用 mock 数据，可能导致意外的问题如隐患被掩盖或依赖缺失等。

**写入判定**（每加一句话前过一遍，2026-09-11 精简后立规）：
① 删掉它，改代码时会踩坑吗？会 → 留（红线与决策）。
② 读代码/文档 5 分钟能自己查到吗？能 → 不写（常量值、文件清单、字段路径、UI 布局、目录明细均属此类）。
③ 是上游 CLI 行为的实测结论吗？是 → 写进 `docs/research/` 并按版本标注，AGENTS.md 只留指针。

## 项目定位

AnyPlane：在手机/桌面浏览器中管理本机运行的官方 Claude Code 与 Codex 会话。
**不修改官方 CLI**——服务端以子进程方式驱动两家 CLI 的 headless 协议（Claude 走 stream-json NDJSON，Codex 走 app-server JSON-RPC），并统一翻译为 Claude stream-json 形状，前端与 WS 协议因此不分叉。
与 claude.ai/code 网页版桥接本地 CLI 用的是同一套本地协议。

## 开发纪律

**本项目仅使用 Bun（>= 1.4.0，全平台同一门槛）。绝不要用 npm / npx / yarn / pnpm。**
脚本清单见根 `package.json`。

`bun run verify` 是本地闸：typecheck + lint + test，test 步强制看见完整 pass/fail 汇总行（半截输出按失败）。**verify 不是 CI**——CI 另跑 Windows 矩阵、`e2e-mock`、build 与 docker 构建。

真 CLI e2e 看 `server/scripts/` 脚本头注释（需服务端已启动）。`e2e-mock` 是 CI 唯一不依赖真实 CLI 的 e2e。配了 `authToken` 时 e2e 要带 `ANYPLANE_TOKEN`。anyplane 不传 `--model`——自定义模型配 CLI 自己的默认值（见 `docs/configuration.md`）。

单元测试用 Bun Test，`*.test.ts` 就近放置。新增纯函数补单测，真实 CLI 行为改 e2e。**测试不得依赖文件间执行顺序**——`bun test` 单进程跨文件共享模块实例且枚举顺序各平台不同；碰全局单态的用例开头必须调被测模块复位口，缺则补一个最小复位口。

## 架构

四个 workspace：`server/`、`web/`、`protocol/`、`app/`。**改 `app/` 之前先读** `docs/research/2026-09-18-capacitor-shell-pitfalls.md`。

### 服务端

- **运行数据**：自产数据一律 `~/.anyplane/`，**不做自动清理**。
- **推送**：自实现 VAPID，**不依赖 web-push**（其发送路径假定 TLS）。审批能力 URL 刻意绕开 authToken（秘密只经加密推送，且仅对 pending 的 requestId 有效）；订阅 endpoint 白名单防 SSRF。webhook（ntfy/Bark/Server酱）配置即信任、渠道方可读全文；Bark/Server酱 一键审批落 GET 确认页（GET 只渲染）。细节见 `docs/configuration.md`。
- **日志**：零第三方依赖是刻意约束。
- **鉴权**：绑非回环必须配 token。无 token 时 Origin 与 Host 须一致或同为回环（缺失放行=非浏览器，`null` 拒绝=file://）；非 GET `/api` 强制 `application/json`。配了 token 则两道检查不生效。
- **审批规则**：只在服务端裁决，**绝不进入推送能力 URL**；坏规则启动 fail fast；每次自动裁决必须广播 `approval_auto`；匹配口径与 `summarizeInput` 对齐。
- **sessionKey**：禁止自造前缀，构造/解析走 port。Claude `parseKey` 靠列表反查 cwd——slug 目录被删则无法解析（已知限制）。
- **Hub 生命周期**：会话句柄存活期间 Hub 不得删除（否则重连广播进已删 Hub）。存活判定经 port，不直连适配器。
- **懒 spawn**：`attach` 只握手；首条 user 消息 / 等价控制请求才启动。未 spawn 的选择与自定义 env 必须赶在首条 user 写入 stdin 之前。Codex 已有线程 attach 即 resume，新线程保持懒启动。
- **统一消息边界是 Claude stream-json**。能力差异的唯一权威是适配器 `capabilities` 声明——新增能力走声明，禁止 no-op 方法或前端兜底表。`port.ts` 是契约叶子，不 import 适配器。
- **协议正本在 `@anyplane/protocol`**：新增 WS 事件先改这里。不要在本包 import server/web。
- **依赖红线由 Biome 执行**（报错文案即规则意图）。例外进豁免清单并写原因。时序红线（ensure 零 await）仍只有注释守护——GritQL 够不到 class 方法。
- **claude**：未知字段/type 一律透传。daemon 视图独有价值是 background agent 存活态；control.sock 版本锁死，刻意不用。
- **codex**：单 app-server 进程托管全部线程。live 与历史 ThreadItem **必须同形**。协作/子代理活动只走侧栏不进主线；其余未知 type 留痕后透传或跳过，禁止静默丢弃。
- **busy**：Claude 信 `session_state_changed`；Codex 用 status + 审批等待合成 requires_action。**running / requires_action 时绝不回收。** `system/init` 是每个 query turn 的首包不是 spawn（详见 `docs/research/2026-09-21-claude-headless-pitfalls.md`）——标题必须双条件；前端在权威 idle 且无合法草稿时自清陈旧草稿。
- **上下文占用**：claude 用最后一条主线 assistant 的 `message.usage`（input+cache，不含 output），**不用 `result.usage` 的 input**。codex 用 `last.totalTokens`（`total` 是累计）。窗口以官方 `get_context_usage` 的 `maxTokens` 为权威，模型名启发式只是首见兜底。离线水合严禁在列表端点逐行做。踩坑实录见 `docs/research/2026-09-21-claude-headless-pitfalls.md`。
- **Codex 决策**：`turn/start` 强制 `approvalsReviewer: "user"`；线程被占不 kill。新线程锁 paginated 历史；回滚 paginated 走 revert（清环形缓冲、**序号保持单调**——否则重连补放会复活被回滚的未来），并入环一条 `thread_reverted` 兜底触发前端权威重载；legacy 降级 fork。流式 delta 合并为 partial `tool_result`（前端更新文本但保持运行态；**环形缓冲不占序号**，终态兜底）。`plan/delta` 有意不接。上游实测笔记：`docs/research/2026-09-11-codex-upstream-behavior-notes.md`。曾静默丢弃的五种 ThreadItem 见 `docs/research/2026-09-21-codex-threaditem-silent-drop.md`。
- **接力**：Claude 在线走 `side_question`，离线才一次性 fork；Codex 走 ephemeral fork。简报生成在两边 port，**不要把 vendor spawn 拉回 lineage**。
- **AI 标题**：首条真实 user × 首个 init 双条件齐备才触发。CLI 自写 ai-title，**AnyPlane 侧不落标题状态**。
- **配置**：可放项目根 `anyplane.config.json` 或 `~/.anyplane/config.json`，**不允许 `~/.config/`**。全集见 `docs/configuration.md`。

### 前端

- 开发前端不用 emoji，用图标库或自绘。
- **store**：渲染外需要读到最新值参与后续计算的状态走 store；只写不读留 useState。store 解决的是过期读，不是取代 setState。
- **重连补发**：下行 cli 带单调序号；客户端维护高水位，attach 时按游标单播补发（照搬官方 Bridge）。环底被挤掉则服务端发缺口事件，前端重载历史。
- **ingest 是归并唯一实现**：live / tail / 历史三路共用。先到的 tool_result 进 pending，工具块落地再补；真孤儿到批次收尾或权威 idle 才浮现。
- **抄本窗口化三条红线**（实录 `docs/research/2026-09-12-transcript-windowing.md`）：①初始定位先于窗口化；②扩窗只认向上滚动，新增向上滚动必须套守卫；③窗口粒度是渲染行。行 key 必须内容派生。翻页 prepend 前先捕获锚点。
- 过滤：`<system-reminder>`/isMeta 不进主抄本，sidechain 不入主流；`compact_boundary` 渲染为分隔线。
- **后台任务侧栏**：`task_started` 是 live-only，中途接入靠 status 的权威任务列表水合。历史子代理只回填「窗口内且主线结果缺失」的。终态只有宽限期驱逐一种语义，驱逐即永久。codex 桶键用子线程 id；协作工具调用必须同时出主线卡。实录见 `docs/research/2026-09-21-task-sidebar-hydration.md`。

### 斜杠命令

全景审计 `docs/audits/2026-08-slash-commands.md`。清单以代码为准，本节只记决策。

- claude 尽量透传；codex 凡有 RPC 对应物必须前端拦截。
- 拦截放在 UI 层而非服务端（会话导向：分叉/重命名/导航）。
- 必须拦：`/btw`（headless 空操作 → `side_question`）、`/branch`（headless 写孤立 fork 不切换，全形拦）、`/exit` `/quit`（headless 真杀进程）。
- 不拦 `/clear`：CLI 换 sessionId 是想要的新会话语义；服务端三层重键（Hub / 进程 map / 存活 WS key），少一层即双进程或消息黑洞；并广播 `moved` 驱动导航。
- rewind：先摘进程再按检查点重 spawn（避免旧退出回调污染）；组合回滚必须先等文件检查点成功，绝不能先截断对话。

## Windows

- Bun ≥1.4.0 门槛由来与死 PID 处理见 `docs/configuration.md`。可用 `ANYPLANE_ALLOW_UNSAFE_BUN=1` 跳过。
- 开发启动器故意不用 `bun --watch` / `bun run --cwd`（Windows watcher 会在异步清理完成前杀掉 server）。**不要用任务管理器强杀 server**。
- 不要手工 `cmd.exe` 包装 `.cmd`——Bun ≥1.4 原生可执行，手工加引号会被转义、空格路径断裂。显式 `claudePath` / `ANYPLANE_CLAUDE_PATH` 是权威。

## 已知限制

- compact 边界之前不能 rewind；文件回滚只到有检查点的消息；effort 运行时切换依赖环境变量更新，旧 CLI 可能需重开会话。
- Codex 无文件检查点（不支持组合回滚）；rollout 不持久化 reasoning（侧车落在 `~/.anyplane/reasoning/`）。
- 未配 token 严禁绑非回环。目录列表接口暴露本机目录，与任意目录起会话同级风险。
- 跨网段不自建公网穿透：见 `docs/public-access.md`。

## 文档

**漂移覆盖不到的私有 subtype**：`side_question` 与 `generate_session_title` 不在官方 SDK 类型里。上游改名只会运行时静默失效，升级 CLI 后务必跑接力/斜杠 e2e。

**协议正本优先**：claude 看 `@anthropic-ai/claude-agent-sdk` 的 `sdk.d.ts`；codex 看 `codex app-server generate-ts --experimental`。本地镜像 `docs/claude-code/`、`docs/codex/`（`bun run docs:claude` / `docs:codex`，gitignore）。

文档地图 `docs/README.md`。改配置/网关同步 `docs/configuration.md` 与 `docs/gateway.md`。发版见 `docs/releasing.md`：tag 必须与根 package.json 版本同步。

## Git 协作要点

改代码从最新 `origin/master` 开分支（已在任务分支上则继续，不套娃）。
收尾前 `git fetch`，主干有更新则 rebase 到 `origin/master`（保持线性；冲突拿不准先停下问用户）。
rebase 后只对自己未合入的功能分支 `--force-with-lease`，禁止 force `master`。

开 PR 前过 `bun run verify` 与 `REVIEW.md`。默认开 PR，不直推、不合入 `master`，除非用户明确要求。
本地 verify 绿不够——PR 相关检查须全绿（含 Windows 与镜像构建），不是任意一个 Actions job。红了修同一 PR，不要另开。
CI 绿仍不得自行合入——合入权只在用户。
