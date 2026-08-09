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

const EFFORT_COLOR: Record<Effort, string> = {
  low: 'text-faint',
  medium: 'text-wait',
  high: 'text-ok',
  xhigh: 'text-busy',
  max: 'text-accent',
}

const EFFORT_DESC: Record<Effort, string> = {
  low: '最快，最省',
  medium: '轻快日常',
  high: '默认推荐',
  xhigh: '深度推理',
  max: '全力以赴',
}

const MODE_META: Record<string, { dot: string; label: string; desc: string }> = {
  default: { dot: 'bg-faint', label: 'default', desc: '每次询问' },
  acceptEdits: { dot: 'bg-busy', label: 'accept edits', desc: '自动接受文件编辑' },
  plan: { dot: 'bg-wait', label: 'plan', desc: '先出计划再动手' },
  bypassPermissions: { dot: 'bg-danger', label: 'bypass permissions', desc: '全部自动放行' },
}

/** 毛玻璃面板：暖炭半透明 + 模糊 */
const GLASS = 'rounded-lg border border-line bg-surface/85 shadow-lg shadow-black/40 backdrop-blur-xl'

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
  /** 哪一行正在展开二级选项 */
  const [sub, setSub] = useState<'mode' | 'model' | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)

  // 点击面板外收起
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
  const effortIdx = EFFORT_LEVELS.indexOf(effort)

  return (
    <div ref={rootRef} className="relative border-b border-line bg-surface px-3 py-1.5">
      <div className="flex items-center gap-2">
        {/* 收起态：单行状态文案 */}
        <button
          onClick={() => setOpen(!open)}
          className="flex min-w-0 flex-1 items-center gap-2 rounded px-1 py-0.5 text-left font-mono text-[11px] text-ink hover:bg-surface2/60"
        >
          <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${mode.dot}`} />
          <span className="truncate">{modeLabel(modeKey)}</span>
          <span className="shrink-0 text-faint">[{props.model ?? '…'}]</span>
          <span className={`shrink-0 ${EFFORT_COLOR[effort]}`}>
            {EFFORT_GLYPH[effort]} {effort}
          </span>
          <span className="ml-auto shrink-0 text-faint">{open ? '▴' : '▾'}</span>
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

      {/* 展开面板（毛玻璃） */}
      {open && (
        <div className={`absolute left-3 right-3 top-full z-40 mt-1 p-1 md:right-auto md:w-96 ${GLASS}`}>
          {/* mode 行 */}
          <button
            className="flex w-full items-center gap-3 rounded-md px-3 py-2.5 text-left hover:bg-surface2/60"
            onClick={() => setSub(sub === 'mode' ? null : 'mode')}
          >
            <span className="w-11 font-mono text-[10px] uppercase tracking-widest text-faint">mode</span>
            <span className={`h-1.5 w-1.5 rounded-full ${mode.dot}`} />
            <span className="font-mono text-xs text-ink">{modeLabel(modeKey)}</span>
            <span className="ml-auto text-[10px] text-faint">{sub === 'mode' ? '▴' : '▾'}</span>
          </button>
          {sub === 'mode' && (
            <div className={`mx-2 mb-1 p-1 ${GLASS}`}>
              {cfg.permissionModes.map((m) => {
                const mm = MODE_META[m] ?? { dot: 'bg-faint', label: m, desc: '' }
                const active = modeKey === m
                return (
                  <button
                    key={m}
                    className={`flex w-full items-center gap-3 rounded px-3 py-2 text-left hover:bg-surface2/60 ${
                      active ? 'bg-surface2' : ''
                    }`}
                    onClick={() => {
                      props.onSetMode(m)
                      setSub(null)
                    }}
                  >
                    <span className={`h-1.5 w-1.5 rounded-full ${mm.dot}`} />
                    <span className="font-mono text-xs text-ink">{mm.label}</span>
                    <span className="ml-auto text-[10px] text-muted">{mm.desc}</span>
                    {active && <span className="text-[10px] text-ok">✓</span>}
                  </button>
                )
              })}
            </div>
          )}

          {/* model 行 */}
          <button
            className="flex w-full items-center gap-3 rounded-md px-3 py-2.5 text-left hover:bg-surface2/60"
            onClick={() => setSub(sub === 'model' ? null : 'model')}
          >
            <span className="w-11 font-mono text-[10px] uppercase tracking-widest text-faint">model</span>
            <span className="font-mono text-xs text-ink">[{props.model ?? '…'}]</span>
            <span className="ml-auto text-[10px] text-faint">{sub === 'model' ? '▴' : '▾'}</span>
          </button>
          {sub === 'model' && (
            <div className={`mx-2 mb-1 p-1 ${GLASS}`}>
              {cfg.models.map((m) => {
                const active = props.model === m
                return (
                  <button
                    key={m}
                    className={`flex w-full items-center gap-3 rounded px-3 py-2 text-left hover:bg-surface2/60 ${
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

          {/* effort 滑条：五档刻度，glyph 即档位 */}
          <div className="px-3 pb-3 pt-2">
            <div className="mb-2 flex items-center gap-3">
              <span className="w-11 font-mono text-[10px] uppercase tracking-widest text-faint">effort</span>
              <span className={`font-mono text-[10px] ${EFFORT_COLOR[effort]}`}>
                {EFFORT_GLYPH[effort]} {effort} · {EFFORT_DESC[effort]}
              </span>
            </div>
            <div className="relative px-1">
              <div className="absolute left-0 right-0 top-[9px] h-px bg-line" />
              <div
                className="absolute left-0 top-[9px] h-px bg-gradient-to-r from-faint via-wait to-accent transition-all duration-200"
                style={{ width: `${(effortIdx / (EFFORT_LEVELS.length - 1)) * 100}%` }}
              />
              <div className="relative flex justify-between">
                {EFFORT_LEVELS.map((l) => {
                  const active = l === effort
                  return (
                    <button
                      key={l}
                      onClick={() => props.onSetEffort(l)}
                      className="group flex w-12 flex-col items-center gap-1 py-0.5"
                      title={EFFORT_DESC[l]}
                    >
                      <span
                        className={`text-base leading-none transition-all duration-150 ${
                          active
                            ? `${EFFORT_COLOR[l]} scale-125 drop-shadow-[0_0_6px_currentColor]`
                            : 'text-faint group-hover:text-muted'
                        }`}
                      >
                        {EFFORT_GLYPH[l]}
                      </span>
                      <span
                        className={`font-mono text-[10px] ${active ? 'text-ink' : 'text-faint group-hover:text-muted'}`}
                      >
                        {l}
                      </span>
                    </button>
                  )
                })}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
