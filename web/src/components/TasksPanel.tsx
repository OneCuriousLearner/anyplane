// 后台任务侧拉栏：与主线并行的任务（agent / task / shell）的逐 turn 活动
//（live sidechain 消息 + 历史回放共用一份数据）
//
// 数据来源：
// - 生命周期：system/task_started → task_progress（心跳）→ task_updated / task_notification
//   task_type 全类型入栏——local_agent（子代理）、local_bash（CLI 2.1.x 自动后台化的
//   耗时前台 Bash）等；shell 类无转录，只展示心跳/统计/终态摘要
// - 转录：带 parent_tool_use_id 的完整 assistant/user 消息（官方只保证完整消息，无 token 级 delta）
// - 历史：readHistory 的 subagents 字段（新版 subagents/*.jsonl + 旧版内联侧链）
//
// 嵌套 agent（子代理再扇出子代理）：task_started 自带 spawn_depth；精确父子关系
// 优先用水合下发的 parentToolUseId（服务端 toolUseParents 推导），缺省时渲染期
// 从各桶转录里工具块的归属反推——嵌套的 Agent tool_use 出现在父任务转录中。

import { useEffect, useMemo, useRef, useState } from 'react'
import { Transcript } from './Transcript'
import { shortTokens, type ChatMsg } from '../lib/blocks'

export interface TaskFeed {
  /** 主抄本中发起该任务的 tool_use 的 id（与主线工具卡同源） */
  toolUseId: string
  agentId?: string
  description?: string
  /** 展示用类型徽标：subagent_type（如 Explore）优先，其次 task_type */
  agentType?: string
  /** 原始 task_type（local_agent / local_bash …），用于区分有无转录能力 */
  kind?: string
  status: 'running' | 'done' | 'error' | 'stopped'
  /** 最近一次 task_progress 的拟人化动作描述（"Running Grep for …"） */
  activity?: string
  lastToolName?: string
  usage?: { total_tokens?: number; tool_uses?: number; duration_ms?: number }
  /** 最终报告（task_notification.summary / 主线 tool_result 文本） */
  summary?: string
  /** 终态卡片的驱逐时刻（epoch ms，仿官方 PANEL_GRACE_MS 宽限期）；undefined = 不驱逐 */
  evictAfter?: number
  /** task_started 的 spawn_depth（1 = 主线扇出） */
  depth?: number
  /** 父任务的 toolUseId（嵌套 agent 时，水合下发） */
  parentToolUseId?: string
  messages: ChatMsg[]
}

/** 面板默认展示的卡片数（深度优先序），其余收进「展开」 */
const VISIBLE_LIMIT = 5

const STATUS_META: Record<TaskFeed['status'], { dot: string; label: string }> = {
  running: { dot: 'bg-busy', label: '运行中' },
  done: { dot: 'bg-ok', label: '已完成' },
  error: { dot: 'bg-accent', label: '失败' },
  stopped: { dot: 'bg-faint', label: '已停止' },
}

/** task_type 原始值的展示映射；agent 类通常已由 subagent_type 给出友好名 */
function typeLabel(t?: string): string | undefined {
  if (t === 'local_bash') return 'shell'
  return t
}

function fmtDuration(ms?: number): string | undefined {
  if (ms == null) return undefined
  const s = Math.round(ms / 1000)
  return s >= 60 ? `${Math.floor(s / 60)}m${s % 60}s` : `${s}s`
}

function TaskCard(props: { feed: TaskFeed; depth: number; onStop?: (taskId: string) => void }) {
  const { feed, depth, onStop } = props
  const running = feed.status === 'running'
  // shell 类任务无转录（终态摘要走 summary）；agent 类与已有消息时照常给转录区
  const hasTranscript = feed.kind !== 'local_bash'
  // 运行中默认展开转录，结束后默认收起（用户可手动切换）
  const [open, setOpen] = useState(running)
  const scrollRef = useRef<HTMLDivElement>(null)
  const stickRef = useRef(true)

  // 转录追加时贴底滚动（用户上翻阅读时不打扰）
  useEffect(() => {
    const el = scrollRef.current
    if (open && el && stickRef.current) el.scrollTop = el.scrollHeight
  }, [open, feed.messages.length, feed.activity])

  const meta = STATUS_META[feed.status]
  const type = typeLabel(feed.agentType)
  const stats = [
    feed.usage?.tool_uses != null ? `${feed.usage.tool_uses} 次工具` : undefined,
    feed.usage?.total_tokens != null ? `${shortTokens(feed.usage.total_tokens)} tok` : undefined,
    fmtDuration(feed.usage?.duration_ms),
  ].filter(Boolean)

  return (
    <div className="rounded-[14px] bg-surface" style={depth > 0 ? { marginLeft: depth * 16 } : undefined}>
      {/* 头部：整行可点切换转录；停止按钮是独立兄弟节点（按钮不能嵌套按钮） */}
      <div className="flex items-center">
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-2 px-3 py-2.5 text-left"
          onClick={() => hasTranscript && setOpen((v) => !v)}
          aria-expanded={hasTranscript ? open : undefined}
        >
          {depth > 0 && <span className="shrink-0 text-[10px] text-faint">↳</span>}
          <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${meta.dot} ${running ? 'animate-pulse' : ''}`} />
          <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-ink">
            {feed.description || type || '后台任务'}
          </span>
          {type && (
            <span className="shrink-0 rounded-full bg-surface2 px-2 py-0.5 font-mono text-[10px] text-muted">
              {type}
            </span>
          )}
          <span className="shrink-0 font-mono text-[10px] text-faint">{meta.label}</span>
        </button>
        {running && feed.agentId && onStop && (
          <button
            type="button"
            className="mr-2 grid h-6 w-6 shrink-0 place-items-center rounded-full text-accent transition-colors hover:bg-surface2"
            title="停止该后台任务"
            aria-label={`停止任务：${feed.description ?? feed.agentId}`}
            onClick={() => onStop(feed.agentId!)}
          >
            ✕
          </button>
        )}
      </div>

      {/* 心跳行：task_progress 的实时动作描述，运行中呼吸 */}
      {(running || feed.activity) && (
        <div className="px-3 pb-1.5 font-mono text-[11px] text-muted">
          <span className={running ? 'animate-pulse' : ''}>
            {feed.activity ?? (running ? '启动中…' : '')}
          </span>
          {feed.lastToolName && running && <span className="text-faint"> · {feed.lastToolName}</span>}
        </div>
      )}

      {stats.length > 0 && <div className="px-3 pb-1.5 font-mono text-[10px] text-faint">{stats.join(' · ')}</div>}

      {hasTranscript && open && (
        <div
          ref={scrollRef}
          onScroll={(e) => {
            const el = e.currentTarget
            stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40
          }}
          className="max-h-72 overflow-y-auto border-t border-line px-2 py-1"
        >
          {feed.messages.length === 0 && (
            <div className="py-2 text-center font-mono text-[10px] text-faint">
              {feed.status === 'running' ? '等待转录…' : '无转录记录'}
            </div>
          )}
          <Transcript messages={feed.messages} />
        </div>
      )}

      {feed.summary && !running && (
        <div className="border-t border-line px-3 py-2 text-[12px] leading-relaxed whitespace-pre-wrap text-muted">
          {feed.summary}
        </div>
      )}
    </div>
  )
}

/** 拍平成深度优先序的渲染条目；parentToolUseId 缺省时从转录工具块归属反推 */
export function flattenTasks(tasks: TaskFeed[]): Array<{ feed: TaskFeed; depth: number }> {
  // 转录归属反推：嵌套 agent 的 Agent tool_use 出现在父任务的转录消息里
  const ownerOf = new Map<string, string>()
  for (const t of tasks) {
    for (const m of t.messages) {
      for (const b of m.blocks) {
        if (b.kind === 'tool' && b.id) ownerOf.set(b.id, t.toolUseId)
      }
    }
  }
  const ids = new Set(tasks.map((t) => t.toolUseId))
  const children = new Map<string, TaskFeed[]>()
  const roots: TaskFeed[] = []
  for (const t of tasks) {
    const p = t.parentToolUseId ?? ownerOf.get(t.toolUseId)
    if (p && p !== t.toolUseId && ids.has(p)) {
      const list = children.get(p)
      if (list) list.push(t)
      else children.set(p, [t])
    } else {
      roots.push(t)
    }
  }
  const flat: Array<{ feed: TaskFeed; depth: number }> = []
  const visited = new Set<string>()
  const walk = (f: TaskFeed, d: number) => {
    if (visited.has(f.toolUseId)) return // 防御成环（异常数据下不死循环）
    visited.add(f.toolUseId)
    flat.push({ feed: f, depth: d })
    for (const c of children.get(f.toolUseId) ?? []) walk(c, d + 1)
  }
  for (const r of roots) walk(r, 0)
  // 理论完备：成环被 visited 截断的孤儿挂到末尾，不丢卡
  for (const t of tasks) if (!visited.has(t.toolUseId)) flat.push({ feed: t, depth: 0 })
  return flat
}

/**
 * 后台任务列表。桌面端是对话列的可收起右边栏（占位、不遮抄本）；
 * 移动端仍全宽 fixed 覆盖（带背板），窄屏挤不出 380px 列。
 * 默认只展示前 VISIBLE_LIMIT 张卡（深度优先序），其余点击「展开」——
 * 大量并行扇出时不至于把面板撑成无尽长列表。
 */
export function TasksPanel(props: { open: boolean; onClose: () => void; tasks: TaskFeed[]; onStop?: (taskId: string) => void }) {
  const { open, onClose, tasks, onStop } = props
  const [expanded, setExpanded] = useState(false)
  const flat = useMemo(() => flattenTasks(tasks), [tasks])
  if (!open) return null
  const runningCount = tasks.filter((s) => s.status === 'running').length
  const visible = expanded ? flat : flat.slice(0, VISIBLE_LIMIT)
  const hidden = flat.length - visible.length
  return (
    <>
      <div className="fixed inset-0 z-[80] bg-bg/60 md:hidden" onClick={onClose} aria-hidden />
      <aside className="fixed inset-y-0 right-0 z-[80] flex h-full min-h-0 w-full flex-col bg-[var(--task-pane)] md:static md:z-auto md:w-[380px] md:shrink-0">
        <div className="flex items-center gap-2 px-3 py-2.5">
          <span className="text-sm font-medium">后台任务</span>
          <span className="font-mono text-[10px] text-faint">
            {runningCount > 0 ? `${runningCount} 运行中 · ` : ''}共 {tasks.length} 个
          </span>
          <button
            type="button"
            className="ml-auto grid h-7 w-7 place-items-center rounded-full text-faint transition-colors hover:bg-surface2 hover:text-ink"
            onClick={onClose}
            aria-label="关闭后台任务面板"
          >
            ✕
          </button>
        </div>
        <div className="flex flex-1 flex-col gap-2 overflow-y-auto px-3 pb-3">
          {tasks.length === 0 && (
            <div className="py-8 text-center font-mono text-[11px] text-faint">本会话还没有后台任务活动</div>
          )}
          {visible.map(({ feed, depth }) => (
            <TaskCard key={feed.toolUseId} feed={feed} depth={depth} onStop={onStop} />
          ))}
          {flat.length > VISIBLE_LIMIT && (
            <button
              type="button"
              className="rounded-full bg-surface px-3 py-1.5 font-mono text-[11px] text-muted transition-colors hover:bg-surface2 hover:text-ink"
              onClick={() => setExpanded((v) => !v)}
            >
              {expanded ? '收起' : `展开其余 ${hidden} 个…`}
            </button>
          )}
        </div>
      </aside>
    </>
  )
}
