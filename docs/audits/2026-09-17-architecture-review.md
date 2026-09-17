# 2026-09-17 架构评审：结构性债务全景

> 一次成文的外部视角评审，基线 `master` @ `b5780c0`（方向十一 / 方向十二交付后）。
> 本文只记**结构性问题与其决策依据**，不记代码现状速查。行动项与排期见 ROADMAP 方向十三。
>
> 方法：全量 import 图分析（161 条跨目录边，脚本建图 + DFS 找环）、
> 前后端类型对照、模块级可变状态清点、CI 与工程基建清点。所有结论附 `文件:行号`。

## 评审基线

| 指标 | 数值 |
|---|---|
| 生产代码 | 20,930 行（`server/src` + `web/src` + `scripts`） |
| 测试代码 | 8,734 行（`*.test.ts`，就近放置） |
| e2e 脚本 | 15 个（全部不进 CI，需真实 CLI + 凭据） |
| 生产代码 `as any` / `@ts-ignore` / `@ts-expect-error` | **0 处** |
| 服务端 `Record<string, unknown>` | 77 处 |
| lint / formatter | **无**（ESLint / Biome / oxlint / Prettier 均未配置） |
| `AGENTS.md` | 19,995 字节 |

## 核心结论

**问题不在代码质量，集中在缝合处，且都是明确架构赌注的到期兑现。** 两句话概括：

1. **用文档和纪律替代了类型与工具**——关键契约（时序红线、依赖红线、模块环安全性）只活在注释里，
   类型系统与工具链完全不参与执行。维护成本随协作者数量与时间放大。
2. **把 Claude 协议当成了中立契约**——`vendor-neutral` 是定位，`vendor-anchored` 是实现。
   扩展成本随后端数量指数上升，第三个后端接入时集中引爆。

两者都还在可控期。本文九条发现按"会不会要命"排序。

---

## 一、定位与架构自相矛盾：vendor-neutral 的实现是 vendor-anchored

**现象**：`package.json` 的 description 是 *"vendor-neutral control plane"*，但架构的核心决策
（`backends/types.ts:4-9` 明文写出）是「后端边界上统一使用 Claude stream-json 形状」。
Claude 的协议不是「其中一种 wire format」，而是**全系统的通用货币**。

**证据**——依赖方向全部指向 `claude/protocol`：

| 位置 | 性质 |
|---|---|
| `server/src/backends/types.ts:11` | **跨后端共享类型层**反向依赖具体后端协议 |
| `server/src/backends/codex/translate.ts:5` | Codex 翻译器的输出类型 |
| `server/src/backends/codex/session.ts:4` | Codex 会话的消息类型 |
| `server/src/hub/callbacks.ts:8` | 编排层 |
| `web/src/lib/ws.ts` 的 `CliMsg` | 前端渲染管线（手写同形副本） |

`backends/types.ts:8` 的注释诚实地标注了这是「唯一的例外」，说明决策是清醒做出的——
在两个后端时它确实换来了真实收益（前端与 WS 协议不分叉，Codex 会话零改动渲染）。

**后果**：上游 Claude 改一次协议，波及 Codex 后端 + 共享类型层 + 前端渲染管线。
而这个上游是**不受控且会自动更新**的。`AGENTS.md` 自己记下了最危险的一段：
`side_question` 与 `generate_session_title` 是 headless 的**私有 subtype**，官方 SDK 类型里没有，
`driftGuard` 按定义覆盖不到，上游改名只表现为运行时静默失效——而这两个 subtype
撑着**接力（handoff）**与 **AI 标题**两个招牌功能。全仓 40 处标注"实测/逆向/私有"的协议依赖点。

**建议**：引入中立领域事件模型（`AgentEvent`），把 Claude stream-json 降级为
「其中一个 adapter 的 wire format」。这是让定位从 slogan 变成事实的唯一路径。
**时机**：在确定要接第三家之前不要动；但必须在接之前动，不能等接的时候临时改。

## 二、`BackendPort` 是被第一个实现塑形的漏抽象

**现象**：30 个方法的接口，其中 6 项对 Codex 是空实现或运行时拒绝。

```
server/src/backends/codex/port.ts:37    notifyExternalGate(_key): void {}
server/src/backends/codex/port.ts:108   maybeGenerateTitle(_hub): void {}
server/src/backends/codex/port.ts:111   startTailer(_hub, _from?): void {}
server/src/backends/codex/port.ts:112   stopTailer(_hub): void {}
server/src/backends/codex/port.ts:160   rewindBoth → broadcastError('Codex 没有文件检查点…')
server/src/backends/codex/port.ts:211   query    → reply({ ok: false, error: 'codex 后端暂不支持…' })
```

抽象是**事后套上去**的，`backends/port.ts:66-72` 的注释坦白了这一点：

> 「可选属性使 ClaudeSession 无需改动即结构化兼容」

即用 TS 结构类型把两个已存在的类削足适履凑进一个接口，而非先定契约再实现。

**后果**：能力差异只在运行时暴露。前端没有任何静态方式知道某后端是否支持某能力，
只能发请求等报错；"禁用按钮"这种基础体验得靠前端散落的 `isCodex` 硬编码。
第三个后端进来时，要么再加一批 no-op，要么改接口（改三处）。

**建议**：`BackendPort` 增加 `capabilities` 声明（`{ fileCheckpoint, branch, tailer, aiTitle, ... }`），
能力差异静态化，前端按能力渲染；随后删掉 no-op 方法。

## 三、关键契约靠注释维持，类型系统完全不参与

**这是本次评审最担心的可维护性问题。** 三个代表：

1. **时序红线**（`backends/port.ts:130-136`）：

   > 懒启动/续跑会话。**时序红线：claude 实现的函数体到 return 前禁止出现 await**——
   > 调用方依赖 spawn/stopTailer/syncClients/pendingEnv 写入与调用同拍完成

   一个返回 `Promise` 的方法，注释说函数体里禁止 `await`。任何人加一个 `await`
   就引入隐蔽竞态，编译器、测试、review 全不会响。`ensureForSend` 同款。

2. **模块环安全性**（`backends/port.ts:9-11`）：

   > 模块环说明：port.ts ↔ claude/port.ts、codex/port.ts 之间存在 import 环…
   > 两侧都只在方法体内 deferred 使用对方绑定，模块求值期无 TDZ 读取。

   环是真的（另有 `codex/runtime.ts ↔ codex/session.ts` 一组）。不炸依赖的是
   「没人在模块顶层求值时读对方绑定」这个不变量，同样只有注释在守。

3. **依赖红线**（`backends/port.ts:5-7`）：「适配器绝不 import hub 编排层的运行时代码」。

**根因**：`AGENTS.md` 20KB 写得极好，但本质是**把架构约束外包给了文档**——
最弱的约束形式。凡能被表达成类型、lint 规则或测试的红线，都不该只活在注释里。

**建议**：见第八条（装 linter）。第 1 条时序红线的根治是把 `ensure` 的同步部分
拆成显式的同步方法 + 异步收尾，让"禁止 await"变成"这里没有 Promise 可 await"。

## 四、`Hub` 是 17 字段的状态袋，其中 14 个可选

**现象**：`hub/types.ts:29-58` 的 `Hub` 接口，除 `key` / `clients` / `pendingApprovals` 外
全部可选：`cliSeq` `cliRing` `spawnOpts` `pendingEnv` `rewindPending` `tailer` `tailStatusAt`
`goal` `pendingRekey` `sessionId` `titleGeneratedFor` `pendingTitleText` `nameCwd`。

每个可选字段是一个**隐式状态位**，没有显式状态机。类型系统不阻止
`rewindPending && pendingRekey` 同时为真这类非法组合，各 handler 各判各的位。

**这已经产生了补丁上的补丁**（`hub/socket.ts:54-63`）：

> 会话可能因 `/clear` 重键（hub.key 已换成新 s| key）：**按客户端成员资格找回**

关闭连接时反查全表找 Hub，是三层重键漏了一层的兜底。这类补丁会随功能数线性增长。

**另有持久化缺口**：Hub 状态全内存。进程重启丢 `cliSeq` / `cliRing` / `goal` / `pendingApprovals`。
抄本侧有 `lastSeq` 高水位 + `replay_gap` 兜底，但 **`pendingApprovals` 丢了就是审批永久悬挂**，
用户侧表现为"卡住了"，且没有任何自愈路径。

**建议**：拆成显式状态机（`phase: 'idle' | 'spawning' | 'rewinding' | 'rekeying'` + 各 phase 独有数据），
非法组合直接不可表达。`pendingApprovals` 考虑落盘（重启后重放或显式标记失效）。

## 五、前后端契约零共享，且是不对称的零共享

**现象**：三个 workspace（server / web / app），`web` 不依赖 `server`，两边各手写一份类型。

**逐字重复 7 组**：

| 类型 | server | web |
|---|---|---|
| `HistoryBlock` | `backends/types.ts` | `lib/api.ts` |
| `HistoryMessage` | `backends/types.ts` | `lib/api.ts` |
| `SubagentHistory` | `backends/types.ts` | `lib/api.ts` |
| `BackendLoginState` | `backends/status.ts` | `lib/api.ts` |
| `BackendsStatus` | `backends/status.ts` | `lib/api.ts` |
| `LineageRecord` | `handoff.ts` | `lib/api.ts` |
| `ApprovalDecision` | `backends/types.ts` | `lib/decision.ts` |

**但重复不是最糟的，不对称才是**。web 维护着完整的 `ServerEvent` 20+ kind 判别联合，
服务端的广播口是 `broadcast(hub: Hub, payload: unknown)`（`hub/broadcast.ts:51`）。
加一个新 WS 事件，**只有前端能编译报错，服务端毫无约束**。
服务端 77 处 `Record<string, unknown>`——编译期"有类型"、运行时零校验，
比 `any` 更隐蔽，因为它让代码看起来是类型安全的。

**已经漂了一个**：`hub/types.ts:62` 的 `InboxEvent` 联合只声明 4 种，
但 `push/inbox.ts:50` 的 `inboxSnapshot()` 返回第 5 种 `{ type: 'snapshot' }`，
且绕开 `publish(ev: InboxEvent)` 的类型闸门，在 `hub/socket.ts:25` 直接 `ws.send()`。
前端 `lib/inbox.ts` 声明了 5 种。**类型正本已经和运行时事实不一致**——
这次后果轻微，但它证明了漂移不是假想。

**建议**：抽 `@anyplane/protocol` 共享 workspace，收敛 `ServerEvent` / `ClientCommand` /
`SessionState` / `HistoryBlock` / `ApprovalDecision` 为单一正本，`broadcast` 改判别联合。
纯类型迁移，改动面可控，`tsc --noEmit` 会自动暴露所有已漂之处。

## 六、前端：组合层上帝组件 + props 爆炸 + ref/state 双写

- **`pages/Chat.tsx` 595 行**：20 个 `useState` / 7 个 `useRef` / 4 个 `useEffect`，
  同时编排 REST 加载、WS 副作用、斜杠拦截、MCP 查询、goal / handoff / rewind。
  方向六已把 ingest / taskBuckets / socket 三个 hook 下沉，但组合层仍过载。
- **props 数量**：`Composer` 32 个、`ChatHeader` 31 个。无 Context、无 compound component，
  每加一个功能就是「Chat 加一个 state + 平铺一个 prop」，成本线性增长。
- **`ref + state` 双写贯穿全局**（`messagesRef`/`setMessages`、`taskMapRef`/`setTasks`、
  `fetchingEarlierRef`/`setFetchingEarlier` 等）。**理由正当**——WS 回调在 React 渲染外触发，
  state 闭包会取到过期值。但没有统一机制，每处手写同步，漏一处即状态撕裂，
  且 React DevTools 看不到真实状态。

**建议**：引入外部 store（`useSyncExternalStore` 或同形自实现，符合零第三方依赖约束），
把「渲染外可变状态 + 快照订阅」正规化，顺带解掉 props 爆炸。

## 七、routes 层绕过了自己定的唯一分发点

`backends/port.ts:3` 写着「编排层不再出现 isCodexKey 能力分支」，`portFor` 自称
「全仓库的能力分发都收敛到这一个三元」。实际：

- `routes/sessions.ts:4-9` 同时 import `claudePort` + `codexPort` + 两套 `listSessions` / `keyForNew`
- `routes/sessions.ts:101` 用 `body.backend === 'codex'` 字符串硬编码分支
- `routes/misc.ts` 直连 `codexRuntime`
- 编排层内也仍有前缀判断：`hub/callbacks.ts:32`、`hub/handoff.ts:57,61`、`codex/port.ts:60`

**后果**：加第三个后端时 `portFor` 一处改不够，routes 与 hub 都要改。

**顺带**：路由是链式 `if (pathname === … && method === …)` + 手写正则，无统一错误包装，
错误响应形状两套并存——`routes/sessions.ts` 返 `{ error }`，`routes/pushRoutes.ts` 返 `{ ok: false, error }`。

**建议**：`portFor` 改注册表（`registerBackend(name, port)`，装配层注入），与既有
`initBackendPorts` 是同一模式，顺带解掉第三条的模块环；routes 一律经 `portFor`。

## 八、工程基建：没有 linter 是最不该有的缺口

**这条和第三条是同一个问题的两面：有几十条无法被类型表达的架构红线，
而唯一能机械守住它们的工具没有装。**

`no-restricted-imports` 能守「适配器禁止 import hub / routes」「routes 禁止 import 具体 port」，
自定义 AST 规则能守「`ensure` 函数体内禁止 await」——这些正是当前只靠注释的红线。

**第二个缺口**：15 个 e2e 脚本**全部不在 CI**（需真实 CLI + 凭据）。
而按 `AGENTS.md` 的说法，私有 subtype 的**唯一防线就是 e2e**——
系统最脆弱的部位，防线是手动的、依赖人记得跑。
单测 8,734 行集中在纯函数（translate / discovery / protocol），
Hub 编排与 port 适配器这些出事最多的地方恰恰靠 e2e。

CI 现状（`ci.yml`）做得不错：ubuntu + windows 双平台 typecheck / test / build，另有 docker build。
缺的就是 lint 与 e2e 兜底。

**建议**：装 Biome（零配置起步，与零第三方运行时依赖的约束不冲突——它是 devDependency）；
e2e 中不需要真实模型调用的部分（审批链路、WS 补发、重键）用 mock CLI 搬进 CI。

## 九、单实例 / 单租户假设已焊死在代码里

- `~/.anyplane` 硬编码 `homedir()`（`util.ts:11`、`uploads.ts:21`、`reasoningStore.ts:22`、`config.ts:94`）
- `authToken` 是单一静态字符串，无用户模型、无限流、无审计日志
- Docker 以 root 运行，卷挂 `/root/.claude`
- `/api/fs/list` 暴露本机目录树，与「任意目录起会话 = 任意命令执行」同级风险（README 已承认）
- `~/.anyplane` 明确不做自动清理，uploads / trash / reasoning 无限增长

作为「本机个人工具」这些都成立，且是有意识写进文档的取舍。
**记录它不是要求现在改**，而是标注一条分界线：一旦出现团队共用或多实例部署的需求，
这不是扩展而是重写。若 ROADMAP 将来出现团队方向，租户维度必须在那之前作为参数留出来，
不能等 `homedir()` 散布到二十个文件后再抽。

---

## 做得好、重构时不要弄丢的部分

评审同样需要记录**正确的既有决策**，否则后续重构会无意中推翻它们：

- **显式装配注入**（`initBackendPorts` / `initInbox`）：不依赖 ESM 加载顺序副作用，
  是解 hub ↔ push 循环的正解。新增跨层接线应沿用此模式。
- **`cliSeq` 单调游标 + `replay_gap`**：照搬官方 Bridge 的成熟重连模型，不要自创。
- **`lib/ingest.ts` 唯一实现**：live / tail / 历史三路归并收敛成一份，彻底消灭行为分叉。
  **这条原则正是第五条建议（共享 protocol 包）的同一个思路**，应向外推广。
- **生产代码零 `as any`**：20,930 行无一处类型逃逸，这个纪律要保住。
- **决策注释**：每个模块头部记「为什么」而非「是什么」，本次评审的绝大部分证据来自它们。
  问题不是注释写得不好，是**注释承担了本该由工具承担的强制力**。

---

## 附录 A：远端分支清理清单（2026-09-17 清点）

33 个远端分支中 **30 个已完全并入 master（领先 0 提交）**，属纯垃圾。另 3 个有未合并提交：

| 分支 | 未合并 | 判定 | 依据 |
|---|---|---|---|
| `claude-simplify-20260828-173531` | +3 | **可删** | 分叉点 2026-08-27，master 自那以来 208 提交；`merge-tree` 冲突 5 文件，含被方向六彻底重构的 `server/src/index.ts`。改动意图是「复用 helper 减重复」，已被后续重构覆盖 |
| `fix/onboarding-funnel` | +1 | **可删** | 唯一改动是 README 加中文索引行；master 已有等价且位置更好的 `> 📄 中文版文档见 …` |
| `feat/capacitor-shell` | +1 | **保留** | 方向二在研分支（2026-09-17 活跃） |

机器生成分支共 5 类前缀、19 个：`claude-code-review-*`(3)、`claude-security-review-*`(3)、
`claude-simplify-*`(4)、`claude-test-coverage-*`(3)、`claude-test-cleanup-*`(2)、
另有 `worktree-*`(2)、`agent/*`(1)、以及已合并的特性分支若干。

**根因不是忘了删，是没有自动删**。GitHub 仓库设置里的
「Automatically delete head branches」未开启（PR 合并后自动删分支），
而机器评审流程每次运行都新建一个带时间戳的分支。不开这个开关，清理是无限循环的体力活。

## 附录 B：本次评审未覆盖面

以下维度本次未做，不代表无问题：

- **性能**：仅复用方向十二已有的会话列表 O(n) 隔离实验结论，未做新测量。
- **前端包体与首屏**：未测 `web/dist` 体积、未看 code splitting 现状。
- **安全**：未做独立安全评审（`push.ts` 的自实现 VAPID / aes128gcm、能力 URL 派生、
  `fsbrowse.ts` 的路径闸门均未逐行验证）。仓库有独立的 security-review 流程。
- **`app/`（Capacitor 壳）**：在研分支上，未进入评审范围。
- **`scripts/gateway.ts`（573 行）与 `public-access-lib.ts`**：运维脚本，未评审。
