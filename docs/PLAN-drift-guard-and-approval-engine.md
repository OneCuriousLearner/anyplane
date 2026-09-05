# 规划：协议漂移预警自动化 + 审批规则引擎

> 2026-09-05 立。状态：**第一部分（漂移预警）已完成**（2026-09-05，首战即捕获 codex 0.149.0 真实漂移）；
> **第二部分 P1（规则引擎）已完成**（2026-09-06）。P2/P3 待排期。
> 前置侦察：docs/tier2-recon.md 第 2 节的三件设想（claude 快照 diff、codex generate-ts diff、回放 harness）经核实**已全部落地**，本规划的增量是「自动化 + 告警」，不是从零建设。

## 一、协议漂移预警自动化

### 现状（已存在）

| 资产 | 位置 | 缺口 |
|---|---|---|
| codex schema diff | `server/scripts/check-codex-schema.ts`（generate-ts → 752 文件基线入库，`--update` 重建） | 手动触发；不在 package.json scripts；无 CI |
| claude 协议 diff | `server/scripts/check-claude-protocol.ts`（快照 grep → `protocol-baseline.claude.json`） | 依赖本机快照仓库，CI 无法跑 |
| 回放 harness | `server/scripts/replay-fixture.ts` | **默认 fixture 在仓库外**，仓库内无签入的 .jsonl；未挂进 `bun test` |

### 目标

CLI 升级后**无需人记得**，协议漂移在引入风险前被发现并送达提醒。

### 方案

**1. 版本探测（服务端启动时，本地）**
- 启动时读 `claude --version` / `codex --version`，与 `~/.anyplane/protocol-checks.json` 记录的「上次通过检查的版本」比对。
- 发现版本前进且未跑过对应检查 → 控制台显著提醒（含一行复制即跑的命令），**不阻塞启动**。
- 检查脚本成功退出后自动更新该记录。

**2. CI 挂接（只做 codex 侧）**
- `.github/workflows/protocol-drift.yml`：每周定时 + 手动触发；`npm i @openai/codex` 装最新版跑 `check-codex-schema.ts`，漂移时开 issue 或失败告警。
- claude 侧不进 CI（依赖本地快照仓库），由版本探测在本地兜住。

**3. 告警投递**
- 漂移检出时复用 `fanoutPush` 的 error 通道 → webhook（Server酱/ntfy）直达手机："codex 0.154 协议新增 3 项待评估"。
- 配置开关 `driftAlert: true`（默认开，仅配置了 webhook/push 时生效）。

**4. fixture 入库**
- 把回放用 NDJSON 脱敏签入 `server/scripts/fixtures/`（当前默认路径指向仓库外，属于隐性依赖）；
- `replay-fixture.ts` 改为 `*.test.ts` 形态挂进 `bun test`，CI 常驻回归。

### 验收
- 升级 codex 后重启服务端 → 控制台出现检查提醒；跑完脚本记录落盘，二次启动不再提醒。
- 人为改动 codex 基线一个文件 → CI/本地检查 exit 1 且（配置 webhook 时）手机收到告警。
- `bun test` 包含回放 fixture 断言。

---

## 二、审批规则引擎

### 现状约束（侦察结论，决定设计边界）

- `PendingApproval = { requestId, toolName, input }`（server/src/index.ts:47）——**cwd 不在其中**（可经 sessionKey/spawnOpts 反查），**toolUseId 在 Hub 边界被丢弃**（types.ts 有、index.ts 回调没接）。
- 决策模型二元：`{behavior: allow | deny}`；codex 的 `acceptForSession` 仅在 `updatedPermissions` 存在时有映射后门（runtime.ts:732）。
- 能力 URL（推送一键审批）只接受 allow/deny（index.ts:1313）。
- **无审批超时清扫**：claude 侧靠 CLI 上游超时，codex 侧靠 `serverRequest/resolved`。
- `summarizeInput`（index.ts:157）已是"按工具提取裁决字段"的雏形，规则匹配应与它对齐而非另起一套。
- `permissionPolicy` 目前全局 ask/bypass 二元，且前端不消费它。

### 目标

把审批从"每条都问人 / 全部放行"升级为**按规则分流**：明确的常规操作自动放行、明确危险的操作自动拒绝、边界情况才推送问人。生态内官方只有 afk/yolo 二元粒度，这是空白点。

### 设计

**1. 配置形状**（`anyplane.config.json` 新增，数组有序、首条命中生效、兜底 ask）：

```json
{
  "approvalRules": [
    { "match": { "tool": "Bash", "command": "^(git status|git diff|git log|ls\\b)" }, "action": "allow" },
    { "match": { "tool": "Write|Edit", "path": "src/**" }, "action": "allow" },
    { "match": { "tool": "Bash", "command": "\\brm\\s+-rf\\b" }, "action": "deny" },
    { "match": { "tool": "WebFetch", "domain": "*.anthropic.com" }, "action": "allow" }
  ]
}
```

- `tool`：`| ` 分隔多值；匹配字段按工具分发——Bash→`command`（正则）、Write/Edit/Read→`path`（glob）、WebFetch→`domain`（后缀匹配）。
- 未知字段/坏正则：启动即报错（fail fast），不静默吞掉。
- codex 侧 input 已重塑为 `{command, cwd, reason}` 等形状，同一套规则天然兼容（`command` 字段同名）。

**2. 介入点**（P1 已实现，比原计划更好的一处覆盖）：`sessionCallbacks().onApprovalRequest`——两个后端共用的回调工厂，一处介入即覆盖 claude 与 codex，无需分别埋点。在 broadcast/publishInbox **之前**先过规则：
- `allow` → 直接 `sendApproval(allow)`，**不入 pending**；广播一条 `approval_auto` 事件（规则名+摘要）让 UI 在会话流里落一张"已由规则放行"卡（可审计，可一键停用该规则）。
- `deny` → 同上对称处理。
- `ask`/未命中 → 走现有全流程（pending + 广播 + 推送），不变。

P1 落地偏差记录：留痕卡复用系统消息渲染（灰底小字，语义一致，未做独立组件）；「一键停用该规则」按钮未做（留给 P3 与命中率统计联动）。

**3. 会话级「总是允许」（allow_session）**
- 前端审批卡加第三按钮「本会话总是允许」→ 决策带 `updatedPermissions`（claude: destination session 的 permission suggestion；codex: 已有后门映射 acceptForSession）。
- 需要扩展：processManager 的 can_use_tool 应答透传 suggestions（当前只透传 behavior）；`ApprovalDecision` 类型补 session 维度。

**4. 安全红线**
- 规则裁决只发生在服务端；配置热重载（改文件即生效，走 config watcher）。
- 每条自动裁决都留痕（会话流卡片 + 服务端日志），**规则引擎不进入推送/能力 URL 链路**（一键审批维持人工语义）。
- deny 规则命中时 UI 显著标红，附规则原文，避免"不知道为什么被拒绝"。

**5. 明确不做**
- 不按 prompt 自然语言匹配、不做 ML 分类（确定性正则/glob 已覆盖 80% 场景且可审计）；
- 不做规则分享的"市场"；
- 审批超时自动裁决（与上游 CLI 超时语义纠缠，先观察需求）。

### 分期

| 阶段 | 内容 | 依赖 |
|---|---|---|
| P1 | 规则 schema + 解析校验 + `onApprovalRequest` 介入 + `approval_auto` 事件与 UI 留痕卡 + 单测 | 无 |
| P2 | allow_session 决策扩展（双端）+ 审批卡第三按钮 | P1 |
| P3 | 规则命中率统计（哪条规则最常被命中/哪些审批仍在烦你→建议新规则） | P1 运行数据 |

### 验收（P1 已全部实测通过）

- ✅ 配置 path allow 规则后触发 Write 审批：UI 出现"已自动放行"卡、无推送、agent 无停顿继续（文件真实落盘）。
- ✅ 配置 path deny 规则：无审批卡、agent 收到含规则备注的拒绝原因（文件未落盘）、UI 留痕。
- ✅ 坏正则启动报错指到具体规则下标与文件；**热重载未做**（P1 重启生效，红线中的热重载需求挪至 P2/P3 评估）。
- ✅ e2e-approval.ts 全量回归通过（原有人工链路零变化）；`bun test` 322 过（含 27 条规则引擎单测）。

---

## 三、顺序建议

先做**漂移预警**（纯运维面、无行为变化、保护已有资产），再做**规则引擎**（改变用户面行为）。两者无代码耦合，可并行；但规则引擎上线后每条 CLI 升级都更需要漂移预警兜底——所以预警先行。
