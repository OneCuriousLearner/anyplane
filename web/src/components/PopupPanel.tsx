import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { GlassSubPanel } from './GlassPanel'

type Placement = 'bottom-start' | 'bottom-end' | 'top-start' | 'top-end'

/**
 * 小型弹窗：portal 到 body + 固定定位 + 点击外部关闭 + Escape 关闭 + 玻璃子面板样式。
 * 位置随锚点实时同步（resize/scroll），不会被滚动容器裁剪。
 */
export function PopupPanel(props: {
  open: boolean
  /** 锚点元素；null 时面板不渲染 */
  anchor: HTMLElement | null
  onClose: () => void
  placement?: Placement
  offset?: number
  children: React.ReactNode
  className?: string
}) {
  const { open, anchor, onClose, placement = 'bottom-start', offset = 4 } = props
  const panelRef = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ top: number; left: number; transform?: string } | null>(null)

  useLayoutEffect(() => {
    if (!open || !anchor) {
      setPos(null)
      return
    }
    const update = () => {
      const r = anchor.getBoundingClientRect()
      let top = 0
      let left = 0
      let transform: string | undefined
      switch (placement) {
        case 'bottom-start':
          top = r.bottom + offset
          left = r.left
          break
        case 'bottom-end':
          top = r.bottom + offset
          left = r.right
          transform = 'translateX(-100%)'
          break
        case 'top-start':
          top = r.top - offset
          left = r.left
          transform = 'translateY(-100%)'
          break
        case 'top-end':
          top = r.top - offset
          left = r.right
          transform = 'translate(-100%, -100%)'
          break
      }
      setPos({ top, left, transform })
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
      style={{ top: pos.top, left: pos.left, transform: pos.transform }}
    >
      <GlassSubPanel>{props.children}</GlassSubPanel>
    </div>,
    document.body,
  )
}
