import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { ServerConfigInfo } from '../lib/api'

// ---- 视觉编码（E2 液态玻璃 token：唯一彩色面 = 审批红，其余走灰阶） ----
// mode：色点（危险度语义）  effort：档位 glyph（强度渐强）

export const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const
export type Effort = (typeof EFFORT_LEVELS)[number]

export const EFFORT_GLYPH: Record<Effort, string> = {
  low: '○',
  medium: '◐',
  high: '⬤',
  xhigh: '◉',
  max: '◈',
}

const EFFORT_META: Record<Effort, { color: string; label: string; desc: string }> = {
  low: { color: 'text-faint', label: 'low', desc: '最快，最省' },
  medium: { color: 'text-muted', label: 'medium', desc: '轻快日常' },
  high: { color: 'text-ink', label: 'high', desc: '默认推荐' },
  xhigh: { color: 'text-ink', label: 'xhigh', desc: '深度推理' },
  max: { color: 'text-ink', label: 'max', desc: '全力以赴' },
}

// mode 色点语义：自动放行类一律审批红（醒目即风险），询问/只读类走灰阶
const MODE_META: Record<string, { dot: string; label: string; short: string; desc: string }> = {
  default: { dot: 'bg-faint', label: 'default(manual)', short: 'default', desc: '每次询问' },
  acceptEdits: { dot: 'bg-ok', label: 'accept edits', short: 'edits', desc: '自动接受文件编辑' },
  auto: { dot: 'bg-accent', label: 'auto', short: 'auto', desc: 'AI 自动审批指令' },
  plan: { dot: 'bg-ok', label: 'plan', short: 'plan', desc: '先出计划再动手' },
  bypassPermissions: { dot: 'bg-accent', label: 'bypass permissions', short: 'bypass', desc: '全部自动放行' },
  // codex 预设（sandbox × approvalPolicy 二维组合的常用档）
  readOnly: { dot: 'bg-ok', label: 'read only', short: '只读', desc: '只读沙箱 · 每次询问' },
  workspace: { dot: 'bg-faint', label: 'workspace', short: '工作区', desc: '工作区可写 · 每次询问' },
  workspaceAuto: { dot: 'bg-accent', label: 'workspace auto', short: '免审', desc: '工作区可写 · 自动放行' },
  fullAccess: { dot: 'bg-accent', label: 'full access', short: '全开', desc: '完全访问 · 自动放行' },
}

/** effort 元信息兜底：非 claude 五档时中性色 */
const EFFORT_GLYPH_LIST = Object.values(EFFORT_GLYPH)
const effortMetaOf = (level: string) =>
  (EFFORT_META as Record<string, (typeof EFFORT_META)[Effort]>)[level] ?? {
    color: 'text-muted',
    label: level,
    desc: '',
  }
const effortGlyphOf = (level: string, idx: number) =>
  (EFFORT_GLYPH as Record<string, string>)[level] ?? EFFORT_GLYPH_LIST[idx % EFFORT_GLYPH_LIST.length]

/** 磨砂浮层面板（须 portal 到 body，否则被带 backdrop-filter 的父级截成 backdrop root） */
const PANEL =
  'rounded-[14px] bg-surface2/85 p-2 shadow-[0_24px_60px_-12px_rgba(0,0,0,0.55)] backdrop-blur-xl'

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
  /** 各档实际配置的模型名（claude 设置透传）；未配置的档缺席 → 显示 tier 名 */
  modelNames?: Record<string, { name: string; id?: string }> | null
  /** 面板打开时回调（调用方借机实时拉取 modelNames） */
  onPanelOpen?: () => void
  onSetModel: (m: string) => void
  onSetMode: (m: string) => void
  onSetEffort: (e: string) => void
}) {
  const { cfg } = props
  const [open, setOpen] = useState(false)
  const [sub, setSub] = useState<'mode' | 'model' | null>(null)
  const [panelPos, setPanelPos] = useState<{ bottom: number; left: number; width: number } | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)

  /** 模型值 → {显示名, tooltip}：tier 直查（haiku/sonnet/…）→ 按模型 ID 反查（init 报的是解析后 ID，
   *  如 k3[1m]——大小写不敏感，设置里的 ID 写法可能不同）→ 未配置原样显示（降级） */
  const resolveModel = (v?: string): { label: string; title?: string } => {
    if (!v) return { label: '…' }
    const names = props.modelNames ?? {}
    const direct = names[v]
    if (direct) return { label: direct.name, title: direct.id && direct.id !== direct.name ? direct.id : undefined }
    const rev = Object.values(names).find((t) => t.id && t.id.toLowerCase() === v.toLowerCase())
    if (rev) return { label: rev.name, title: v }
    return { label: v }
  }

  const syncPanelPos = () => {
    // 面板左下角与胶囊左下角重叠，向上展开（触发器 open 时 invisible，由面板盖住原位）
    const el = triggerRef.current ?? rootRef.current
    if (!el) return
    const r = el.getBoundingClientRect()
    setPanelPos({ bottom: window.innerHeight - r.bottom, left: r.left, width: 320 })
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
  const modelInfo = resolveModel(props.model)

  const panel =
    open &&
    panelPos &&
    createPortal(
      <div
        ref={panelRef}
        className={`fixed z-50 overflow-hidden ${PANEL}`}
        style={{ bottom: panelPos.bottom, left: panelPos.left, width: panelPos.width }}
      >
        {/* mode 行 */}
        <button
          className="flex w-full items-center gap-3 rounded-[10px] px-3 py-2.5 text-left hover:bg-surface"
          onClick={() => setSub(sub === 'mode' ? null : 'mode')}
        >
          <span className="w-10 font-mono text-[10px] uppercase tracking-widest text-faint">mode</span>
          <span className={`h-1.5 w-1.5 rounded-full ${mode.dot}`} />
          <span className="min-w-0 flex-1 truncate font-mono text-xs text-ink">{modeLabel(modeKey)}</span>
          <span className="text-[10px] text-faint">{sub === 'mode' ? '▴' : '▾'}</span>
        </button>
        {sub === 'mode' && (
          <div className="mx-1 mb-1 mt-0.5 rounded-[10px] bg-bg/50 p-1">
            {cfg.permissionModes.map((m) => {
              const mm = MODE_META[m] ?? { dot: 'bg-faint', label: m, short: m, desc: '' }
              const active = modeKey === m
              return (
                <button
                  key={m}
                  className={`flex w-full items-center gap-3 rounded-[8px] px-3 py-2 text-left hover:bg-surface ${
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
          className="flex w-full items-center gap-3 rounded-[10px] px-3 py-2.5 text-left hover:bg-surface"
          onClick={() => setSub(sub === 'model' ? null : 'model')}
        >
          <span className="w-10 font-mono text-[10px] uppercase tracking-widest text-faint">model</span>
          <span
            className="min-w-0 flex-1 truncate font-mono text-xs text-ink"
            title={modelInfo.title}
          >
            [{modelInfo.label}]
          </span>
          <span className="text-[10px] text-faint">{sub === 'model' ? '▴' : '▾'}</span>
        </button>
        {sub === 'model' && (
          <div className="mx-1 mb-1 mt-0.5 rounded-[10px] bg-bg/50 p-1">
            {cfg.models.map((m) => {
              // 当前值可能是 tier（haiku）也可能是解析后的模型 ID（重连回放 initModel）——两种都认
              const active =
                props.model === m ||
                (!!props.model && props.modelNames?.[m]?.id?.toLowerCase() === props.model.toLowerCase())
              return (
                <button
                  key={m}
                  title={resolveModel(m).title}
                  className={`flex w-full items-center gap-3 rounded-[8px] px-3 py-2 text-left hover:bg-surface ${
                    active ? 'bg-surface2' : ''
                  }`}
                  onClick={() => {
                    props.onSetModel(m)
                    setSub(null)
                  }}
                >
                  <span className="font-mono text-xs text-ink">[{resolveModel(m).label}]</span>
                  {props.modelNames?.[m] && (
                    <span className="min-w-0 truncate text-[10px] text-faint">{m}</span>
                  )}
                  {active && <span className="ml-auto text-[10px] text-ok">✓</span>}
                </button>
              )
            })}
          </div>
        )}

        <EffortSlider levels={levels} value={effort} onChange={props.onSetEffort} />
      </div>,
      document.body,
    )

  return (
    <div ref={rootRef} className="relative min-w-0 max-w-full">
      <button
        ref={triggerRef}
        onClick={() => {
          const next = !open
          setOpen(next)
          if (next) props.onPanelOpen?.()
        }}
        className={`inline-flex min-w-0 max-w-full items-center gap-1.5 rounded-full px-2.5 py-1 text-left font-mono text-[11px] text-muted transition-colors hover:bg-surface hover:text-ink ${open ? 'invisible' : ''}`}
      >
        <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${mode.dot}`} />
        <span className="shrink-0">{mode.short}</span>
        <span className="flex min-w-0 items-baseline text-faint" title={modelInfo.title ?? modelInfo.label}>
          <span className="shrink-0">[</span>
          <span className="min-w-0 truncate">{modelInfo.label}</span>
          <span className="shrink-0">]</span>
        </span>
        <span className={`shrink-0 ${effortMeta.color}`}>{effortMeta.label}</span>
        <span className="shrink-0 text-faint">{open ? '▴' : '▾'}</span>
      </button>
      {panel}
    </div>
  )
}

/** 字符滑条：整条轨道用等宽字符渲染（[●══●══◉──○──○]），灰阶呈现。
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
      <div className="flex items-center rounded-[10px] px-2 py-2 font-mono text-sm leading-none focus-within:bg-surface hover:bg-surface">
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
          className="flex flex-1 cursor-pointer touch-none rounded-sm outline-none focus-visible:ring-1 focus-visible:ring-muted"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={() => setDragIdx(null)}
          onKeyDown={onKeyDown}
        >
          {Array.from({ length: WIDTH }, (_, c) => {
            // 拇指：当前档位 glyph
            if (c === cursor) {
              return (
                <span key={c} className="flex-1 text-center text-ink">
                  {effortGlyphOf(LEVELS[idx], idx)}
                </span>
              )
            }
            // 档位刻度：已过档 ●，未到档 ○
            if (c % GAP === 0) {
              const passed = c < cursor
              return (
                <span key={c} className={`flex-1 text-center ${passed ? 'text-muted' : 'text-faint'}`}>
                  {passed ? '●' : '○'}
                </span>
              )
            }
            // 连接段：已过 ═，未到 ─
            const passed = c < cursor
            return (
              <span key={c} className={`flex-1 text-center ${passed ? 'text-muted' : 'text-faint/60'}`}>
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
