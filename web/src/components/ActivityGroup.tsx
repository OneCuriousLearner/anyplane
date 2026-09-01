import { useEffect, useState } from 'react'
import type { ActivityItem } from '../lib/blocks'
import { ToolCard } from './ToolCard'

/** 思考行：默认折叠；流式时强制展开。embedded 时交给外层 ActivityGroup 画底。 */
export function Thinking(props: {
  text: string
  streaming?: boolean
  embedded?: boolean
  className?: string
}) {
  const [open, setOpen] = useState(Boolean(props.streaming))
  useEffect(() => {
    setOpen(Boolean(props.streaming))
  }, [props.streaming])

  return (
    <div
      className={
        props.embedded
          ? (props.className ?? '')
          : `my-1.5 overflow-hidden rounded-[14px] bg-surface ${props.className ?? ''}`
      }
    >
      <button
        type="button"
        className="flex w-full items-center gap-2 px-3 py-2 text-left font-mono text-[12px] transition-colors hover:bg-surface2"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <span className="text-faint">{open ? '▾' : '▸'}</span>
        <span className="tracking-wide text-faint">思考</span>
        {props.streaming && <span className="text-muted">进行中…</span>}
      </button>
      {open && (
        <div className="max-h-48 overflow-y-auto px-3 pb-2.5 text-[13px] leading-relaxed whitespace-pre-wrap text-muted">
          {props.text}
        </div>
      )}
    </div>
  )
}

/** 相邻思考/工具收进同一张卡，行间用细分隔，各自仍可折叠。 */
export function ActivityGroup(props: {
  items: ActivityItem[]
  /** 嵌在已有卡片（侧问/用户气泡）内：不再套一层 surface */
  flush?: boolean
  compact?: boolean
  className?: string
}) {
  const { items } = props
  if (items.length === 0) return null

  const margin = props.flush ? '' : props.compact ? 'my-1' : 'my-1.5'
  const chrome = props.flush ? '' : `${margin} overflow-hidden rounded-[14px] bg-surface`

  return (
    <div className={`${chrome} ${props.className ?? ''}`}>
      <div className="divide-y divide-line">
        {items.map((item) => (
          <div key={item.key} className="min-w-0">
            {item.block.kind === 'thinking' ? (
              <Thinking text={item.block.text} streaming={item.streaming} embedded />
            ) : (
              <ToolCard tool={item.block} embedded />
            )}
          </div>
        ))}
      </div>
    </div>
  )
}
