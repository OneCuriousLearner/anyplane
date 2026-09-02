# Claude Code Task（TODO）跟踪机制

> 实验日期：2026-09-02  
> 实验会话：`0848de41-770b-4e48-883a-1f44766ffc74`  
> 源码参考：`/data/workspace/claude-code/src/utils/tasks.ts`、`src/hooks/useTasksV2.ts`、`src/tools/TaskCreateTool`、`src/tools/TaskUpdateTool`、`src/tools/TaskListTool`

## 1. 目的与范围

Claude Code 提供给模型的 **TaskCreate / TaskUpdate / TaskList** 工具（内部称 TodoV2）用于在**当前编码会话**内做进度看板。本文通过设计实验验证其持久化、生命周期、依赖关系与并发行为，避免与 AnyPlane 后台任务（Background Task / Agent）概念混淆。

## 2. 存储位置与命名规则

### 2.1 根目录

Task 文件落在 Claude Code 配置目录下的 `tasks/` 中：

```text
~/.claude/tasks/<taskListId>/
├── 1.json
├── 2.json
├── ...
├── .highwatermark
└── .lock
```

实验验证（当前会话）：

```text
~/.claude/tasks/0848de41-770b-4e48-883a-1f44766ffc74/
├── 8.json
├── .highwatermark   # 内容为 "7"
└── .lock            # 空文件，仅作为锁目标
```

### 2.2 taskListId 解析优先级

`getTaskListId()` 按以下顺序决定目录名（`src/utils/tasks.ts:199-210`）：

1. `CLAUDE_CODE_TASK_LIST_ID` 环境变量
2. 进程内 teammate 的 teamName
3. `CLAUDE_CODE_TEAM_NAME` 环境变量
4. Leader 通过 `TeamCreateTool` 设置的 `leaderTeamName`
5. 当前 sessionId（最常见，即 standalone 会话）

因此：

- **普通会话**：目录名 = `sessionId`
- **Agent Swarm / tmux 分屏**：目录名 = teamName，多个 Claude 进程共享同一套任务文件

### 2.3 文件命名

任务文件名为 `<taskId>.json`，taskId 是**从 1 开始递增的十进制整数字符串**。  
文件名经过 `sanitizePathComponent` 处理，仅保留 `[a-zA-Z0-9_-]`，防止路径遍历。

## 3. 文件格式

单任务 JSON 结构（由 `TaskSchema` 定义）：

```json
{
  "id": "8",
  "subject": "验证 highwatermark ID 续编",
  "description": "验证 highwatermark 后的 ID 分配是否从 8 开始",
  "activeForm": "...",
  "owner": "...",
  "status": "pending",
  "blocks": ["9"],
  "blockedBy": ["7"],
  "metadata": {}
}
```

字段说明：

| 字段 | 必填 | 说明 |
|---|---|---|
| `id` | 是 | 字符串形式的整数 ID |
| `subject` | 是 | 任务标题（命令式） |
| `description` | 是 | 任务描述 |
| `activeForm` | 否 | 进行态短语，用于 spinner |
| `owner` | 否 | 认领该任务的 agent 名称 |
| `status` | 是 | `pending` / `in_progress` / `completed` |
| `blocks` | 是 | 被本任务阻塞的任务 ID 列表 |
| `blockedBy` | 是 | 阻塞本任务的任务 ID 列表 |
| `metadata` | 否 | 任意元数据字典 |

## 4. 生命周期实验

### 4.1 创建：ID 从 highest + 1 分配

`createTask` 会读取当前目录内最高 taskId 与 `.highwatermark` 的较大值，加 1 作为新 ID。  
实验步骤：

1. 创建任务 1、2 并标记完成
2. 全部完成后等待约 5 秒，`resetTaskList` 删除所有 `.json` 并写入 `.highwatermark = 2`
3. 再创建新任务 → 得到 ID `8`

结论：**已删除任务的 ID 不会复用**，highwatermark 保证 ID 单调递增。

### 4.2 更新：即时写回

`TaskUpdate` 调用 `updateTask`，使用 proper-lockfile 对 `<taskId>.json` 加锁后写入。  
实验中用 `inotify`/`fs.watch` 路径观察，UI 在 50ms debounce 内刷新。

### 4.3 依赖：双向维护

`TaskUpdate` 的 `addBlocks` / `addBlockedBy` 最终都调用 `blockTask(taskListId, from, to)`，它会：

- 在 `from` 任务的 `blocks` 里加入 `to`
- 在 `to` 任务的 `blockedBy` 里加入 `from`

实验验证：对任务 4 执行 `addBlockedBy: ["3"]` 后：

- `3.json` 出现 `"blocks": ["4"]`
- `4.json` 出现 `"blockedBy": ["3"]`

### 4.4 全完成清理：5 秒后清空

关键代码在 `useTasksV2.ts`：

```ts
const HIDE_DELAY_MS = 5000
```

当任务列表中**所有任务状态均为 `completed`** 且持续 5 秒，UI store 调用 `resetTaskList(taskListId)`：

1. 加列表级锁
2. 把当前最高 ID 写入 `.highwatermark`（取 max(现有 mark, 当前最高 ID)）
3. 删除目录下所有非点号开头的 `.json` 文件
4. 通知订阅者

实验验证：

- 将任务 3-7 全部标为 completed
- 等待约 7 秒后检查：所有 `.json` 被删除，`.highwatermark` 从 `2` 变为 `7`

> ⚠️ 注意：这是**UI 层行为**，不是 task 一完成就立刻删除。如果会话在 5 秒内被中断，已完成任务文件会保留。

### 4.5 单独删除

`TaskUpdate` 支持 `status: "deleted"`，实际调用 `deleteTask`：

- 先更新 highwatermark（防止 ID 复用）
- 删除该任务文件
- 扫描其他任务，从它们的 `blocks` / `blockedBy` 中移除对该任务的引用

### 4.6 历史目录现象解释

观察 `~/.claude/tasks/` 下历史目录：

- 有些目录为空或只剩 `.lock` / `.highwatermark` → 该会话任务全完成，已触发 reset
- 有些目录保留大量 `completed` 任务 → 会话在全部完成前结束，未触发 5 秒清理
- 有些目录只剩一个 `in_progress` 任务 → 其他任务已完成/删除，唯一运行中任务保留

## 5. 并发与锁

Task 系统使用两层锁（proper-lockfile）：

1. **列表级锁**：`.lock` 文件
   - `createTask` 创建新任务
   - `resetTaskList` 清空任务列表
   - `claimTask` 带 `checkAgentBusy` 时
2. **任务级锁**：`<taskId>.json` 文件
   - 普通 `updateTask`
   - `claimTask` 不带 busy 检查时

锁选项：`retries: 30, minTimeout: 5ms, maxTimeout: 100ms`，可承受约 10+ 并发 agent 竞争。

## 6. 与 Background Task（Agent）的区别

| 维度 | Task（TODO） | Background Task（Agent） |
|---|---|---|
| 暴露工具 | `TaskCreate` / `TaskUpdate` / `TaskList` | `Agent` |
| 本质 | 当前会话的进度看板 | 独立运行的子代理进程 |
| 存储位置 | `~/.claude/tasks/<taskListId>/` | 子代理有自己的会话/上下文，不在 task 目录 |
| 共享范围 | 同 taskListId 的 Claude 进程共享 | 不共享 |
| 生命周期 | 随当前会话，全完成后 5s 清理 | 可跨会话存活，需显式停止 |
| 是否执行代码 | 否 | 是 |

在 AnyPlane 前端里，Background Task 进入“后台任务侧栏”（`TasksPanel.tsx`），而 TODO Task 不显示在 UI 上，仅供模型自身跟踪进度。

## 7. 对 AnyPlane 的启示

1. **不要依赖 task 文件做持久化状态**：TODO Task 会在全完成后自动清空，且属于本地用户目录，不进仓库。
2. **与 AnyPlane 后台任务命名冲突**：Claude Code 的 `Task` 和 AnyPlane UI 的 `后台任务` 是两套体系。任何涉及 AnyPlane 任务面板的文档/代码都应明确区分。
3. **Swarm 场景下 task 共享**：如果未来 AnyPlane 支持多 agent 协作，taskListId 可能变成 teamName，多个进程会读写同一目录，需沿用 Claude Code 的锁机制或自行同步。
4. **诊断时看两个地方**：
   - 当前任务列表：`~/.claude/tasks/<sessionId>/`
   - 会话抄本：`~/.claude/projects/<project-path>/<sessionId>.jsonl`

## 8. 实验复现命令

```bash
# 查看当前会话 task 目录
ls ~/.claude/tasks/$(cat ~/.claude/sessions/*.json | jq -r '.sessionId' | tail -1)/

# 查看 highwatermark
xxd ~/.claude/tasks/<sessionId>/.highwatermark

# 监控任务变化
watch -n 0.5 'ls -la ~/.claude/tasks/<sessionId>/'
```

---

*本文基于 Claude Code 源码快照与文件系统实验整理，官方 CLI 后续版本可能调整行为，以实际运行结果为准。*
