# AnyPlane 后续规划（ROADMAP）

> 2026-08-24 立。前置：统一 Agent 控制面 8 阶段计划已全部完成（见 [plans/unified-agent-plane.md](plans/unified-agent-plane.md)）。
> 本文档收录已讨论定论、待排期的方向；每条附决策依据，避免将来重新论证。
>
> **本文只保留未来时**（2026-09-12 拆分）：待排期方向、决策依据、明确不做的记录。
> 方向标记完成后，交付记录迁往 [delivered.md](delivered.md)，本文原位只留索引行；
> 上游 CLI 行为的实测结论迁往 [research/](research/)。**方向编号永不回收也永不重排**——
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

## 方向二：App 壳（Capacitor，不换技术栈）

**定论**：不做 RN 重写（代码翻倍、维护翻倍，happy 的路线不是我们的路线）；
用 **Capacitor 套壳现有 PWA** 打出 iOS/Android 原生包——日常开发仍是写 React，新增的只是构建链。

**价值**（2026-09-12 重排：第一条从「更可靠」这种软论据换成了硬论据，本方向优先级随之上调）：
- **iOS 上恢复一步审批的唯一路径**。iOS 原生通知**支持**按钮（`UNNotificationCategory` +
  `UNNotificationAction`）：Capacitor 侧用 `LocalNotifications.registerActionTypes` 在启动时注册
  category，推送 payload 的 `aps.category` 带上同一标识符，系统即渲染按钮，点击经
  `pushNotificationActionPerformed` 回传 `actionId`（`PushNotifications` 插件本身没有 action API，
  但 category 机制跨插件通用——实施时先验证插件版本的可靠性，必要时补原生 delegate）。
  方向一的降级只把 iOS 从「做不到」救到「两步」；**回到一步必须走原生壳**。
  对一个把锁屏审批当核心卖点的项目，这条从「里程碑性质的目标」升级为「核心卖点的补全」。
- App Store / Google Play 上架 = 分发实体
- 分享面板、生物识别锁（可选）等原生能力解锁

**信任面取舍（必须记下来，否则将来会重新论证一遍）**：
iOS 的 Web Push 本来就走 APNs，换原生壳**不新增**第三方——这一点不构成阻碍。
真正的变化是载荷可见性：Web Push 是 aes128gcm 端到端加密的（Apple 读不到正文），
原生 APNs 推送的载荷 Apple 可读。审批通知的内容只有工具名 + 命令摘要 + 项目名，
且 ntfy/Bark/Server酱 通道本来就是渠道可读（见 `push.ts` 的 webhook 段注释），
故该取舍可接受；但**能力 URL 里的 secret 绝不能进 APNs 明文载荷**——
原生壳应改为推送只带 requestId，客户端持长期凭据回连本机裁决。

**步骤草拟**：
1. `bun add @capacitor/core @capacitor/cli`，`npx cap init`（构建产物指向 `web/dist`）
2. 壳内服务器地址配置页（首次启动填 `https://xxx.ts.net` + token；现在 PWA 靠 URL 参数）
3. 推送插件接入（`@capacitor/push-notifications`），复用方向一的登记端点
4. iOS 需要 $99/年开发者账号；Android 可直接侧载 APK 先行
5. 上架材料：隐私声明（本地直连、无遥测——这本身是卖点）

**验收**：Android APK 侧载可用（连接/审批/推送全通）；iOS TestFlight 内测。

## 方向八：自托管 Outbound Relay 与端到端加密（E2EE）评估

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

**立项背景**：生态研究的 Phase 1 清单里，功能性主项（审批规则引擎）已交付，
剩余项**全部是分发与首次上手类**——与 2026-09-12 实测出的三个卡点同源，
独立佐证了「瓶颈在可达性而非能力」。这一类此前只存在于研究库的 CHANGELOG，
主仓库排期文档里没有位置，故立此方向。

已交付项（npm bin 改 Node launcher、README 英文化）见 [delivered.md](delivered.md)。

**待排期**：
- **Dockerfile**（优先级最高）：单阶段 Bun 镜像 + 双 CLI，挂载 `~/.anyplane` 与 CLI 凭证卷，
  入口命令与 `bunx anyplane` 一致。对自托管人群是标配，且顺带绕开 Bun 门槛。
- **双后端登录状态页**：Claude 走 `initialize.account` 或配置目录探测，Codex 走 `account/read`
  或等效 RPC；列表页展示「Claude 已登录 / Codex 未登录 / API-key 组织用户」。
  降低首次使用门槛——当前 CLI 未登录时的失败表现为会话起不来，用户不知道该去登录哪个。
- **公网配方一键脚本**：封装 `docs/public-access.md` 三套配方的最小启动命令，
  脚本只负责隧道创建与反代，不碰账号体系（保住「不依赖第三方账号」的底线）。
- **待评估：把 `bun` 放进 `optionalDependencies`**，让 `npx anyplane` 彻底零门槛。
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
