# 复杂度基线：巨石文件/神组件定性裁决记录

本文件是裁决状态的**唯一载体**。配套关系：

- **第 1 层（`scripts/complexity-report.ts`，纯无状态）**：行数 / 单函数长度 / hook 密度 / git 变更热点 → 输出全量命中清单。脚本不内嵌、不读取、不产出任何"基线/新增"概念；退出码 1 只表示"本次扫描有命中"。
- **第 2 层（本文档 + 人/LLM）**：报告与本文"现在时"两个表的**差集 = 新增嫌疑（NEW）**，由人 / LLM 计算并逐一定性裁决。拆分手术、入表、日志追加全部发生在这一层。

**判定标准（定性，非定量）**：巨石 = 职责混叠 + 状态纠缠 + 不可测三者叠加。反例见下表：
813 行的 translate.ts 比 195 行的 StatusPill 函数更健康——行数是信号，不是定义。
"改 A 必须理解 B"要分方向：同一领域不变量的两个面（健康，如配对索引与去重集）vs
多个独立职责互相渗透（异味，如斜杠命令业务住在页面组件里）。

## 2026-10-03 首轮全仓裁决

### 确认命中 / 边界（待手术或已排期）

| 文件 | 裁决 | 依据 | 处置方向 |
|---|---|---|---|
| web/src/pages/Chat.tsx | **边界神组件** | 单组件 687 行 / hooks=42；`runSlashAction` 十二分支斜杠业务逻辑住在页面层（L353-436）；详情抽屉域（L67-79、140-178）是自洽 query 状态机。6 个月 85 次变更 = 全仓第一热点，佐证"每次改都疼" | `runSlashAction` → `useSlashActions`；详情抽屉 → `useDetailDrawer`；达标后 ~500 行纯组合层 |
| server/src/backends/claude/processManager.ts | **轻度-中度巨石** | L40-134 五个纯函数（usage 推断 / transcript 尾扫 / 命令解析）与 ClaudeSession 零耦合，且 backend.ts 反向 import 它——分层错位实证；`handleLine`（L680-842，162 行）内联 5 条线索 | 纯函数组抽 usage.ts / resolve.ts；handleLine 分 noteXxx 私有方法 |
| server/src/backends/codex/session.ts | **边界** | 核心身份（状态机+事件编排+生命周期）属"单线程句柄"合理内聚，但输出合并缓冲（L943-984）、compact 补丁（L869-921）、改名回声（L97-108+L405-418）三块机制簇独立可抽，合计约 120 行 | 三个机制簇各自下沉；文件可降至 ~880 行 |

### 大但内聚，刻意不拆（已知集合）

| 文件 | 不拆的理由 |
|---|---|
| server/src/backends/codex/translate.ts | 纯协议映射层，21 函数服务同一条 ThreadItem→stream-json 映射；live/历史三口径共享私有计算是**刻意红线**（"同形，避免两侧漂移"），拆出反而引入漂移 |
| server/src/backends/claude/port.ts | 宽接口适配器，~25 方法全是薄委托；行数是 BackendPort 接口宽的线性结果 |
| server/src/backends/claude/discovery.ts | 单一数据源（磁盘真相）读盘契约面；两半共享刻意成对的词表不变量 |
| server/src/backends/codex/runtime.ts | 单 app-server 进程托管 + 线程注册表，RPC 域单一 |
| server/src/push/vapid.ts | 自实现 VAPID 单一职责 |
| scripts/gateway.ts | 网关编排单一职责 |
| web/src/components/Composer.tsx | 受控叶子组件：4 个 useState 互不纠缠，业务状态全上收（32 prop 已收敛为 4 域对象）。行数来自 4 个并列子功能的 JSX，拆分是机械性的非解耦 |
| web/src/hooks/useTranscriptIngest.ts | 单一职责 reducer 引擎；9 ref 高纠缠是领域不变量（配对/去重/分页坐标必须同事务更新）的固有属性；store/ref 分层已有纪律 |
| web/src/hooks/useSessionSocket.ts | WS 生命周期单一职责；长来自平台事件全枚举 |
| web/src/hooks/useTaskBuckets.ts | 任务桶状态机单一职责 |
| web/src/hooks/useTranscriptScroll.ts | 滚动窗口化单一职责，三条红线集中处 |

### 本轮新增告警，待巡裁定（尚未人工裁决）

以下文件命中定量阈值但未经第 2 层定性裁决，**不得直接当巨石处理**：

- web/src/pages/SessionList.tsx（hooks=34，变更 44 次——除 Chat.tsx 外最可疑）
- web/src/pages/DirPicker.tsx（hooks=26）
- web/src/App.tsx（hooks=11，组合根，可能是合理内聚）
- server/src/routes/sessions.ts、server/src/routes/misc.ts（路由注册函数长，可能是路由表的自然形态）
- server/src/hub/callbacks.ts、server/src/hub/messages.ts（Hub 消息分发）
- web/src/components/StatusPill.tsx、ChatHeader.tsx、DetailDrawer.tsx、ModeBadge.tsx、SessionGroupList.tsx（多为 JSX 体量或局部派生状态，嫌疑从低到中有序）

## 裁决日志（倒序，最新在上）

每轮复杂度处置（人工或 `claude-task.sh complexity-patrol`）结束后追加一节，与 drift.md
同范式：裁决清单（每个 NEW 文件一句定性结论）、手术内容、**不做的决策**（防止将来重新论证）。
上方的"确认命中/边界"与"大但内聚"表是"现在时"快照，随处置就地更新；轨迹只留在这里。

### 2026-10-03（首轮：人工 + LLM 联合全仓裁决）

定量初筛（行数 top-N 送深读）+ 双代理定性深读，覆盖当时全部 ≥500 行文件：

- **确认命中/边界**：Chat.tsx（边界神组件，全仓第一变更热点 85 次/6 月佐证）、
  claude/processManager.ts（轻度-中度，纯函数组分层错位）、codex/session.ts（边界，三块机制簇）。
  处置方向见上表。
- **不做的决策**（12 个）：translate.ts / claude/port.ts / claude/discovery.ts /
  codex/runtime.ts / vapid.ts / gateway.ts / Composer.tsx / useTranscriptIngest.ts /
  useSessionSocket.ts / useTaskBuckets.ts / useTranscriptScroll.ts——理由见上表，
  核心是"大但内聚"与"纠缠属领域不变量"两类，均已入上表。
- **定量探测的两个漏网浮出**：SessionList.tsx（hooks=34 + 变更 44 次）、DirPicker.tsx
  （hooks=26）——行数初筛选材时排不进候选，churn × hook 密度交叉后升至 P1。
  列入待巡裁定，由首个 complexity-patrol 任务处置。
- 体系落地：scripts/complexity-report.ts（定量层）+ 本文档（定性层）+
  .claude/tasks/complexity-patrol.md（LLM 巡检任务）+ 周三 CI 周报（开 issue 留痕）。

## 维护规则

1. **本文档是裁决状态的唯一载体**——脚本（`scripts/complexity-report.ts`）与 CI workflow 均为无状态，不内嵌、不读取任何基线；NEW = 报告命中 − 本文现在时表，由人 / LLM 计算。
2. 每轮处置（人工或 `claude-task.sh complexity-patrol`）对 NEW 逐一裁决：确认巨石 → 拆；确认命中暂不手术 → 入"确认命中/边界"表；大但内聚 → 入"大但内聚"表并写明不拆理由。
3. 每轮结束必须在"裁决日志"新增一节（倒序），含每个 NEW 文件一句结论与不做的决策；同步更新"待巡裁定"清单。
4. 重构瘦身后的文件从对应表移除（它不再命中阈值，自然会从报告消失）。
5. 阈值本身（500/150/10/20）调整须在 commit message 里说明动机——阈值漂移没有告警，只能靠纪律。
6. CI 周报（`.github/workflows/complexity-patrol.yml`，每周三）只负责有命中时开 issue **递送报告**，不做差集、不维护状态；issue 由人处置后关闭，评估结论以本文档为准。
