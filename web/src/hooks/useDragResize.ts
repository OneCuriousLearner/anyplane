// 栏宽拖拽调节的唯一实现（左侧会话列表栏 App.tsx 与右侧任务/改动栏 TasksPanel.tsx 共用——
// clamp/指针捕获/body 光标/localStorage 持久化曾为逐字两份拷贝，行为修正要双落地）。

import { useState, type PointerEvent as ReactPointerEvent } from 'react'

export interface DragResizeOptions {
  /** localStorage 持久化键 */
  storageKey: string
  /** 双击恢复与损坏持久值兜底的默认宽 */
  def: number
  min: number
  max: number
  /** 指针横坐标 → 栏宽：左缘栏 clientX 即宽；右缘栏 innerWidth - clientX */
  fromClientX: (clientX: number) => number
}

/** 可拖调宽：当前宽、拖拽态与分隔条 handler 集（role/aria 属性由调用方按各自文案与 min/max 填） */
export function useDragResize(opts: DragResizeOptions): {
  width: number
  resizing: boolean
  separatorProps: {
    onPointerDown: (e: ReactPointerEvent<HTMLDivElement>) => void
    onPointerMove: (e: ReactPointerEvent<HTMLDivElement>) => void
    onPointerUp: (e: ReactPointerEvent<HTMLDivElement>) => void
    onPointerCancel: (e: ReactPointerEvent<HTMLDivElement>) => void
    onDoubleClick: () => void
  }
} {
  const clamp = (n: number) => Math.min(opts.max, Math.max(opts.min, Math.round(n)))
  const [width, setWidth] = useState(() => {
    const n = Number(localStorage.getItem(opts.storageKey))
    return Number.isFinite(n) && n > 0 ? clamp(n) : opts.def
  })
  const [resizing, setResizing] = useState(false)
  const persist = (w: number) => {
    const next = clamp(w)
    setWidth(next)
    localStorage.setItem(opts.storageKey, String(next))
  }
  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    e.preventDefault()
    e.currentTarget.setPointerCapture(e.pointerId)
    setResizing(true)
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
  }
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!e.currentTarget.hasPointerCapture(e.pointerId)) return
    setWidth(clamp(opts.fromClientX(e.clientX)))
  }
  const onPointerUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!e.currentTarget.hasPointerCapture(e.pointerId)) return
    e.currentTarget.releasePointerCapture(e.pointerId)
    setResizing(false)
    document.body.style.cursor = ''
    document.body.style.userSelect = ''
    persist(opts.fromClientX(e.clientX))
  }
  return {
    width,
    resizing,
    separatorProps: {
      onPointerDown,
      onPointerMove,
      onPointerUp,
      onPointerCancel: onPointerUp,
      onDoubleClick: () => persist(opts.def),
    },
  }
}
