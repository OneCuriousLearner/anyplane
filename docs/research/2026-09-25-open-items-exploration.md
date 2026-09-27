# 三个开口项的探索结论：SW 缓存疑云 / Codex AI 标题 / @ 文件补全

2026-09-25。本文只记录探索与结论，**未改任何功能逻辑，未提交**。证据来源：当前源码快照 + 本机生产构建下的 chrome-devtools 实测 + 两个上游参考仓库（Codex GitHub 源码快照、Claude Code v2.1.88 快照）。

## 一、「service worker 缓存旧 bundle」——归因有误，SW 无缓存行为，逻辑必须保留

### 1.1 注释与历史：SW 从未缓存过任何东西

`web/public/sw.js` 现行注释原文：

> service worker：PWA 可安装性 + Web Push 接收与点击。**不做离线缓存——数据面全部走网络，缓存陈旧数据只会误导。**

翻 git 历史，该文件**从诞生第一个提交（PWA 那笔）起就是同一句话**（当时措辞：「最小 service worker：满足 PWA 可安装性（add to home screen）。不做离线缓存……」），此后所有改动都是 push / 审批通知相关，没有任何一版引入过 Cache API 或 fetch 缓存。注册处（`web/src/main.tsx`）只裸注册，无任何缓存选项；`fetch` 监听器是空壳（`() => {}`）。

SW 承担的两件事，缺一不可：

1. **PWA 可安装性**——Chrome 的安装判据要求存在带 fetch 处理器的 SW（空壳即为此而设，非缓存）；
2. **Web Push**——`push` 事件渲染通知（含 `maxActions` 降级、同源闸）、`notificationclick` 一键裁决/深链。**iOS 的 Web Push 只在「已添加到主屏」的 PWA 内可用**（`docs/configuration.md` 已有记录），所以「可安装性」不是锦上添花，是 iOS 推送的前置条件。

### 1.2 缓存策略的正主在服务端，且由来有案

`server/src/index.ts:84-89` 的 `staticCacheHeaders`：默认一律 `no-cache`（HTML / `sw.js` / manifest 都是「设备是否最新」判别面），只有 hash 命名的 `/assets/` 给 `immutable`。引入原因在 `docs/research/2026-09-18-capacitor-shell-pitfalls.md` §5 有记录：原生壳 WebView 缓存住旧 `index.html` 的实机事故。实测响应头确认该策略在跑：`/` 与 `/sw.js` 均为 `Cache-Control: no-cache`（无 ETag/Last-Modified，即每次全量重取），资产为 `immutable`。

### 1.3 实测复现（2026-09-25，生产构建，chrome-devtools）

| 步骤 | 结果 |
|---|---|
| 控制中的页面执行 `caches.keys()` | **空数组**——SW 零缓存，现场确证 |
| 构建 A → 临时改源文件重建出构建 B（hash `BOyTsAXB`→`BvaTCu1Q`），服务端**不重启**，普通 reload | 页面**立刻拿到 B**，文档走网络（navigation transferSize 1526） |
| 带 `#s=` 的页面 URL 做同 URL 导航（MCP `type=url`） | **同文档导航，文档根本不重载**——探针 `window` 变量原样存活 |

**结论**：正常刷新路径下「SW 缓存旧 bundle」无法复现。当年三连踩的症状（页面一直跑旧代码、硬刷即好）有一个完全自洽的解释：**页面没有被真正重载**——旧文档 + 旧资产被 `immutable` 缓存兜住 → 旧代码持续运行；而真正的 reload 一定拿到新文档（已实测）。当时的具体触发动作（同文档导航？未刷新的旧标签页？）已不可回放，但所有代码证据（SW 零缓存、服务端 no-cache 且实测生效）都排除了 SW。

### 1.4 判定与建议

- **保留 SW 全部逻辑**。它不是缓存设施，是推送与可安装性的载体；删空壳 fetch 处理器丢可安装性，删 SW 丢推送（含 iOS 推送闭环）。
- **可选硬化（一行，零风险）**：注册时加 `{ updateViaCache: 'none' }`。理由：`sw.js` 脚本自身的更新仍受 HTTP 缓存影响（浏览器最多认 24h）；自家 server 给 `no-cache` 已正确，但若将来部署到第三方静态托管/反代/CDN 之后，其缓存头不再受我们控制，`updateViaCache: 'none'` 让浏览器对 SW 脚本永远绕开 HTTP 缓存。若确认自托管是唯一部署形态，可不做。
- **测试纪律修正**：核对 bundle hash 前必须真 reload（`Page.reload` / `location.reload()`）；「导航到页面 URL」在带 hash 时是同文档导航，不重载、不换 bundle。不要再把此类现象归因 SW。

## 二、Codex AI 标题——上游有，但在 TUI 客户端侧；可完整复刻，不需等上游

### 2.1 上游确认（Codex GitHub 源码快照）

- AI 标题逻辑**存在**，但完全在 **TUI 客户端**：`codex-rs/tui/src/app/thread_title.rs` + `temporary_structured_request.rs`（2026-08-24 合入，PR #40492）。app-server / core / thread-store 里**没有任何标题生成逻辑**——服务端只做两件事：`thread/name/set` 落库校验、`thread/read`/`thread/list` 读出 `name`。
- 因此 `docs/ROADMAP.md` 方向九「上游没有任何自动标题生成机制」半句已过时（「协议面只有手动命名」半句仍然对）。本次不改 ROADMAP，指针留在这里。
- **desktop 客户端不在源码仓库**（仓库内只有打开它的 deep link）。它的标题只能由其客户端自己生成——机制上最可能就是同一套（见下），即：**上游没有任何服务端能力可等，AnyPlane 自研不与其冲突**（都写 thread store 的 `name`，谁写都互通）。

### 2.2 上游机制（全部由公开 RPC 组合，值得照抄的细节）

- **触发**：线程**尚无 name** × 收到首个 `ItemCompleted(userMessage)`。**不等 turn 完成**，与主 turn 并行（上游自己注释承认会与主 turn 竞态，靠"写回前复查"兜）。手动 rename 会取消 pending 生成；按 (threadId, 目标) 去重。
- **生成**：起一个 **ephemeral 隐藏线程**（`thread_source:"thread_title"`、approval `never`、sandbox read-only、配置里 apps/hooks/memories/插件/工具/MCP 全关、超时 30s、响应上限 8KiB）→ `turn/start` 带 **`output_schema`**（`{title: string, minLength:1, maxLength:36}`）与低 effort → 收 agentMessage 文本。
- **模型**：优先专用小模型（仅特定 provider + 账号条件满足时），否则**退化为当前会话模型**。
- **写回双保险**：`thread/read`（不含 turns）复查 `name` 仍为空 → `thread/name/set`。另有一条服务端规则：**name 与 preview 相同则拒绝设置**（防「标题=首条消息」的无信息量结果）。
- **prompt 约束**：单行、尽量 ≤5 词、祈使动词开头、保留 ticket 编号、用用户语言、不要引号/markdown/句末标点、**不要回答请求**；标题 ≤36 字符。
- 上述用到的协议字段（`ephemeral`、`thread_source`、`output_schema`、`effort`）**均非 experimental**。

### 2.3 协议面可用性（AnyPlane 侧）

- 可读：`thread/name/updated` 通知 + `thread/read` / `thread/list` 的 `name`（已在用）。**缺口：`thread/name/updated` 目前被静默丢弃**（`server/src/backends/codex/session.ts` 的通知 default 分支，连日志都没有）——外部改名（TUI/desktop/将来我们自己写回）时已 attach 的会话不会实时更新，只能等列表轮询接住。
- 可写：`thread/name/set`（斜杠 `/rename` 已在用）。
- 没有「给我生成标题」的 RPC——上游自己也是用上面那套通用原语拼的。

### 2.4 「首条消息后另发一个标题请求」的三条路径

| 路径 | 做法 | 代价 / 风险 | 结论 |
|---|---|---|---|
| **A（推荐）** | 照抄上游：ephemeral 线程 + `output_schema` + `thread/name/set`，与主 turn 并行 | 一次极小模型调用（prompt ≤960B、输出 ≤36 字符）；**零污染**（ephemeral 不落 rollout、不进行史）；风险只有账号速率额度 | 采纳 |
| B | 复用现有 `runEphemeralQuestion`（fork 源线程问一句） | 无 `output_schema`（自由文本要另解析、可能被"顺手回答"）；必须先 fork；与主线程同管道易撞车 | 备选 |
| C | `codex exec` 一次性子进程 | 进程冷启动慢；绕开 app-server 审批/沙箱统一口径；忘带 `--ephemeral` 会凭空多出一个真实线程 | 否决 |
| — | 让主线程自己在后续 turn 吐标题 | 污染主线程历史与上下文占用 | 明确否决 |

### 2.5 若做，需先补的缺口与决策点

1. 接住 `thread/name/updated` 并广播（复用 `thread_reverted` 的 system 消息范式即可）；
2. 触发点用现有 `afterUserSent` 钩子（首条真实 user 消息写入后、与主 turn 并行）；
3. 写回前 `thread/read` 复查 `name` 为空；用户手动改过名的不会再被覆盖；
4. 按 threadId 去重，不引入新状态机；
5. `capabilities.aiTitle` 从 `false` 翻真值；前端 `title ?? lastPrompt` 兜底链天然接住，无需改动。

**需要拍板的点**：这会给每个新会话新增一次真实模型调用（成本 + 速率额度），且触发时机与上游一致（首条消息落地即并行发起，而非等 turn 完成）。产物、污染与失败模式都已摸清，是否做、何时做由用户定。

## 三、@ 文件补全——代码照搬不了，思路与纯函数可搬；可复用面比预期大

### 3.1 两家上游的机制

| | Claude Code v2.1.88 快照 | Codex（GitHub 源码） |
|---|---|---|
| 索引位置 | **客户端**（TUI 进程内） | **服务端**（app-server 进程内） |
| 数据采集 | `git ls-files --recurse-submodules`（5s 超时，必须 `core.quotepath=false` 防中文路径转义）→ 后台补 `--others --exclude-standard` 合并 → 非 git 仓库回退 ripgrep；目录名也从文件路径反推进索引 | `ignore` crate 并行遍历（`require_git(true)` 对齐 git 语义） |
| 匹配 | 自研 TS 版 nucleo 移植：a-z bitmap 预筛 + gap-bound 剪枝 + 边界/camelCase 加成 + top-15 二分插入 | 真 nucleo-matcher，结果带 `indices` 匹配下标（可直接做高亮） |
| 增量/性能 | 4ms 时间分片渐进可查；`.git/index` mtime 触发刷新 + 5s 兜底节流；采样签名跳过重建；输入 50ms debounce | nucleo `reparse(append)` 增量 + 快照节流；无 debounce |
| 协议暴露 | **无**——headless / SDK 全零命中，`@path` 只是普通文本 | **有**——`fuzzyFileSearch` 等 4 个 RPC + 2 个通知（标注 experimental） |

### 3.2 AnyPlane 的照搬面

- **可白拿（codex 会话）**：透传 `fuzzyFileSearch/sessionStart|sessionUpdate|sessionStop`（app-server 已在托管），服务端算好的模糊匹配 + 高亮下标直接到手。**必须自加 root 闸**：上游 `roots` 参数吃任意路径，透传前要锁定为该会话 cwd。
- **可移植（纯函数/形状）**：TS 版 `FileIndex`（370 行、无 IO 无依赖）；签名/节流/代际防陈旧那套刷新模式；`@` token 的 Unicode 正则（`\p{L}\p{N}\p{M}`，中文文件名天然支持）与 `@"带空格路径"` 形态。
- **必须自研**：服务端文件列举/索引接口（现有 `/api/fs/list` **只列目录、且无路径白名单**）；索引按会话 cwd 归属与多会话生命周期（claude-code 是单进程单 cwd 单例，没有对应物）；claude 会话下的索引（codex 的 RPC 用不上）。
- **UI 可复用**：Composer 的斜杠面板键盘语义（↑↓/Tab/Esc/Enter）已经就是 @ 面板要的那套。

### 3.3 难度与风险

- **工作量**：P0 只做「会话 cwd 单层列举 + 前缀补全」（走查原建议）≈1-2 天；P1 追加 codex 会话白拿模糊搜索 ≈+1-2 天；P2 服务端自建全库索引 ≈+2-3 天。
- **风险（按严重度）**：
  1. **路径暴露面升级**——从「目录名」升级为「全部文件名」（`.env`、`credentials.json` 这类名字会直接进列表）。必须锁死：root 由服务端按会话 cwd 反查，**不接受客户端传任意 root**；鉴权沿用现有 `/api/` 守卫。
  2. 大仓库索引性能与多会话内存（已知上游处理 27 万+ 文件量级）。
  3. `.gitignore` 语义（Windows `core.quotepath`、worktree 的 `.git` 是文件、子模块）；纯 JS 方案要引 `ignore` 包——触碰「零第三方依赖」红线，需走豁免或 shell out git。
  4. 中文文件名链路：`git ls-files` 必须带 `core.quotepath=false`；HTTP 侧 `searchParams.get` 已自动解码，**禁止二次 decode**（本项目踩过的坑）。
- **建议**：值得做，先 P0；P1 视 codex 会话占比；P2 上马前先定性能预算与索引淘汰策略。

## 四、汇总

| 项 | 结论 | 建议动作 | 规模 | 待用户拍板 |
|---|---|---|---|---|
| SW「缓存旧 bundle」 | 归因有误；SW 零缓存，逻辑必须保留 | 可选加 `updateViaCache:'none'` 一行硬化；测试纪律已修正（真 reload 再核对 hash） | 一行（可选） | 否 |
| Codex AI 标题 | 上游有（TUI 客户端侧）；可用公开 RPC 完整复刻，路径 A 推荐 | 先补 `thread/name/updated` 接住与广播，再实现生成链路 | 中 | **是**（每会话多一次模型调用的成本决策） |
| @ 文件补全 | 代码不可照搬、思路可搬；codex 会话可白拿 RPC | 先 P0（cwd 单层 + 前缀补全），P1/P2 进阶 | P0 小 / P2 中偏大 | 是（做哪个档位） |

本日实验探针（`main.tsx` 临时改动）已还原，工作区保持干净未提交；SW 现场实测所用 server 已停止。
