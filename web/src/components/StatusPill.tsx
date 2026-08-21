import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { ServerConfigInfo } from '../lib/api'
import { GlassSubPanel, PanelFx, trackFxPointer } from './GlassPanel'

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
  auto: { dot: 'bg-accent', label: 'auto', short: 'auto', desc: 'AI 自动审批指令' },
  plan: { dot: 'bg-wait', label: 'plan', short: 'plan', desc: '先出计划再动手' },
  bypassPermissions: { dot: 'bg-danger', label: 'bypass permissions', short: 'bypass', desc: '全部自动放行' },
  // codex 预设（sandbox × approvalPolicy 二维组合的常用档）
  readOnly: { dot: 'bg-wait', label: 'read only', short: '只读', desc: '只读沙箱 · 每次询问' },
  workspace: { dot: 'bg-faint', label: 'workspace', short: '工作区', desc: '工作区可写 · 每次询问' },
  workspaceAuto: { dot: 'bg-busy', label: 'workspace auto', short: '免审', desc: '工作区可写 · 自动放行' },
  fullAccess: { dot: 'bg-danger', label: 'full access', short: '全开', desc: '完全访问 · 自动放行' },
}

/** effort 元信息兜底：非 claude 五档时按索引循环 glyph、中性色 */
const EFFORT_GLYPHS = ['○', '◐', '⬤', '◉', '◈'] as const
const effortMetaOf = (level: string) =>
  (EFFORT_META as Record<string, (typeof EFFORT_META)[Effort]>)[level] ?? {
    color: 'text-ok',
    fill: 'bg-ok',
    label: level,
    desc: '',
  }
const effortGlyphOf = (level: string, idx: number) =>
  (EFFORT_GLYPH as Record<string, string>)[level] ?? EFFORT_GLYPHS[idx % EFFORT_GLYPHS.length]

/** 毛玻璃主面板：半透明底 + blur-md。须 portal 到 body，否则会被带 backdrop-filter 的顶栏截成 backdrop root。
 *  背景特效层见 index.css 的 .cc-panel-fx（CRT 扫描线 / 点阵 / 指针磷光），子面板复用同一层 */
const GLASS =
  'rounded-md border border-white/15 bg-linear-[150deg] from-white/[0.10] via-bg/55 to-bg/70 shadow-[0_24px_60px_-12px_rgba(0,0,0,0.75),inset_-0.58px_1px_0_rgba(255,255,255,0.10)] backdrop-blur-md'

/** 悬浮顶/底栏用毛玻璃条：无圆角，配合单向边框 */
export const GLASS_BAR = 'bg-bg/60 backdrop-blur-md'

function modeLabel(mode?: string): string {
  return (mode && MODE_META[mode]?.label) ?? mode ?? 'default'
}

export function StatusPill(props: {
  cfg: ServerConfigInfo
  model?: string
  permissionMode?: string
  effort?: string
  /** effort 档位表（默认 claude 五档；codex 按模型 supportedReasoningEfforts 传入） */
  effortLevels?: readonly string[]
  onSetModel: (m: string) => void
  onSetMode: (m: string) => void
  onSetEffort: (e: string) => void
}) {
  const { cfg } = props
  const [open, setOpen] = useState(false)
  const [sub, setSub] = useState<'mode' | 'model' | null>(null)
  const [panelPos, setPanelPos] = useState<{ top: number; left: number; width: number } | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)

  const syncPanelPos = () => {
    // 锚胶囊按钮左上角（与触发器重叠展开），而不是整行容器（容器含 px-3，会贴到消息区左边）
    const el = triggerRef.current ?? rootRef.current
    if (!el) return
    const r = el.getBoundingClientRect()
    setPanelPos({ top: r.top, left: r.left, width: 320 })
  }

  useLayoutEffect(() => {
    if (!open) {
      setPanelPos(null)
      return
    }
    syncPanelPos()
    const onReposition = () => syncPanelPos()
    window.addEventListener('resize', onReposition)
    // 捕获阶段：任意滚动都会让 fixed 锚点漂移，重算位置
    window.addEventListener('scroll', onReposition, true)
    return () => {
      window.removeEventListener('resize', onReposition)
      window.removeEventListener('scroll', onReposition, true)
    }
  }, [open])

  useEffect(() => {
    if (!open) return
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node
      if (rootRef.current?.contains(t) || panelRef.current?.contains(t)) return
      setOpen(false)
      setSub(null)
    }
    document.addEventListener('pointerdown', onDown)
    return () => document.removeEventListener('pointerdown', onDown)
  }, [open])

  const modeKey = props.permissionMode ?? 'default'
  const mode = MODE_META[modeKey] ?? MODE_META.default
  const levels = props.effortLevels ?? EFFORT_LEVELS
  const effort: string = props.effort && levels.includes(props.effort) ? props.effort : (levels[Math.min(2, levels.length - 1)] ?? 'high')
  const effortMeta = effortMetaOf(effort)

  const panel =
    open &&
    panelPos &&
    createPortal(
      <div
        ref={panelRef}
        className={`fixed z-50 overflow-hidden p-2 ${GLASS}`}
        style={{ top: panelPos.top, left: panelPos.left, width: panelPos.width }}
        onPointerMove={trackFxPointer}
      >
        <PanelFx corners />
        <div className="relative">
        {/* mode 行 */}
        <button
          className="flex w-full items-center gap-3 rounded-md px-3 py-2.5 text-left hover:bg-surface2/60"
          onClick={() => setSub(sub === 'mode' ? null : 'mode')}
        >
          <span className="w-10 font-mono text-[10px] uppercase tracking-widest text-faint">mode</span>
          <span className={`h-1.5 w-1.5 rounded-full ${mode.dot}`} />
          <span className="min-w-0 flex-1 truncate font-mono text-xs text-ink">{modeLabel(modeKey)}</span>
          <span className="text-[10px] text-faint">{sub === 'mode' ? '▴' : '▾'}</span>
        </button>
        {sub === 'mode' && (
          <GlassSubPanel className="mx-1 mb-1 mt-0.5">
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
          </GlassSubPanel>
        )}

        {/* model 行 */}
        <button
          className="flex w-full items-center gap-3 rounded-md px-3 py-2.5 text-left hover:bg-surface2/60"
          onClick={() => setSub(sub === 'model' ? null : 'model')}
        >
          <span className="w-10 font-mono text-[10px] uppercase tracking-widest text-faint">model</span>
          <span className="min-w-0 flex-1 truncate font-mono text-xs text-ink">[{props.model ?? '…'}]</span>
          <span className="text-[10px] text-faint">{sub === 'model' ? '▴' : '▾'}</span>
        </button>
        {sub === 'model' && (
          <GlassSubPanel className="mx-1 mb-1 mt-0.5">
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
          </GlassSubPanel>
        )}

        <EffortSlider levels={levels} value={effort} onChange={props.onSetEffort} />
        </div>
      </div>,
      document.body,
    )

  return (
    <div ref={rootRef} className="relative px-3 py-1.5">
      <button
        ref={triggerRef}
        onClick={() => setOpen(!open)}
        className={`inline-flex w-fit shrink-0 items-center gap-2 rounded-md border border-line bg-bg/60 px-2.5 py-1 text-left font-mono text-[11px] text-ink hover:border-accent/40 hover:bg-bg ${open ? 'invisible' : ''}`}
      >
        <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${mode.dot}`} />
        <span className="shrink-0">{mode.short}</span>
        <span className="shrink-0 text-faint">[{props.model ?? '…'}]</span>
        <span className={`shrink-0 ${effortMeta.color}`}>{effortMeta.label}</span>
        <span className="shrink-0 text-faint">{open ? '▴' : '▾'}</span>
      </button>
      {panel}
    </div>
  )
}

/** 终端字符滑条：整条轨道用等宽字符渲染（[●══●══◉──○──○]），磷光辉光点缀。
 *  交互：拖动 / 点击吸附档位，聚焦后 ←→↑↓ 步进、Home/End 跳两端。
 *  档位表由调用方传入（claude 五档 / codex 按模型 supportedReasoningEfforts）。 */
function EffortSlider(props: { levels: readonly string[]; value: string; onChange: (e: string) => void }) {
  const trackRef = useRef<HTMLDivElement>(null)
  const [dragIdx, setDragIdx] = useState<number | null>(null)
  const LEVELS = props.levels
  const valueIdx = Math.max(0, LEVELS.indexOf(props.value))
  const idx = dragIdx ?? valueIdx
  const meta = effortMetaOf(LEVELS[idx])

  const N = LEVELS.length
  const GAP = 4 // 相邻档位的字符间隔
  const WIDTH = (N - 1) * GAP + 1
  const cursor = idx * GAP

  const idxFromPointer = (clientX: number): number => {
    const el = trackRef.current
    if (!el) return valueIdx
    const rect = el.getBoundingClientRect()
    const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width))
    return Math.round(ratio * (N - 1))
  }

  const onPointerDown = (e: React.PointerEvent) => {
    e.preventDefault()
    trackRef.current?.focus()
    trackRef.current?.setPointerCapture(e.pointerId)
    setDragIdx(idxFromPointer(e.clientX))
  }
  const onPointerMove = (e: React.PointerEvent) => {
    if (dragIdx === null) return
    setDragIdx(idxFromPointer(e.clientX))
  }
  const onPointerUp = () => {
    if (dragIdx !== null) props.onChange(LEVELS[dragIdx])
    setDragIdx(null)
  }

  const step = (d: number) => {
    const next = Math.min(N - 1, Math.max(0, valueIdx + d))
    if (next !== valueIdx) props.onChange(LEVELS[next])
  }
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowRight' || e.key === 'ArrowUp') {
      e.preventDefault()
      step(1)
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') {
      e.preventDefault()
      step(-1)
    } else if (e.key === 'Home') {
      e.preventDefault()
      props.onChange(LEVELS[0])
    } else if (e.key === 'End') {
      e.preventDefault()
      props.onChange(LEVELS[N - 1])
    }
  }

  return (
    // px-3 与 mode/model 行一致；mt-1.5 补足与 model 行的间距（行间距 = py-2.5 × 2）
    <div className="mt-1.5 select-none px-3 pb-2 pt-1">
      <div className="mb-1 flex items-baseline gap-2">
        <span className="w-10 font-mono text-[10px] uppercase tracking-widest text-faint">effort</span>
        <span className={`font-mono text-[10px] ${meta.color}`}>
          {LEVELS[idx]} · {meta.desc}
        </span>
        <span className="ml-auto font-mono text-[9px] text-faint">←→</span>
      </div>

      {/* 字符轨道：flex-1 单元格等宽撑满，档间距恒定；括号外是留白触控区 */}
      <div className="flex items-center rounded-md px-2 py-2 font-mono text-sm leading-none focus-within:bg-surface2/40 hover:bg-surface2/40">
        <span className="shrink-0 text-faint">[</span>
        <div
          ref={trackRef}
          role="slider"
          tabIndex={0}
          aria-label="effort"
          aria-valuemin={1}
          aria-valuemax={N}
          aria-valuenow={idx + 1}
          aria-valuetext={LEVELS[idx]}
          className="flex flex-1 cursor-pointer touch-none rounded-sm outline-none focus-visible:ring-1 focus-visible:ring-accent/60"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={() => setDragIdx(null)}
          onKeyDown={onKeyDown}
        >
          {Array.from({ length: WIDTH }, (_, c) => {
            // 拇指：当前档位 glyph，磷光最强
            if (c === cursor) {
              return (
                <span
                  key={c}
                  className={`flex-1 text-center [text-shadow:0_0_8px_currentColor] ${
                    dragIdx !== null ? 'text-accent' : meta.color
                  }`}
                >
                  {effortGlyphOf(LEVELS[idx], idx)}
                </span>
              )
            }
            // 档位刻度：已过档 ●，未到档 ○
            if (c % GAP === 0) {
              const passed = c < cursor
              return (
                <span
                  key={c}
                  className={`flex-1 text-center ${
                    passed ? 'text-accent-soft [text-shadow:0_0_5px_currentColor]' : 'text-faint'
                  }`}
                >
                  {passed ? '●' : '○'}
                </span>
              )
            }
            // 连接段：已过 ═，未到 ─
            const passed = c < cursor
            return (
              <span key={c} className={`flex-1 text-center ${passed ? 'text-accent/70' : 'text-line'}`}>
                {passed ? '═' : '─'}
              </span>
            )
          })}
        </div>
        <span className="shrink-0 text-faint">]</span>
      </div>

      {/* 档位标签：与轨道相同的水平内缩（px-2 + 1ch 括号），保证刻度对齐 */}
      <div className="relative mx-[calc(0.5rem+1ch)] mt-1 h-4 font-mono text-[9px]">
        {LEVELS.map((l, i) => (
          <span
            key={l}
            className={`absolute ${i === idx ? effortMetaOf(l).color : 'text-faint'} ${
              i === 0 ? '' : i === N - 1 ? '-translate-x-full' : '-translate-x-1/2'
            }`}
            style={{ left: `${(i / (N - 1)) * 100}%` }}
          >
            {l}
          </span>
        ))}
      </div>
    </div>
  )
}
