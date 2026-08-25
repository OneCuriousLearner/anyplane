import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import {
  clampPos,
  DRAG_THRESHOLD,
  loadSlot,
  nearestSlot,
  parsePx,
  saveSlot,
  snapAnchors,
  type Insets,
  type Pt,
  type SnapSlot,
} from './modeBadgeSnap'

function prodHref(): string {
  const { protocol, hostname, port } = location
  if (hostname === '127.0.0.1' || hostname === 'localhost') {
    return `${protocol}//${hostname}:7480/`
  }
  const host = port && port !== '80' && port !== '443' ? `${hostname}:${port}` : hostname
  return `${protocol}//${host}/?mode=prod`
}

function readInsets(): Insets {
  const s = getComputedStyle(document.documentElement)
  return {
    top: parsePx(s.getPropertyValue('--sat')),
    right: parsePx(s.getPropertyValue('--sar')),
    bottom: parsePx(s.getPropertyValue('--sab')),
    left: parsePx(s.getPropertyValue('--sal')),
  }
}

function openProd(): void {
  window.open(prodHref(), '_blank', 'noopener,noreferrer')
}

type DragLive = {
  pointerId: number
  grabX: number
  grabY: number
  startX: number
  startY: number
  moved: boolean
  pos: Pt
}

/** 仅 Vite 开发包显示。点击新开生产标签页；可拖到六个贴边槽，默认右下。生产构建不含此组件。 */
export function ModeBadge() {
  const btnRef = useRef<HTMLButtonElement>(null)
  const live = useRef<DragLive | null>(null)
  const skipClick = useRef(false)
  const [slot, setSlot] = useState<SnapSlot>(loadSlot)
  const [size, setSize] = useState({ w: 55, h: 25 })
  const [view, setView] = useState(() => ({ w: window.innerWidth, h: window.innerHeight, insets: readInsets() }))
  const [drag, setDrag] = useState<Pt | null>(null)
  const [showGhosts, setShowGhosts] = useState(false)
  const [hoverSlot, setHoverSlot] = useState<SnapSlot | null>(null)

  useEffect(() => {
    document.title = 'DEV · cc-remote'
    return () => {
      document.title = 'cc-remote'
    }
  }, [])

  useEffect(() => {
    const onResize = () => setView({ w: window.innerWidth, h: window.innerHeight, insets: readInsets() })
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  useLayoutEffect(() => {
    const el = btnRef.current
    if (!el) return
    const measure = () => {
      const r = el.getBoundingClientRect()
      setSize((prev) => (prev.w === r.width && prev.h === r.height ? prev : { w: r.width, h: r.height }))
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const anchors = snapAnchors(view.w, view.h, size.w, size.h, view.insets)
  const parked = anchors[slot]
  const pos = drag ?? parked
  const preview = hoverSlot ?? slot

  const onPointerDown = (e: ReactPointerEvent<HTMLButtonElement>) => {
    if (e.button !== 0) return
    const rect = e.currentTarget.getBoundingClientRect()
    live.current = {
      pointerId: e.pointerId,
      grabX: e.clientX - rect.left,
      grabY: e.clientY - rect.top,
      startX: e.clientX,
      startY: e.clientY,
      moved: false,
      pos: { x: rect.left, y: rect.top },
    }
    e.currentTarget.setPointerCapture(e.pointerId)
  }

  const onPointerMove = (e: ReactPointerEvent<HTMLButtonElement>) => {
    const st = live.current
    if (!st || st.pointerId !== e.pointerId) return
    if (!st.moved) {
      if (Math.hypot(e.clientX - st.startX, e.clientY - st.startY) < DRAG_THRESHOLD) return
      st.moved = true
      setShowGhosts(true)
    }
    const next = clampPos(
      { x: e.clientX - st.grabX, y: e.clientY - st.grabY },
      view.w,
      view.h,
      size.w,
      size.h,
    )
    st.pos = next
    setDrag(next)
    setHoverSlot(nearestSlot(next, anchors))
  }

  const endPointer = (e: ReactPointerEvent<HTMLButtonElement>) => {
    const st = live.current
    if (!st || st.pointerId !== e.pointerId) return
    live.current = null
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId)
    }
    if (!st.moved) return
    skipClick.current = true
    const next = nearestSlot(st.pos, anchors)
    setHoverSlot(next)
    setSlot(next)
    saveSlot(next)
    requestAnimationFrame(() => {
      setDrag(null)
      window.setTimeout(() => {
        setShowGhosts(false)
        setHoverSlot(null)
      }, 240)
    })
  }

  const onClick = (e: React.MouseEvent<HTMLButtonElement>) => {
    if (skipClick.current) {
      skipClick.current = false
      e.preventDefault()
      return
    }
    openProd()
  }

  return (
    <>
      {showGhosts &&
        ([1, 2, 3, 4, 5, 6] as const).map((id) => {
          const a = anchors[id]
          const active = id === preview
          return (
            <div
              key={id}
              aria-hidden
              className={`pointer-events-none fixed z-[9998] rounded-full border ${
                active ? 'border-busy/70 bg-busy/15' : 'border-busy/20 bg-busy/5'
              }`}
              style={{ left: a.x, top: a.y, width: size.w, height: size.h }}
            />
          )
        })}
      <button
        ref={btnRef}
        type="button"
        data-slot={slot}
        onClick={onClick}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endPointer}
        onPointerCancel={endPointer}
        onTransitionEnd={() => {
          if (!live.current) {
            setShowGhosts(false)
            setHoverSlot(null)
          }
        }}
        aria-label="开发模式，点击新开生产标签页，可拖动贴边"
        title={'开发模式 · Vite :5173\n点击新开生产标签页\n拖动可贴边'}
        className={`fixed z-[9999] flex touch-none items-center gap-1.5 rounded-full border border-busy/40 bg-bg/75 px-2.5 py-1 font-mono text-[10px] tracking-widest text-busy shadow-[0_8px_24px_-8px_rgba(0,0,0,0.65)] backdrop-blur-md select-none ${
          drag ? 'cursor-grabbing' : 'cursor-grab'
        } ${
          showGhosts && !drag
            ? 'motion-safe:transition-[left,top] motion-safe:duration-200 motion-safe:ease-out'
            : ''
        }`}
        style={{ left: pos.x, top: pos.y }}
      >
        <span className="mode-badge-pulse size-1.5 rounded-full bg-busy" aria-hidden />
        DEV
      </button>
    </>
  )
}
