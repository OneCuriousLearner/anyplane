import { useEffect, useRef, useState } from 'react'
import type { ServerConfigInfo } from '../lib/api'

// ---- 视觉编码（沿用 “session transcript” 暖炭 + 陶土橙 token 体系） ----
// mode：色点（危险度语义）  effort：Claude Code 原生 glyph（强度渐强）

export const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const
export type Effort = (typeof EFFORT_LEVELS)[number]

export const EFFORT_GLYPH: Record<Effort, string> = {
  low: '○',
  medium: '◐',
  high: '⬤',
  xhigh: '◉',
  max: '◈',
}

const EFFORT_META: Record<
  Effort,
  { color: string; fill: string; label: string; desc: string }
> = {
  low: { color: 'text-faint', fill: 'bg-faint', label: 'low', desc: '最快，最省' },
  medium: { color: 'text-wait', fill: 'bg-wait', label: 'medium', desc: '轻快日常' },
  high: { color: 'text-ok', fill: 'bg-ok', label: 'high', desc: '默认推荐' },
  xhigh: { color: 'text-busy', fill: 'bg-busy', label: 'xhigh', desc: '深度推理' },
  max: { color: 'text-accent', fill: 'bg-accent', label: 'max', desc: '全力以赴' },
}

const MODE_META: Record<string, { dot: string; label: string; short: string; desc: string }> = {
  default: { dot: 'bg-faint', label: 'default(manual)', short: 'default', desc: '每次询问' },
  acceptEdits: { dot: 'bg-busy', label: 'accept edits', short: 'edits', desc: '自动接受文件编辑' },
  plan: { dot: 'bg-wait', label: 'plan', short: 'plan', desc: '先出计划再动手' },
  bypassPermissions: { dot: 'bg-danger', label: 'bypass permissions', short: 'bypass', desc: '全部自动放行' },
}

/** 毛玻璃面板：低不透明底 + 强模糊 + 饱和提升，让背后内容真正渗出 */
const GLASS =
  'rounded-xl border border-white/10 bg-bg/55 shadow-2xl shadow-black/60 backdrop-blur-2xl backdrop-saturate-150'

function modeLabel(mode?: string): string {
  return (mode && MODE_META[mode]?.label) ?? mode ?? 'default'
}

export function StatusPill(props: {
  cfg: ServerConfigInfo
  model?: string
  permissionMode?: string
  effort?: Effort
  busy: boolean
  onSetModel: (m: string) => void
  onSetMode: (m: string) => void
  onSetEffort: (e: Effort) => void
  onInterrupt: () => void
}) {
  const { cfg } = props
  const [open, setOpen] = useState(false)
  const [sub, setSub] = useState<'mode' | 'model' | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false)
        setSub(null)
      }
    }
    document.addEventListener('pointerdown', onDown)
    return () => document.removeEventListener('pointerdown', onDown)
  }, [open])

  const modeKey = props.permissionMode ?? 'default'
  const mode = MODE_META[modeKey] ?? MODE_META.default
  const effort: Effort = props.effort ?? 'high'
  const effortMeta = EFFORT_META[effort]

  return (
    <div ref={rootRef} className="relative border-b border-line bg-surface px-3 py-1.5">
      <div className="flex items-center justify-between gap-3">
        {/* 状态胶囊：包裹内容，不拉伸 */}
        <button
          onClick={() => setOpen(!open)}
          className="inline-flex w-fit shrink-0 items-center gap-2 rounded-full border border-line bg-bg/60 px-2.5 py-1 text-left font-mono text-[11px] text-ink hover:border-accent/40 hover:bg-bg"
        >
          <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${mode.dot}`} />
          <span className="shrink-0">{mode.short}</span>
          <span className="shrink-0 text-faint">[{props.model ?? '…'}]</span>
          <span className={`shrink-0 ${effortMeta.color}`}>
            {effortMeta.label}
          </span>
          <span className="shrink-0 text-faint">{open ? '▴' : '▾'}</span>
        </button>

        <button
          className="shrink-0 rounded border border-danger/60 px-2.5 py-1 font-mono text-[11px] text-danger hover:bg-danger/10 disabled:opacity-30"
          disabled={!props.busy}
          onClick={props.onInterrupt}
          title="中断当前回合"
        >
          ■
        </button>
      </div>

      {/* 展开面板：真正的毛玻璃，对齐胶囊下方 */}
      {open && (
        <div
          className={`absolute left-3 right-3 top-full z-40 mt-2 p-2 md:right-auto md:w-80 ${GLASS}`}
        >
          {/* mode 行 */}
          <button
            className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left hover:bg-surface2/60"
            onClick={() => setSub(sub === 'mode' ? null : 'mode')}
          >
            <span className="w-10 font-mono text-[10px] uppercase tracking-widest text-faint">mode</span>
            <span className={`h-1.5 w-1.5 rounded-full ${mode.dot}`} />
            <span className="min-w-0 flex-1 truncate font-mono text-xs text-ink">{modeLabel(modeKey)}</span>
            <span className="text-[10px] text-faint">{sub === 'mode' ? '▴' : '▾'}</span>
          </button>
          {sub === 'mode' && (
            <div className={`mx-1 mb-1 mt-0.5 p-1 ${GLASS}`}>
              {cfg.permissionModes.map((m) => {
                const mm = MODE_META[m] ?? { dot: 'bg-faint', label: m, short: m, desc: '' }
                const active = modeKey === m
                return (
                  <button
                    key={m}
                    className={`flex w-full items-center gap-3 rounded-md px-3 py-2 text-left hover:bg-surface2/60 ${
                      active ? 'bg-surface2' : ''
                    }`}
                    onClick={() => {
                      props.onSetMode(m)
                      setSub(null)
                    }}
                  >
                    <span className={`h-1.5 w-1.5 rounded-full ${mm.dot}`} />
                    <span className="min-w-0 flex-1 truncate font-mono text-xs text-ink">{mm.label}</span>
                    <span className="text-[10px] text-muted">{mm.desc}</span>
                    {active && <span className="text-[10px] text-ok">✓</span>}
                  </button>
                )
              })}
            </div>
          )}

          {/* model 行 */}
          <button
            className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left hover:bg-surface2/60"
            onClick={() => setSub(sub === 'model' ? null : 'model')}
          >
            <span className="w-10 font-mono text-[10px] uppercase tracking-widest text-faint">model</span>
            <span className="min-w-0 flex-1 truncate font-mono text-xs text-ink">[{props.model ?? '…'}]</span>
            <span className="text-[10px] text-faint">{sub === 'model' ? '▴' : '▾'}</span>
          </button>
          {sub === 'model' && (
            <div className={`mx-1 mb-1 mt-0.5 p-1 ${GLASS}`}>
              {cfg.models.map((m) => {
                const active = props.model === m
                return (
                  <button
                    key={m}
                    className={`flex w-full items-center gap-3 rounded-md px-3 py-2 text-left hover:bg-surface2/60 ${
                      active ? 'bg-surface2' : ''
                    }`}
                    onClick={() => {
                      props.onSetModel(m)
                      setSub(null)
                    }}
                  >
                    <span className="font-mono text-xs text-ink">[{m}]</span>
                    {active && <span className="ml-auto text-[10px] text-ok">✓</span>}
                  </button>
                )
              })}
            </div>
          )}

          {/* effort 滑条：可拖动 + 可点击，吸附到五档 */}
          <EffortSlider value={effort} onChange={props.onSetEffort} />
        </div>
      )}
    </div>
  )
}

/** 五档吸附滑条：支持拖动（pointer capture）与点击跳转 */
function EffortSlider(props: { value: Effort; onChange: (e: Effort) => void }) {
  const trackRef = useRef<HTMLDivElement>(null)
  const [dragIdx, setDragIdx] = useState<number | null>(null)
  const valueIdx = EFFORT_LEVELS.indexOf(props.value)
  const idx = dragIdx ?? valueIdx
  const meta = EFFORT_META[EFFORT_LEVELS[idx]]

  const idxFromPointer = (clientX: number): number => {
    const el = trackRef.current
    if (!el) return valueIdx
    const rect = el.getBoundingClientRect()
    const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width))
    return Math.round(ratio * (EFFORT_LEVELS.length - 1))
  }

  const onPointerDown = (e: React.PointerEvent) => {
    e.preventDefault()
    trackRef.current?.setPointerCapture(e.pointerId)
    setDragIdx(idxFromPointer(e.clientX))
  }
  const onPointerMove = (e: React.PointerEvent) => {
    if (dragIdx === null) return
    setDragIdx(idxFromPointer(e.clientX))
  }
  const onPointerUp = () => {
    if (dragIdx !== null) props.onChange(EFFORT_LEVELS[dragIdx])
    setDragIdx(null)
  }

  const pct = (idx / (EFFORT_LEVELS.length - 1)) * 100

  return (
    <div className="px-2 pb-2 pt-1 select-none">
      <div className="mb-2 flex items-center gap-2">
        <span className="w-10 font-mono text-[10px] uppercase tracking-widest text-faint">effort</span>
        <span className={`font-mono text-[10px] ${meta.color}`}>
          {EFFORT_GLYPH[EFFORT_LEVELS[idx]]} {EFFORT_LEVELS[idx]} · {meta.desc}
        </span>
      </div>

      {/* 轨道：触控区域比视觉轨道大 */}
      <div
        ref={trackRef}
        className="relative h-8 cursor-pointer touch-none"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={() => setDragIdx(null)}
      >
        {/* 底轨 */}
        <div className="absolute left-0 right-0 top-1/2 h-1 -translate-y-1/2 rounded-full bg-line" />
        {/* 已选填充 */}
        <div
          className="absolute left-0 top-1/2 h-1 -translate-y-1/2 rounded-full bg-gradient-to-r from-faint via-wait to-accent transition-[width] duration-75"
          style={{ width: `${pct}%` }}
        />
        {/* 档位刻度 */}
        {EFFORT_LEVELS.map((l, i) => (
          <span
            key={l}
            className={`absolute top-1/2 h-1.5 w-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full transition-colors ${
              i <= idx ? 'bg-accent-soft' : 'bg-surface2'
            }`}
            style={{ left: `${(i / (EFFORT_LEVELS.length - 1)) * 100}%` }}
          />
        ))}
        {/* 拇指：glyph 内嵌 */}
        <div
          className={`absolute top-1/2 flex h-6 w-6 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border text-xs shadow-md transition-[left] duration-75 ${
            dragIdx !== null
              ? 'scale-110 border-accent bg-surface text-accent'
              : 'border-line bg-surface2 ' + meta.color
          }`}
          style={{ left: `${pct}%` }}
        >
          {EFFORT_GLYPH[EFFORT_LEVELS[idx]]}
        </div>
      </div>

      {/* 档位标签（两端对齐防溢出） */}
      <div className="relative h-4 font-mono text-[9px]">
        {EFFORT_LEVELS.map((l, i) => (
          <span
            key={l}
            className={`absolute ${i === idx ? EFFORT_META[l].color : 'text-faint'} ${
              i === 0 ? '' : i === EFFORT_LEVELS.length - 1 ? '-translate-x-full' : '-translate-x-1/2'
            }`}
            style={{ left: `${(i / (EFFORT_LEVELS.length - 1)) * 100}%` }}
          >
            {l}
          </span>
        ))}
      </div>
    </div>
  )
}
