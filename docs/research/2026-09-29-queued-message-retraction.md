# 排队消息的撤回/重新编辑：协议面可行性调研（2026-09-29）

> 缘起：体验修复批次 A3 的备注项——「claude-code 中消息成功发送出去之前，用户有机会撤回
> 消息并重新编辑，AnyPlane 能实现等同效果最好，若不支持则标注放弃」。
> 结论：**两后端协议面都支持撤回/编辑，但它是功能级工作量（服务端接口 + 协议事件 +
> 前端队列 UI），不适合塞进止血批；单独立项候选。** 本文存档协议面证据。

## 两后端的排队消息落点

| 后端 | queue 模式实现 | 消息落点 | 撤回/编辑路径 |
|---|---|---|---|
| claude | AnyPlane 服务端内存排队（`processManager.ts` `queuedTexts`，idle/result 后按序 flush 才写 stdin） | **AnyPlane 进程内存**，CLI 无感知 | 删数组条目 + 状态推送即可，零协议依赖；注：headless 下 CLI 自带 priority 'next'/'later' 滞留不可用（447 行注释），所以队列自研在服务端——撤回也只能自研 |
| codex | `thread/queue/add` 立即上行（session.ts） | **上游 app-server 队列** | 0.158.0 schema 已有完整管理族：`thread/queue/delete`（撤回）、`thread/queue/update`（编辑）、`thread/queue/list`、`thread/queue/reorder`、`thread/queue/start`，另有 `thread/queue/changed` 通知可驱动前端队列态（generate-ts 基线 v2/ThreadQueue*） |

## 若立项，需要做什么

1. **服务端**：port 新增排队管理方法（claude 删 `queuedTexts` 条目；codex 透传
   `thread/queue/delete|update`，能力声明按 capabilities 闸）；队列态要进 status 或独立事件
   ——目前 codex 的 `thread/queue/changed` 通知未消费，claude 的 `queuedTexts` 只作 busy 启发式
   （`queuedTexts.length > 0 → busy`），队列**内容**对前端完全不可见。
2. **前端**：排队中的消息以可识别形态呈现（与乐观气泡区分），给「撤回」「编辑」两个动作；
   编辑=撤回+回填输入框即可，不需要 `thread/queue/update`（claude 侧没有等价物，两后端
   统一走撤回+重发更简）。
3. **边界**：排队消息 flush 与撤回竞态（idle 瞬间恰被 flush 的已在 CLI 手里，撤回应答
   「该消息已发出」）；codex `thread/queue/changed` 可权威对齐。

## 与 claude-code 交互模式的对照

交互式 claude-code 的「撤回重编」作用于其 TUI 输入队列（headless 无对应物）；codex 的
`codex queue --thread` 与其桌面 app 的队列 UI 走的是同一套 `thread/queue/*`——AnyPlane
若做，语义上与两家官方形态对齐，无自造概念。
