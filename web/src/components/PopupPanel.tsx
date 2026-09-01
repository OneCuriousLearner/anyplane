import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { GlassSubPanel } from './GlassPanel'

export type PopupPlacement =
  | 'bottom-start'
  | 'bottom-end'
  | 'top-start'
  | 'top-end'
  /** 面板左下角与锚点左下角重合（与 StatusPill 同款，向上展开） */
  | 'cover-start'
  /** 面板右下角与锚点右下角重合（向上向左展开，盖住锚点） */
  | 'cover-end'

export interface PopupPos {
  top?: number
  left?: number
  bottom?: number
  right?: number
  transform?: string
}

export function popupPosition(
  r: Pick<DOMRect, 'top' | 'left' | 'right' | 'bottom'>,
  placement: PopupPlacement,
  offset: number,
  viewport: { width: number; height: number },
): PopupPos {
  switch (placement) {
    case 'bottom-start':
      return { top: r.bottom + offset, left: r.left }
    case 'bottom-end':
      return { top: r.bottom + offset, left: r.right, transform: 'translateX(-100%)' }
    case 'top-start':
      return { top: r.top - offset, left: r.left, transform: 'translateY(-100%)' }
    case 'top-end':
      return { top: r.top - offset, left: r.right, transform: 'translate(-100%, -100%)' }
    case 'cover-start':
      return { bottom: viewport.height - r.bottom, left: r.left }
    case 'cover-end':
      return { bottom: viewport.height - r.bottom, right: viewport.width - r.right }
  }
}

/**
 * 小型弹窗：portal 到 body + 固定定位 + 点击外部关闭 + Escape 关闭 + 玻璃子面板样式。
 * 位置随锚点实时同步（resize/scroll），不会被滚动容器裁剪。
 */
export function PopupPanel(props: {
  open: boolean
  /** 锚点元素；null 时面板不渲染 */
  anchor: HTMLElement | null
  onClose: () => void
  placement?: PopupPlacement
  offset?: number
  children: React.ReactNode
  className?: string
}) {
  const { open, anchor, onClose, placement = 'bottom-start', offset = 4 } = props
  const panelRef = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<PopupPos | null>(null)

  useLayoutEffect(() => {
    if (!open || !anchor) {
      setPos(null)
      return
    }
    const update = () => {
      setPos(
        popupPosition(anchor.getBoundingClientRect(), placement, offset, {
          width: window.innerWidth,
          height: window.innerHeight,
        }),
      )
    }
    update()
    window.addEventListener('resize', update)
    window.addEventListener('scroll', update, true)
    return () => {
      window.removeEventListener('resize', update)
      window.removeEventListener('scroll', update, true)
    }
  }, [open, anchor, placement, offset])

  useEffect(() => {
    if (!open) return
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node
      if (panelRef.current?.contains(t) || anchor?.contains(t)) return
      onClose()
    }
    document.addEventListener('pointerdown', onDown)
    return () => document.removeEventListener('pointerdown', onDown)
  }, [open, anchor, onClose])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open || !pos) return null

  return createPortal(
    <div
      ref={panelRef}
      className={`fixed z-50 ${props.className ?? ''}`}
      style={{
        top: pos.top,
        left: pos.left,
        bottom: pos.bottom,
        right: pos.right,
        transform: pos.transform,
      }}
    >
      <GlassSubPanel>{props.children}</GlassSubPanel>
    </div>,
    document.body,
  )
}
