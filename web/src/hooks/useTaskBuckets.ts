// 后台任务桶 hook：与主线并行的 agent/task/shell 的建桶、归并、终态、TTL 驱逐。
// F3 从 pages/Chat.tsx 切出。
// 纪律：事件处理器在 React 渲染外触发（WS 回调），内部一律走 ref + setState + 会话内常量
//（isCodex 由 session.key 派生，会话内不变），因此 api 对象无需稳定引用——
// 过期闭包读到的仍是同一批 ref。重置（clear/resetFromHistory）由组合层在
// session.key 变化 effect 与历史加载里显式调用（reset 先于建连的顺序纪律在 Chat）。

import { useEffect, useRef, useState } from 'react'
import { fetchCodexHistory, type HistoryMessage, type HistoryResponse, type SubagentHistory } from '../lib/api'
import type { ChatMsg } from '../lib/blocks'
import { cliSidechainToHistory } from '../lib/chatText'
import { appendHistoryMsg, mergeTerminalHistoryState, type IngestState, type PendingResult, type ToolPos } from '../lib/ingest'
import type { SessionState } from '../lib/ws'
import type { TaskFeed } from '../components/TasksPanel'

/** 历史桶回填的选择口径（resetFromHistory 用；纯函数便于单测）：
 *  只为「调用在已加载历史窗口内、且主线 tool_result 缺失（未配对终态）」的 subagent 建桶。
 *  两条排除：已完成的（pending === false）不建——老会话重进复活一堆历史卡 30s 后齐消失
 *  是纯噪声，翻旧账走主线 Agent 工具卡；调用在历史分页窗口之外的不建——状态不可考
 * （实测 300 条窗口外 20 个 subagent 全被误判未完成 → 复活 → hydrate 判终态 → 30s 消失）；
 *  真在跑的任务由 status 的 activeTasks 权威水合兜底，不靠历史猜。 */
export function selectHistoryBuckets(msgs: ChatMsg[], subagents: SubagentHistory[] | undefined): SubagentHistory[] {
  const seenUse = new Set<string>()
  const finished = new Set<string>()
  for (const m of msgs) {
    for (const blk of m.blocks) {
      if (blk.kind === 'tool' && (blk.name === 'Agent' || blk.name === 'Task') && blk.id) {
        seenUse.add(blk.id)
        if (blk.pending === false) finished.add(blk.id)
      }
    }
  }
  return (subagents ?? []).filter((s) => {
    const id = s.toolUseId ?? s.agentId
    return Boolean(id) && seenUse.has(id!) && !finished.has(id!)
  })
}

/** 后台任务桶：TaskFeed + 归并用的 tool 配对索引与去重集合（不发布给渲染） */
interface TaskBucket extends TaskFeed {
  toolIdx: Map<string, ToolPos>
  /** 桶内乱序 tool_result 缓冲（与主线同规则，见 lib/ingest） */
  pending: Map<string, PendingResult>
  seen: Set<string>
  /** codex 子线程转录已懒取过（防重取） */
  transcriptFetched?: boolean
}

/**
 * 终态卡片的展示宽限期：镜像官方协调器面板的 PANEL_GRACE_MS
 *（claude-code src/utils/task/framework.ts:28）——完成后留 30s 供扫一眼报告，随后驱逐。
 * 报告摘要仍留在主线 Agent 工具卡与系统消息里，驱逐不丢信息。
 */
const PANEL_GRACE_MS = 30_000

export interface TaskBucketsApi {
  /** sidechain 落桶；无 parent_tool_use_id 时返回 false（调用方按主线处理） */
  appendSidechain(rec: Record<string, unknown>): boolean
  /** 主线 tool_result 给运行中桶补终态 */
  settleBucketFromResult(toolUseId: string | undefined, text: string, isError: boolean): void
  /** 服务端权威 activeTasks 水合 */
  hydrateTasks(st: SessionState): void
  taskStarted(rec: Record<string, unknown>): void
  taskProgress(rec: Record<string, unknown>): void
  taskUpdated(rec: Record<string, unknown>): void
  taskNotification(rec: Record<string, unknown>): void
  /** 历史加载时的桶重建：清桶 + 未完成的 subagent 回填（msgs = 刚加载的主线消息） */
  resetFromHistory(msgs: ChatMsg[], resp: HistoryResponse): void
  /** 翻页 prepend 后的 add-only 补建：新进入窗口的未完成 subagent 建桶；已有桶不动
   * （运行中桶不清除——reset 清桶只在整段历史重载时发生） */
  backfillFromHistory(msgs: ChatMsg[], subagents: SubagentHistory[]): void
  /** 会话切换重置 */
  clear(): void
}

export function useTaskBuckets(opts: { isCodex: boolean }): {
  tasks: TaskFeed[]
  tasksOpen: boolean
  setTasksOpen: React.Dispatch<React.SetStateAction<boolean>>
  api: TaskBucketsApi
} {
  const { isCodex } = opts
  const taskMapRef = useRef(new Map<string, TaskBucket>())
  const [tasks, setTasks] = useState<TaskFeed[]>([])
  const [tasksOpen, setTasksOpen] = useState(false)

  /** 发布桶快照：浅拷贝桶对象与消息数组，让 React 感知变化（事件为逐 turn 粒度，量小） */
  const pubTasks = () =>
    setTasks([...taskMapRef.current.values()].map((b) => ({ ...b, messages: [...b.messages] })))

  const taskBucket = (toolUseId: string): TaskBucket => {
    let b = taskMapRef.current.get(toolUseId)
    if (!b) {
      b = { toolUseId, status: 'running', messages: [], toolIdx: new Map(), pending: new Map(), seen: new Set() }
      taskMapRef.current.set(toolUseId, b)
    }
    return b
  }

  const appendTaskMsg = (toolUseId: string, h: HistoryMessage) => {
    const b = taskBucket(toolUseId)
    // 历史加载与 live 追加可能重叠（落盘与 WS 投递交界），按 uuid 去重
    if (h.uuid) {
      if (b.seen.has(h.uuid)) return
      b.seen.add(h.uuid)
    }
    const st: IngestState = { msgs: b.messages, toolIdx: b.toolIdx, pending: b.pending }
    appendHistoryMsg(st, h)
    b.messages = st.msgs
  }

  /** sidechain（子代理内部消息）不进主抄本——落进对应后台任务桶，右侧栏展示。
   *  assistant（子代理输出）与 user（子代理 prompt / tool_result，桶内配对）两路同规则。 */
  const appendSidechain = (rec: Record<string, unknown>): boolean => {
    const ptui = rec.parent_tool_use_id as string | undefined
    if (!ptui) return false
    const h = cliSidechainToHistory(rec)
    if (h) {
      appendTaskMsg(ptui, h)
      pubTasks()
    }
    return true
  }

  /** 统一终态：状态 + 清心跳 + 挂驱逐倒计时（宽限期后 1s 滴答自动移除卡片）。
   *  live 与历史终态一视同仁——历史卡默示展示 30s 即足，长期驻留会让老会话侧栏越堆越多。 */
  const markTerminal = (b: TaskBucket, status: TaskFeed['status']) => {
    b.status = status
    b.activity = undefined
    b.evictAfter = Date.now() + PANEL_GRACE_MS
    maybeFetchCodexTranscript(b)
  }

  /** 主线 tool_result 给运行中桶补终态：task_notification 未到的兜底，
   *  也是外部会话（tailer 路径，无 task_notification）唯一的终态信号。 */
  const settleBucketFromResult = (toolUseId: string | undefined, text: string, isError: boolean) => {
    const b = toolUseId ? taskMapRef.current.get(toolUseId) : undefined
    if (!b || b.status !== 'running') return
    markTerminal(b, isError ? 'error' : 'done')
    if (!b.summary && text) b.summary = text.slice(0, 500)
    pubTasks()
  }

  /** codex 子代理转录终态兜底拉取：live 转发（父子事件链）只覆盖注册点之后的 item，
   *  中途接入的客户端缺早期转录——终态经 thread/read 拉全量补齐。
   *  **锚点合并而非全量重建**（实现见 lib/ingest.mergeTerminalHistoryState）：上游 legacy
   *  thread/read 不返回 commandExecution/collabAgentToolCall 等工具项（0.148 实测，
   *  见 ROADMAP 方向四前置二），重建会把 live 转发来的工具卡抹掉。
   *  桶在 30s 宽限期内已被驱逐（慢 fetch 晚于驱逐滴答）时丢弃结果——
   *  taskBucket() 重建会产出 status:'running' 且无 evictAfter 的僵尸卡，永不驱逐。 */
  const maybeFetchCodexTranscript = (b: TaskBucket) => {
    if (!isCodex || !b.agentId || b.transcriptFetched) return
    b.transcriptFetched = true
    fetchCodexHistory(b.agentId)
      .then((resp) => {
        if (taskMapRef.current.get(b.toolUseId) !== b) return // 已驱逐，不复活
        const r = mergeTerminalHistoryState(b.messages, resp.messages)
        if (r) {
          b.messages = r.state.msgs
          b.toolIdx = r.state.toolIdx
          b.pending = r.state.pending
          b.seen = new Set([...r.state.msgs.map((m) => m.id), ...r.fetchedUuids])
          pubTasks()
        }
      })
      .catch(() => {})
  }

  /**
   * 用 SessionState.activeTasks（服务端权威运行任务表）水合桶：
   * 中途接入的客户端错过 live-only 的 task_started，没有这一步桶的首绘就会是终态。
   * 反方向：桶还 running 却不在任务表且会话空闲 → 通知在断线间隙丢了，判终态。
   * codex 服务端不维护任务表（状态里不带 activeTasks 字段），首行守卫直接跳过。
   */
  const hydrateTasks = (st: SessionState) => {
    if (!Array.isArray(st.activeTasks)) return
    let dirty = false
    const live = new Set<string>()
    for (const t of st.activeTasks) {
      if (!t.toolUseId) continue
      live.add(t.toolUseId)
      const existing = taskMapRef.current.get(t.toolUseId)
      if (existing) {
        // 终态不被水合覆盖；running 的补心跳信息
        if (existing.status === 'running' && t.lastToolName && existing.lastToolName !== t.lastToolName) {
          existing.lastToolName = t.lastToolName
          dirty = true
        }
        continue
      }
      const b = taskBucket(t.toolUseId)
      b.status = 'running'
      b.agentId = t.id // stop_task 需要 task_id，水合路径此前只建桶不记 agentId
      b.description = t.description ?? b.description
      b.agentType = t.taskType ?? b.agentType
      b.kind = t.taskType ?? b.kind
      b.lastToolName = t.lastToolName ?? b.lastToolName
      b.depth = t.depth ?? b.depth
      b.parentToolUseId = t.parentToolUseId ?? b.parentToolUseId
      dirty = true
    }
    if (!st.busy) {
      for (const b of taskMapRef.current.values()) {
        if (b.status === 'running' && !live.has(b.toolUseId)) {
          markTerminal(b, 'done')
          dirty = true
        }
      }
    }
    if (dirty) pubTasks()
  }

  /** 生命周期事件是桶的主注册点（tool_use_id ↔ task_id 映射在此建立）。
   *  桌面端自动拉开侧栏（移动端屏幕小，只亮顶栏按钮）。 */
  const taskStarted = (rec: Record<string, unknown>) => {
    const toolUseId = rec.tool_use_id as string | undefined
    if (!toolUseId) return
    const b = taskBucket(toolUseId)
    // claude 用 task_id；codex 合成事件经 agent_thread_id 携带子线程 id（终态后懒拉转录用），后者优先
    b.agentId =
      (rec.agent_thread_id as string | undefined) ?? (rec.task_id as string | undefined) ?? b.agentId
    b.description = (rec.description as string | undefined) ?? b.description
    b.agentType = (rec.subagent_type as string | undefined) ?? (rec.task_type as string | undefined) ?? b.agentType
    b.kind = (rec.task_type as string | undefined) ?? b.kind
    b.depth = (rec.spawn_depth as number | undefined) ?? b.depth
    // 嵌套血缘：claude 由水合下发；codex 孙代理的 task_started 直接携带（服务端事件链已知父子）
    b.parentToolUseId = (rec.parent_tool_use_id as string | undefined) ?? b.parentToolUseId
    b.status = 'running'
    pubTasks()
    if (window.matchMedia('(min-width: 768px)').matches) setTasksOpen(true)
  }

  /** 心跳：拟人化动作描述 + 用量，解决"长 turn 安静期像卡住"的体感。
   *  桶不存在也补建——中途接入错过 task_started 时，心跳就是首个可见信号。 */
  const taskProgress = (rec: Record<string, unknown>) => {
    const toolUseId = rec.tool_use_id as string | undefined
    if (!toolUseId) return
    const b = taskBucket(toolUseId)
    b.activity = (rec.description as string | undefined) ?? b.activity
    b.lastToolName = (rec.last_tool_name as string | undefined) ?? b.lastToolName
    b.usage = (rec.usage as TaskFeed['usage'] | undefined) ?? b.usage
    pubTasks()
  }

  /** 终态 patch（completed/stopped/failed）；只带 task_id，经 agentId 映射回桶 */
  const taskUpdated = (rec: Record<string, unknown>) => {
    const taskId = rec.task_id as string | undefined
    const patch = rec.patch as { status?: string } | undefined
    const b = [...taskMapRef.current.values()].find((x) => x.agentId === taskId)
    if (b && patch?.status && patch.status !== 'running' && b.status === 'running') {
      markTerminal(b, patch.status === 'completed' ? 'done' : patch.status === 'stopped' ? 'stopped' : 'error')
      pubTasks()
    }
  }

  const taskNotification = (rec: Record<string, unknown>) => {
    const summary = typeof rec.summary === 'string' ? rec.summary : ''
    const toolUseId = rec.tool_use_id as string | undefined
    if (!toolUseId) return
    const b = taskBucket(toolUseId)
    markTerminal(b, rec.status === 'completed' ? 'done' : rec.status === 'stopped' ? 'stopped' : 'error')
    b.summary = summary || b.summary
    b.usage = (rec.usage as TaskFeed['usage'] | undefined) ?? b.usage
    pubTasks()
  }

  /** 历史加载的桶重建：清桶 → 回填口径见 selectHistoryBuckets（纯函数，可单测） */
  const resetFromHistory = (msgs: ChatMsg[], resp: HistoryResponse) => {
    taskMapRef.current.clear()
    for (const s of selectHistoryBuckets(msgs, resp.subagents)) {
      const id = (s.toolUseId ?? s.agentId)!
      const b = taskBucket(id)
      b.agentId = s.agentId ?? b.agentId
      b.agentType = s.agentType ?? b.agentType
      b.description = s.description ?? b.description
      for (const h of s.messages) appendTaskMsg(b.toolUseId, h)
    }
    pubTasks()
  }

  /** 翻页补建（add-only）：翻页响应不带 subagents，调用方传入首页留存的全量清单 */
  const backfillFromHistory = (msgs: ChatMsg[], subagents: SubagentHistory[]) => {
    let dirty = false
    for (const s of selectHistoryBuckets(msgs, subagents)) {
      const id = (s.toolUseId ?? s.agentId)!
      if (taskMapRef.current.has(id)) continue
      const b = taskBucket(id)
      b.agentId = s.agentId ?? b.agentId
      b.agentType = s.agentType ?? b.agentType
      b.description = s.description ?? b.description
      for (const h of s.messages) appendTaskMsg(b.toolUseId, h)
      dirty = true
    }
    if (dirty) pubTasks()
  }

  const clear = () => {
    taskMapRef.current.clear()
    setTasks([])
    setTasksOpen(false)
  }

  // ---------- 终态卡片的 TTL 驱逐（仿官方协调器面板：1s 滴答扫 evictAfter） ----------
  useEffect(() => {
    const timer = setInterval(() => {
      const now = Date.now()
      let dirty = false
      for (const [id, b] of taskMapRef.current) {
        if (b.evictAfter != null && now >= b.evictAfter) {
          // 报告摘要仍留在主线 Agent 工具卡与「⚙ 后台任务完成」系统消息里，驱逐不丢信息
          taskMapRef.current.delete(id)
          dirty = true
        }
      }
      if (dirty) pubTasks()
      // 桶清空时收起侧栏——此时会话无运行中任务（running 桶永不驱逐），收起的都是终态卡
      if (dirty && taskMapRef.current.size === 0) setTasksOpen(false)
    }, 1000)
    return () => clearInterval(timer)
  }, [])

  return {
    tasks,
    tasksOpen,
    setTasksOpen,
    api: {
      appendSidechain,
      settleBucketFromResult,
      hydrateTasks,
      taskStarted,
      taskProgress,
      taskUpdated,
      taskNotification,
      resetFromHistory,
      backfillFromHistory,
      clear,
    },
  }
}
