import { useRef, useState } from 'react'
import type { SessionState } from '../lib/ws'
import { fmtTokens, usageSummary } from '../lib/blocks'
import { PopupPanel } from './PopupPanel'

type ContextUsage = NonNullable<SessionState['context']>

/** 占用占比 → 颜色级（对齐官方 statusline 示例的 70/90 阈值；设计语言内只有灰阶 + 审批红） */
function toneOf(pct: number): string {
  if (pct >= 90) return 'text-accent'
  if (pct >= 70) return 'text-ink'
  return 'text-faint'
}

/**
 * 上下文窗口占用环形指示：放在输入行「添加图片」左侧。
 * 数据源是 status 事件的 context 字段（两后端同形，口径对齐各家官方 statusline；
 * 首个 API 应答/首个 turn 之前缺省，此时整体不渲染）。点击展开详情面板。
 */
export function ContextRing(props: {
  backend: 'claude' | 'codex'
  context?: SessionState['context']
  /** 会话累计 token（面板明细用；claude 为本进程累计，codex 为线程累计） */
  usage?: SessionState['usage']
  /** 已解析的模型显示名 */
  modelLabel?: string
  /** claude 专属：跳转详情抽屉的完整 context 分类（get_context_usage） */
  onOpenFullDetail?: () => void
}) {
  const { context } = props
  const btnRef = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)
  if (!context || context.windowSize <= 0) return null

  const pct = Math.round((context.usedTokens / context.windowSize) * 100)
  const clamped = Math.min(100, Math.max(0, pct))
  const tone = toneOf(clamped)
  // r=8 的周长；SVG 旋转 -90° 让进度从顶点开始
  const C = 2 * Math.PI * 8

  const rows: Array<{ name: string; tokens: number }> = [
    { name: 'input', tokens: context.inputTokens ?? 0 },
    { name: 'cache read', tokens: context.cacheReadTokens ?? 0 },
    { name: 'cache write', tokens: context.cacheWriteTokens ?? 0 },
    { name: 'output', tokens: context.outputTokens },
    ...(context.reasoningTokens != null ? [{ name: 'reasoning', tokens: context.reasoningTokens }] : []),
  ]
  const u = props.usage
  const usageLine = usageSummary(u, '会话累计 ')

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        className={`flex h-8 shrink-0 items-center gap-1 rounded-full px-1.5 transition-colors hover:bg-surface ${tone} ${open ? 'invisible' : ''}`}
        title={`上下文占用 ${clamped}%（${fmtTokens(context.usedTokens)} / ${fmtTokens(context.windowSize)} tok，点击查看详情）`}
        aria-label={`上下文占用 ${clamped}%，点击查看详情`}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <svg viewBox="0 0 20 20" className="h-5 w-5 -rotate-90" aria-hidden>
          <circle cx="10" cy="10" r="8" fill="none" strokeWidth="2.5" className="stroke-ink/10" />
          <circle
            cx="10"
            cy="10"
            r="8"
            fill="none"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeDasharray={`${(clamped / 100) * C} ${C}`}
            className="stroke-current transition-[stroke-dasharray] duration-300"
          />
        </svg>
      </button>
      {/* 面板右下角与环形右下角重合，向上展开（触发器 open 时 invisible，由面板盖住原位） */}
      <PopupPanel
        open={open}
        anchor={btnRef.current}
        onClose={() => setOpen(false)}
        placement="cover-end"
        className="max-w-[280px]"
      >
        <div className="min-w-0 w-full p-3">
          <div className="mb-1.5 flex min-w-0 items-baseline justify-between gap-2 font-mono text-[11px]">
            <span className="shrink-0 text-muted">上下文占用{props.backend === 'codex' ? '（codex）' : ''}</span>
            <span className={`min-w-0 truncate ${tone}`}>
              {clamped}% · {fmtTokens(context.usedTokens)} / {fmtTokens(context.windowSize)}
            </span>
          </div>
          <div className="mb-2 h-1 overflow-hidden rounded-full bg-surface2">
            <div className={`h-full bg-current ${tone}`} style={{ width: `${clamped}%` }} />
          </div>
          {rows.map((r) => (
            <div key={r.name} className="flex items-center gap-2 py-0.5">
              <span className="w-20 shrink-0 font-mono text-[10px] text-muted">{r.name}</span>
              <div className="h-1 flex-1 overflow-hidden rounded-full bg-surface2">
                <div
                  className="h-full bg-muted"
                  style={{ width: `${Math.min(100, (r.tokens / context.windowSize) * 100)}%` }}
                />
              </div>
              <span className="w-12 shrink-0 text-right font-mono text-[10px] text-faint">{fmtTokens(r.tokens)}</span>
            </div>
          ))}
          <div className="mt-2 border-t border-ink/5 pt-1.5 font-mono text-[10px] leading-relaxed text-faint">
            {props.modelLabel && <div>模型 {props.modelLabel}</div>}
            {usageLine && <div>{usageLine}</div>}
          </div>
          {props.onOpenFullDetail && (
            <button
              type="button"
              className="mt-2 w-full rounded-full bg-surface2 px-2.5 py-1 font-mono text-[10px] text-faint hover:text-ink"
              onClick={() => {
                setOpen(false)
                props.onOpenFullDetail?.()
              }}
            >
              完整 context 分类 →
            </button>
          )}
        </div>
      </PopupPanel>
    </>
  )
}
