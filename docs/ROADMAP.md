# AnyPlane 后续规划（ROADMAP）

> 2026-08-24 立。前置：统一 Agent 控制面 8 阶段计划已全部完成（见 [plans/unified-agent-plane.md](plans/unified-agent-plane.md)）。
> 本文档收录已讨论定论、待排期的方向；每条附决策依据，避免将来重新论证。
>
> **本文只保留未来时**（2026-09-12 拆分）：待排期方向、决策依据、明确不做的记录。
> 方向标记完成后，交付记录迁往 [delivered.md](delivered.md)，本文原位只留索引行；
> 上游 CLI 行为的实测结论迁往 [research/](research/)；协议漂移周报（issue）的评估结论与代办
> 归档在 [drift.md](drift.md)。**方向编号永不回收也永不重排**——
> 代码注释里写着「方向四」「方向五」「方向七」，编号是它们唯一的锚点。

## 定位备忘（为什么做这些）

官方远程能力（Remote Control / claude.ai/code / codex remoteControl）对 **API-key 与 gateway 用户硬性禁用**
（Remote Control 文档：订阅限定；v2.1.196 起 ANTHROPIC_BASE_URL 指向 gateway 即禁用）。
**2026-09-12 复核仍成立且排除范围在扩大**：官方文档明确 Pro/Max/Team/Enterprise 订阅限定、
API key 不支持、`claude setup-token` 的长期 OAuth 同样被拒（inference-only scope）、
Bedrock / Google Cloud Agent Platform / Microsoft Foundry 均不可用；v2.1.196 起连指向
非 `api.anthropic.com` 的本地透明代理也一并禁用（此前该配置尚可工作）。
上游 issue #50977 是被排除用户的公开诉求，已被官方回绝——本文档所有方向的前提由此成立。
AnyPlane 是这群用户的控制面：本地优先、provider 中立、双供应商。以下方向都服务于这个定位，
不追官方云能力（云同步/E2EE/多设备），不与官方 TUI（agent view）赛跑 UI。

## 已完成方向索引

交付记录全部在 [delivered.md](delivered.md)，上游实测结论在 [research/](research/)。

| 方向 | 主题 | 完成 | 遗留 |
|---|---|---|---|
| 方向一 | 推送通知（含 webhook 通道、iOS 按钮降级） | 2026-08-25 / 09-12 | 真机实测未做（作者无 iPhone）；iOS 一步审批只能靠方向二 |
| 方向三 | 公网接入三套免 VPS 配方（详见 [public-access.md](public-access.md)） | 2026-08-27 | 蜂窝验收待 CF Tunnel 落地 |
| 方向四 | Codex 迁移 Paginated 历史模式与 `thread/revert` | 2026-09-09 | — |
| 方向五 | Codex 实时流与思考增量对齐（Delta 通知接入） | 2026-09-07 | — |
| 方向六 | 架构解耦与上帝文件重构（BackendPort 抽象） | 2026-09-07 | — |
| 方向七 | 长会话虚拟列表与初始定位重构（尾部窗口化） | 2026-09-09 | 4 条可选优化，见下方「抄本窗口化 / 虚拟列表」 |
| 方向十一 | 分发与首次上手（launcher / README 英文化 / Dockerfile / 登录状态页 / 公网一键脚本） | 2026-09-12 / 09-14 | `bun` 进 optionalDependencies 待 launcher 数据；Docker 镜像未实测构建（CI 盯） |

## 方向二：App 壳（Capacitor，不换技术栈）

**定论**：不做 RN 重写（代码翻倍、维护翻倍，happy 的路线不是我们的路线）；
用 **Capacitor 套壳现有 PWA** 打出 iOS/Android 原生包——日常开发仍是写 React，新增的只是构建链。

**状态（2026-09-18）**：Android 半区已全链路交付并在真机验收通过（vivo OriginOS 6 /
Android 16：锁屏审批通知 + 按钮裁决 + 前台服务常驻）。分支 `feat/capacitor-shell`
（PR #42，含 code-review / security-review / simplify 三轮质量评审）挂起待合。
iOS 半区 spike 收官但**被平台回归阻断**（见下）。**完整踩坑实录、IPC 契约、
验证手法与后续项清单在 [research/2026-09-18-capacitor-shell-pitfalls.md](research/2026-09-18-capacitor-shell-pitfalls.md)
——改 `app/` 或审批链路之前必读**，本节只留决策与待办。

**形态决策（与本文早期草稿相反，决策依据见 research §1）**：**hosted 而非打包**——
壳内不打包 `web/dist`，WebView 直连用户自托管服务端；`web/` 零改动、前端版本永远与
服务端匹配。代价是首启填地址 + 壳内导航白名单（实现见 research §4.3）。

**iOS 阻断（2026-09-18 结论）**：iOS 26 的 ShortLook 展开卡不渲染 action 按钮——
裸应用判别器（零 Capacitor 纯 `UNUserNotification`）复现同款缺失，定性**平台回归非插件
问题**。按钮断言已转 `XCTExpectFailure` **自更新监视器**（`app-ios-spike.yml`）：
回归存在套件绿，**Apple 修复后套件自动变红报警——变红即是推进 APNs 的信号**。
**APNs 服务端接入与 $99 账号暂缓**（推送落地的是同一层坏掉的 ShortLook）；
iOS 当前替代路径：通知点正文进 app 内审批（两步，永远可用）。

**待办（按优先级）**：
1. **等监视器变红** → 启动 iOS APNs 接入（$99 账号 + `push.ts` 的 HTTP/2 + JWT 通道；
   载荷红线见下）与 TestFlight 一步审批验收
2. **Android 15+ 的 `dataSync` FGS 配额**（6h/24h，全天挂监听会被强停且配额内禁重启）：
   评估 specialUse 类型或到点提醒兜底——上架前必须定案
3. ~~**客户端 attach 对齐**~~ ✅ 已做（2026-09-19，随 13.4 批次 A）：attach 发送时清空本地
   审批集，重放集+后续事件重建（`useSessionSocket`）；e2e-mock 补「断线错过 resolved」用例
4. SSO cookie 由 configure 时快照改共享 `CookieJar`（轮转不再陈旧）；
   `configure` 拦截补发起源检查（白名单残余风险的纵深加固，research §6.2）
5. 上架材料（隐私声明：本地直连、无遥测——本身是卖点）；各 OEM 保活白名单引导

**价值**（2026-09-12 重排：第一条从「更可靠」这种软论据换成了硬论据，本方向优先级随之上调）：
- **iOS 上恢复一步审批的唯一路径**。iOS 原生通知支持按钮（`UNNotificationCategory` +
  `UNNotificationAction`）：Capacitor 侧 `LocalNotifications.registerActionTypes` 注册
  category，推送 payload 的 `aps.category` 带同一标识符，系统即渲染按钮，点击经
  `pushNotificationActionPerformed` 回传 `actionId`（`PushNotifications` 插件本身没有
  action API，但 category 机制跨插件通用——实施时先验证插件版本可靠性，必要时补原生
  delegate）。方向一的降级只把 iOS 从「做不到」救到「两步」；**回到一步必须走原生壳**。
  对一个把锁屏审批当核心卖点的项目，这条是**核心卖点的补全**——当前被 iOS 26 平台回归
  卡在最后一步（Android 侧同款机制已真机验证通过）。
- App Store / Google Play 上架 = 分发实体
- 分享面板、生物识别锁（可选）等原生能力解锁

**信任面取舍（必须记下来，否则将来会重新论证一遍）**：
iOS 的 Web Push 本来就走 APNs，换原生壳**不新增**第三方——这一点不构成阻碍。
真正的变化是载荷可见性：Web Push 是 aes128gcm 端到端加密的（Apple 读不到正文），
原生 APNs 推送的载荷 Apple 可读。审批通知的内容只有工具名 + 命令摘要 + 项目名，
且 ntfy/Bark/Server酱 通道本来就是渠道可读（见 `push.ts` 的 webhook 段注释），
故该取舍可接受；但**能力 URL 里的 secret 绝不能进 APNs 明文载荷**——
APNs 接入时推送只带 requestId，客户端持长期凭据回连本机裁决。

**验收（原定标准，实现现状）**：Android APK 侧载可用（连接/审批/推送全通）✅ 已达成；
iOS TestFlight 内测 ⏸ 被平台回归阻断，监视器在守。

**定论**：坚持「不自营 SaaS 云中继服务」的产品底线，但公网访问中「通知到了、锁屏按钮点不动」（蜂窝网络入站不可达）是当前最大的可用性断点。

**探索方案**：
1. **轻量自托管 Relay 脚本**：提供用户可在自己的便宜 VPS 上一键运行的极轻量反向打洞中继（仅做 TCP / WebSocket 的公网 rendezvous 与帧中转，不做业务解析）。
2. **端到端加密（E2EE）**：AnyPlane 服务端与浏览器客户端直接协商一次性会话密钥（如 X25519 + ChaCha20-Poly1305），中继 VPS 仅转发密文，无法窥视命令与代码内容，彻底保住本地主权与隐私防线。

## 方向九：Codex 会话 AI 标题

**问题**：Codex 线程无标题时侧栏只显示线程 id 前缀（如 `01a090c2`），多开无法区分；
Claude 侧有 `generate_session_title` 自动标题（2026-08-27 已接入），体验不对等。
`/rename` 手动可救（走官方 `thread/name/set`），但无人记得改。

**上游调查结论（2026-09-11，codex 最新源码快照 + 0.149.0 实测）**：app-server 协议
**只有手动命名**（`thread/name/set` + `thread/name/updated` 通知），没有任何自动标题生成机制；
云端 tasks API 的 `has_generated_title` 是云任务特性，不在本地协议面。
上游若补齐自动命名，`thread/name/updated` 通知会让列表自动接住——届时本方向直接作废。

**可行路径（未做）**：复用 handoff 的 ephemeral fork 问答（`runEphemeralQuestion`，
只读沙箱 + 无审批，不动现场）——首个 turn 完成后让它用一两句话概括会话目标，
再 `thread/name/set` 写回。触发条件对齐 Claude 侧（首条真实 user 消息 × 首个 turn 完成，
按 threadId 去重；AnyPlane 侧不落状态，thread name 即唯一状态源）。

**暂不做的原因**：标题质量依赖一次额外问答（每新线程几百 token 成本），且 fork 问答
在 turn 刚结束时与主线程共享进程管道、可能撞上用户的连续输入；先观察上游是否补齐。
若做，必须复用现有 collector 超时/拒绝路径，不为标题引入新状态机。

## 方向十：UI 国际化（i18n）

**立项背景（2026-09-12）**：此前 UI 只有简体中文是可接受的——README 也是中文，受众一致。
2026-09-12 把 `README.md` 换成英文（中文移至 `README.zh-CN.md`）之后，**断层是我们自己制造的**：
官网英文、npm description 英文、README 英文、Show HN 稿英文，装上打开却是全中文界面。
英文用户读完英文文档再撞上中文 UI，落差比过去全中文时更刺眼。

**现状**：`web/src` 约 18,344 个中文字符，无任何 i18n 框架；另有硬编码 locale
（`ChatHeader.tsx` 的 `toLocaleTimeString('zh-CN')`）。服务端 API 错误是英文短码、
启动日志中英混合、`approvalPageHtml`（webhook/iOS 降级确认页）是中文——**确认页优先级高于主界面**，
它是 iOS 与 webhook 用户唯一会看到的服务端渲染页面。

**定论**：
- **不引 i18next / react-intl**。零第三方依赖是本仓库的既定约束（见 `log.ts` 的同款决策）；
  一个 `key → { en, zh }` 的扁平 map + 语言检测 + `t()` 足够，
  官网 `site/index.html` 的三语内联字典就是现成的形制参考。
- 语言检测顺序：显式设置（localStorage）> `navigator.language` > en。
  **默认英文**——中文用户会主动切，英文用户不会找切换入口。
- 抽取按可见度排序：确认页 → 审批卡与错误文案 → 会话列表 → 详情抽屉 → 低频面板。

**排期约束（重要）**：**放在拿到第一批英文反馈之后**，不要提前做。
18K 字符的抽取是纯体力活，为一个还没人用的界面做翻译是典型的沉没成本。
先发布、先看有没有英文用户真的装上，再决定抽取范围。

## 方向十一：分发与首次上手补完

**已于 2026-09-12 / 09-14 全部交付**（Dockerfile、双后端登录状态页、公网配方一键脚本，
交付记录见 [delivered.md](delivered.md)）。原位保留的唯一待评估项：
**把 `bun` 放进 `optionalDependencies`**，让 `npx anyplane` 彻底零门槛。
代价是包体积从当前量级涨到约 90MB。**先用 launcher 收集数据再决定**——
如果安装失败反馈消失，说明一行安装提示已经够了，不必付这个体积。

## 方向十二：上量前的运行韧性与下一轮技术债

前三项（全局异常兜底、Codex 上帝文件拆分、编排层风险补测）已于 2026-09-12 完成，
见 [delivered.md](delivered.md)。剩下一项只做了隔离实验与方向选择，**尚未修改生产路径**：

**会话列表 O(n) 隔离实验（只定方向，不实现）**：Windows x64 / Bun 1.4.0，
每档 7 组独立路径制造 AnyPlane 元数据缓存 miss（未清 OS 文件缓存），热路径各 40 次。
128KB transcript 下，10 / 100 / 200 / 500 会话的全 miss p50 为
**2.7 / 13.4 / 25.3 / 60.3ms**、p95 为 **66.7 / 98.6 / 96.2 / 137.8ms**
（7 个样本下 p95 接近最大值，主要用于暴露抖动）；热缓存 p95 为
**0.7 / 2.8 / 6.0 / 16.7ms**，每轮仅 1 个活跃文件失效时 p95 为
**0.7 / 3.7 / 6.1 / 17.5ms**。100→500 会话增长 5 倍时，两条稳态路径分别增长
约 6.0 倍与 4.7 倍，说明在这组 fixture 上会话数量是主要缩放变量，但实验没有进一步
拆开目录枚举、stat、排序与对象构造各自占比。

固定 100 会话时，4KB / 128KB / 1MB / 10MB 四档的全 miss p50 为
**8.5 / 13.4 / 13.1 / 23.3ms**、p95 为 **70.8 / 98.6 / 76.9 / 89.8ms**；
热缓存 p95 为 **3.0 / 2.8 / 3.3 / 3.5ms**，单文件失效 p95 为
**3.7 / 3.7 / 3.8 / 4.7ms**。源码每次 miss 固定只读头尾各 64KB，加上文件放大
2,560 倍而单文件失效 p95 仅约 1.3 倍，足以否定旧的"全文件读取导致
O(会话数 × 文件大小)"表述；但稀疏文件与未清 OS 缓存会影响绝对数值，不能据此宣称
已单独测出某个文件系统步骤的占比。

**推荐顺序（本机基准，不是通用阈值）**：现在不优化；先监控真实 `/api/sessions`
延迟与用户反馈。若稳态 p95 明显越过当前基线，再验证 1–2 秒短 TTL + single-flight
是否能合并多标签页重复扫描；只有单次扫描本身仍超预算时才评估目录级增量索引/监听，
不直接上 watcher。7 组唯一路径累计后的 RSS 增量为 21.7 / 46.9 / 61.6 / 95.8MB，
它混合了 JIT、分配器与缓存留存，不能当作单个 10 / 100 / 200 / 500 会话工作集；
只能提示长期高 churn 场景需另做可回收性实验，再决定是否给 `metaCache` 加容量上限。

## 方向十三：结构性债务偿还（外部架构评审的行动项）

> **进度（2026-09-19）**：13.1 / 13.2 已交付（`@anyplane/protocol` 单一类型正本 +
> Biome 红线规则进 CI）；13.3 已交付（capabilities 声明化 + portFor 注册表化解环 + routes 收口，
> 见小节末尾）；13.2 遗留的 e2e mock CLI 已随 13.3 同分支进 CI；13.4 待排期；
> 13.5 时机红线不动；13.6 完成（「合并后自动删分支」已启用）。

**立项背景（2026-09-17）**：一次外部视角的全量架构评审，
完整发现与证据见 [audits/2026-09-17-architecture-review.md](audits/2026-09-17-architecture-review.md)
（九条结构性发现 + 分支清理清单 + 未覆盖面）。本节只记**做什么、什么顺序、为什么是这个顺序**。

**两句话根因**（决定了下面的排序）：
1. **用文档和纪律替代了类型与工具**——时序红线、依赖红线、模块环安全性只活在注释里，
   工具链完全不参与执行。`AGENTS.md` 写得好不是解药，它本身就是症状。
2. **把 Claude 协议当成了中立契约**——`vendor-neutral` 是定位，实现是 vendor-anchored。
   代价在第三个后端接入时集中引爆。

### 13.1 抽 `@anyplane/protocol` 共享包（P0）

**问题**：web 与 server 各手写一份类型，7 组逐字重复；且**不对称**——
web 有完整 `ServerEvent` 20+ kind 联合，server 侧是 `broadcast(payload: unknown)`。
加新事件只有前端会编译报错。`InboxEvent` **已经漂了**（server 声明 4 种，
`push/inbox.ts:50` 运行时发第 5 种 `snapshot` 且绕开类型闸门）。

**做法**：新建 workspace，收敛 `ServerEvent` / `ClientCommand` / `SessionState` /
`HistoryBlock` / `HistoryMessage` / `ApprovalDecision` 等为单一正本，`broadcast` 改判别联合。

**为什么排第一**：纯类型迁移，零运行时风险，且 `tsc --noEmit` 会自动把所有已漂之处一次暴露。
这也是 `lib/ingest.ts`「唯一实现，消灭行为分叉」原则的同一思路，向类型层推广。

**交付（2026-09-17）**：`protocol/` workspace 落地（纯类型零运行时，`import type` 编译期擦除，
npm 发布面不含本包）；`broadcast`/`HubServices`/`statusOf`/`pushCliRing` 全链路判别联合化。
tsc 如预期暴露了全部已漂点并就地修复：inbox `snapshot` 变体入联合、`/api/config` 的
`authRequired` 补声明、lineage nodes 诚实化为 `LineageNode`（服务端从未发过 `mtime/status/
managed`）、`rewindPending` 确认为前端未消费的死字段（入类型并标注预留）。

### 13.2 装 linter 并把红线写成规则（P0）

**问题**：20,930 行生产代码无 ESLint / Biome / Prettier。
而仓库有几十条无法被类型表达的红线——「`ensure` 函数体到 return 前禁止出现 await」
（`backends/port.ts:130`）、「适配器绝不 import hub 编排层」、「routes 禁止直连具体 port」。
**唯一能机械守住它们的工具没装。**

**做法**：Biome（devDependency，不违反零第三方运行时依赖约束）+
`no-restricted-imports` 落地依赖红线；时序红线需自定义 AST 规则或改造 API 形状
（把 `ensure` 的同步部分拆成显式同步方法，让"禁止 await"变成"这里没有 Promise 可 await"）。

**附带发现**：15 个 e2e 脚本全部不在 CI，而私有 subtype（`side_question` /
`generate_session_title`）的唯一防线就是 e2e——最脆弱的部位防线是手动的。
不需要真实模型调用的部分（审批链路、WS 补发、`/clear` 重键）应以 mock CLI 搬进 CI。

**交付（2026-09-17）**：Biome 2.5 落地，`bun run lint`（`biome ci`）进 CI 双平台矩阵。
规则哲学定型为「只守 bug 类与红线」：formatter / organizeImports / 纯风格规则一律关闭
（仓库风格本就一致，60+ 文件装饰性 diff 换不来 bug 预防）。四条依赖红线写成
`noRestrictedImports` 并探针实测命中（适配器↛hub、hub↛push、routes↛具体 port、
protocol 不出包；两处存量违列入豁免清单，13.3 后移除）。**未覆盖**：时序红线
（ensure 零 await）——GritQL 插件实测匹配不到 class 方法定义（Biome 2.5 限制），
维持注释守护，根治留待 API 形状改造。**e2e mock CLI 进 CI 已交付（2026-09-19，随 13.3 同分支）**：
`server/scripts/mock-claude.ts`（claude headless stream-json 最小模拟）+ `e2e-mock.ts`
（自启临时服务端，`ANYPLANE_CLAUDE_PATH` 注入 + `CLAUDE_CONFIG_DIR` 隔离），覆盖 WS 全链路 /
审批裁决 / fromSeq 补发 / `/clear` 三层重键，进 CI 双平台矩阵。
首跑顺手清掉存量卫生问题（死变量/死 import、39 处缺 `type` 的 button、async
Promise executor、隐式 any let 等）。

### 13.3 `BackendPort` 能力声明化 + 解模块环（P1）

**问题**：30 个方法中 6 项对 Codex 是 no-op 或运行时拒绝
（`codex/port.ts:37,108,111,112,160,211`）；`SessionHandle` 用可选属性 + TS 结构类型
「让 ClaudeSession 无需改动即兼容」（`backends/port.ts:66-72` 注释原文），
抽象是事后套上去的。能力差异只在运行时暴露，前端只能靠散落的 `isCodex` 硬编码。

**做法**：接口加 `capabilities` 声明，前端按能力渲染；`portFor` 改注册表
（`registerBackend(name, port)`，装配层注入）——与既有 `initBackendPorts` 同一模式，
顺带解掉 `port.ts ↔ claude/port.ts ↔ codex/port.ts` 的 import 环；
routes 一律经 `portFor`（现 `routes/sessions.ts:101` 用 `body.backend === 'codex'` 硬编码）。

**交付（2026-09-19）**：`BackendPort.capabilities` 落地（fileCheckpoint/branch/tailer/aiTitle/
externalGate/queries/modelCatalog），随 `SessionState` 经 statusOf 统一下发；前端按能力渲染
（查询按钮白名单/分叉入口/详情默认查询，替换散落的 isCodex 硬编码推断），codex 侧 6 个
no-op/运行时拒绝方法删除，hub 层按能力把关（`?.` 守护 + 统一拒绝文案）。`port.ts` 改契约叶子：
`registerBackend`/`backendPort` 注册表由装配层注入，`port.ts ↔ 适配器` import 环解除；
routes 的 sessions/misc 存量清零，Biome 红线③豁免清单移除（仅 routes 测试因注册真实适配器
豁免 `*.test.ts`）。顺手修掉一个存量 bug：显式 `claudePath` 配置此前参与 PATH 候选的
`.exe` 偏好竞争，`.cmd` 会被常见安装位静默抢走。

### 13.4 `Hub` 状态机化与前端 store 化（P2）

> **批次进度**：批次 A（审批链路对齐，2026-09-19）✅——客户端 attach replace 对齐 +
> 「断线错过 resolved」e2e 用例。**持久化缺口的结论修正**：重启后审批悬挂的正确解法是
> replace 对齐（服务端 pending 为唯一权威、attach 重放重建），而非 pendingApprovals 落盘——
> AnyPlane 的 pending 只来自自 spawn 的 CLI，服务端重启即进程死、上游请求已不存在，
> 落盘只能做「失效标记」而无裁决价值，replace 对齐后该场景自动收敛（零新状态零格式维护）。
> 批次 B（Hub 显式状态机化）与批次 C（前端 store 化）待排期。

- **`Hub`**：17 字段 14 个可选，每个可选字段是一个隐式状态位，类型不阻止非法组合。
  `hub/socket.ts:54-63`「按客户端成员资格找回 hub」已是补丁上的补丁。
  改为显式 `phase` + 各 phase 独有数据。
  **另有持久化缺口**：`pendingApprovals` 全内存，重启即审批永久悬挂且无自愈路径。
- **前端**：`Chat.tsx` 20 个 `useState` / 7 个 `useRef` / 4 个 `useEffect`；
  `Composer` 32 props、`ChatHeader` 31 props；`ref + state` 双写贯穿全局。
  双写的**理由正当**（WS 回调在渲染外触发，state 闭包会取到过期值），
  但缺统一机制，漏一处即状态撕裂。用 `useSyncExternalStore` 或同形自实现正规化。

### 13.5 中立领域事件模型（P3，战略）

引入 `AgentEvent`，把 Claude stream-json 降级为「其中一个 adapter 的 wire format」，
Claude 与 Codex 各自 adapter 翻译进来。这是让 vendor-neutral 从 slogan 变成事实的唯一路径，
也是接第三个后端（Gemini CLI / Cursor CLI 等）的前置条件。

**时机红线**：在确定要接第三家**之前**不要动——两后端时现有决策的收益是真的；
但必须在接之前动完，**不能等接的时候临时改**。

### 13.6 仓库卫生：打开「合并后自动删分支」（随手做）

2026-09-17 已清完当时的可删远端（清点与判定见审计文档附录 A）。
2026-09-19 「Automatically delete head branches」已启用——机器评审流程新建的
带时间戳分支（`claude-code-review-*` 等）合并后自动删除，不再堆积。

### 明确不在本方向内

- **单实例 / 单租户假设**（`homedir()` 硬编码、单一静态 authToken、Docker 跑 root）
  **不改**。作为本机个人工具这些取舍成立且已写进文档。
  记录它只为标注分界线：若将来出现团队共用方向，租户维度必须在那个方向**动工之前**
  作为参数留出来，不能等 `homedir()` 散布到二十个文件后再抽。
- **独立安全评审**不并入本方向，仓库有专门流程。

## 抄本窗口化 / 虚拟列表（方向七的后续可选优化）

尾部窗口化已上线（`useTranscriptScroll` + `transcriptWindow`，验收 fixture
`web/transcript-fixture.html` 四段场景全绿）。**三条设计红线、两次回退的根因与交付明细
见 [research/2026-09-12-transcript-windowing.md](research/2026-09-12-transcript-windowing.md)**
——改这块代码前必读，红线摘要另见 AGENTS.md 前端章节。

以下四条只记录，不动手：

1. **向下收缩**：读到顶部后裁掉尾部行，让 DOM 在任意阅读位置都有界（现策略只向上生长，
   翻到顶即全量挂载）。需要底部锚定 + 回底恢复路径，复杂度比第三版高一档，等真实超长会话
   （>500 行）使用反馈再评估。
2. **codex 客户端侧分页**：目前服务端分页读全再一次性下发，超长 codex 线程首载 payload
   若成问题再做。接通时必须同时放开哨兵/onReachTop 的 codex 关门（F8 修复处），否则没入口。
3. **子代理侧链转录翻页**：`SUBAGENT_HISTORY_LIMIT=150` 是首载防 payload 爆炸的取舍，
   深挖老 agent 完整转录需要桶内翻页，等需求出现再做。
4. **翻页预取**：windowStart 接近 0 时提前拉下一页，消掉翻到顶后的加载等待感（纯体验项）。

## 已验证但暂不做的（决策记录）

本节只保留**决定不做**的理由；同批调查中已落地的部分（`claude agents --json` 状态增强、
MCP 管理面板、`generate_session_title` 控制通道）见 [delivered.md](delivered.md)。

- **daemon control.sock 深度集成**：协议 proto 版本锁死，只能 opportunistic 增强，不当基石。
  （同批的 `claude agents --json --all` 状态增强已接入，独有价值是 `kind:background` 后台 agent
  的存活状态。）
- **codex token_budget**：thread/goal/set 协议字段已透传，UI 不做——token ≠ 钱，
  预算心智账户建不起来；等真实无人值守批处理场景出现再点亮。
- **codex `permissions` named-profile 迁移**：`sandboxPolicy` 未 deprecated，不急；
  迁移时注意 `sandboxPolicy` 与 `permissions` 互斥不能同发。
  升级 codex 前跑 `bun run server/scripts/check-codex-schema.ts`。

## 更远的地平线（只记录，不动手）

两家官方都在建各自的 agent 互联（claude 2.1.224 跨会话 SendMessage/ListAgents；codex remoteControl/pairing），
但都是围墙花园。AnyPlane 同时长在两家协议上，是唯一可能成为**跨供应商 agent 消息路由**的位置。
handoff 是这个路由的雏形（一次性、单向、带上下文）；成熟形态是双向持续消息总线。
等两边协议出 research preview 再评估；lineage.json 字段设计不要锁死在"一次性接力"模型上。
