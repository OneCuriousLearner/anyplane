// 子代理侧拉栏：Task/Agent 工具的逐 turn 活动（live sidechain 消息 + 历史回放共用一份数据）
//
// 数据来源：
// - 生命周期：system/task_started → task_progress（心跳）→ task_updated / task_notification
// - 转录：带 parent_tool_use_id 的完整 assistant/user 消息（官方只保证完整消息，无 token 级 delta）
// - 历史：readHistory 的 subagents 字段（新版 subagents/*.jsonl + 旧版内联侧链）

import { useEffect, useRef, useState } from 'react'
import { MessageView } from './MessageView'
import { shortTokens, type ChatMsg } from '../lib/blocks'

export interface SubagentFeed {
  /** 主抄本中 Agent/Task tool_use 的 id（与主线工具卡同源） */
  toolUseId: string
  agentId?: string
  description?: string
  agentType?: string
  status: 'running' | 'done' | 'error' | 'stopped'
  /** 最近一次 task_progress 的拟人化动作描述（"Running Grep for …"） */
  activity?: string
  lastToolName?: string
  usage?: { total_tokens?: number; tool_uses?: number; duration_ms?: number }
  /** 最终报告（task_notification.summary / 主线 tool_result 文本） */
  summary?: string
  /** 终态卡片的驱逐时刻（epoch ms，仿官方 PANEL_GRACE_MS 宽限期）；undefined = 不驱逐 */
  evictAfter?: number
  messages: ChatMsg[]
}

const STATUS_META: Record<SubagentFeed['status'], { dot: string; label: string }> = {
  running: { dot: 'bg-busy', label: '运行中' },
  done: { dot: 'bg-ok', label: '已完成' },
  error: { dot: 'bg-accent', label: '失败' },
  stopped: { dot: 'bg-faint', label: '已停止' },
}

function fmtDuration(ms?: number): string | undefined {
  if (ms == null) return undefined
  const s = Math.round(ms / 1000)
  return s >= 60 ? `${Math.floor(s / 60)}m${s % 60}s` : `${s}s`
}

function AgentCard(props: { feed: SubagentFeed }) {
  const { feed } = props
  const running = feed.status === 'running'
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
  const stats = [
    feed.usage?.tool_uses != null ? `${feed.usage.tool_uses} 次工具` : undefined,
    feed.usage?.total_tokens != null ? `${shortTokens(feed.usage.total_tokens)} tok` : undefined,
    fmtDuration(feed.usage?.duration_ms),
  ].filter(Boolean)

  return (
    <div className="rounded-[14px] bg-surface">
      <button
        type="button"
        className="flex w-full items-center gap-2 px-3 py-2.5 text-left"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${meta.dot} ${running ? 'animate-pulse' : ''}`} />
        <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-ink">
          {feed.description || feed.agentType || '子代理'}
        </span>
        {feed.agentType && (
          <span className="shrink-0 rounded-full bg-surface2 px-2 py-0.5 font-mono text-[10px] text-muted">
            {feed.agentType}
          </span>
        )}
        <span className="shrink-0 font-mono text-[10px] text-faint">{meta.label}</span>
      </button>

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

      {open && (
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
          {feed.messages.map((m, i) => (
            <MessageView key={m.id} msg={m} compact={m.role !== 'system' && feed.messages[i - 1]?.role === m.role} />
          ))}
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

/**
 * 子代理列表。桌面端是对话列的可收起右边栏（占位、不遮抄本）；
 * 移动端仍全宽 fixed 覆盖（带背板），窄屏挤不出 380px 列。
 */
export function SubagentPanel(props: { open: boolean; onClose: () => void; subagents: SubagentFeed[] }) {
  const { open, onClose, subagents } = props
  if (!open) return null
  const runningCount = subagents.filter((s) => s.status === 'running').length
  return (
    <>
      <div className="fixed inset-0 z-[80] bg-bg/60 md:hidden" onClick={onClose} aria-hidden />
      <aside className="fixed inset-y-0 right-0 z-[80] flex h-full min-h-0 w-full flex-col bg-[var(--subagent-pane)] md:static md:z-auto md:w-[380px] md:shrink-0">
        <div className="flex items-center gap-2 px-3 py-2.5">
          <span className="text-sm font-medium">子代理</span>
          <span className="font-mono text-[10px] text-faint">
            {runningCount > 0 ? `${runningCount} 运行中 · ` : ''}共 {subagents.length} 个
          </span>
          <button
            type="button"
            className="ml-auto grid h-7 w-7 place-items-center rounded-full text-faint transition-colors hover:bg-surface2 hover:text-ink"
            onClick={onClose}
            aria-label="关闭子代理面板"
          >
            ✕
          </button>
        </div>
        <div className="flex flex-1 flex-col gap-2 overflow-y-auto px-3 pb-3">
          {subagents.length === 0 && (
            <div className="py-8 text-center font-mono text-[11px] text-faint">本会话还没有子代理活动</div>
          )}
          {subagents.map((s) => (
            <AgentCard key={s.toolUseId} feed={s} />
          ))}
        </div>
      </aside>
    </>
  )
}
