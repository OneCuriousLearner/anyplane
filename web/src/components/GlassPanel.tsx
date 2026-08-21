/** 玻璃子面板：实底 + CRT 特效层，供各类小型弹窗复用 */

/** 子面板样式：实底 + 阴影，配合 PanelFx 特效层 */
export const GLASS_SUB =
  'rounded-md border border-white/10 bg-surface2/95 shadow-[0_16px_40px_-12px_rgba(0,0,0,0.7)]'

/** 指针磷光：把指针坐标（相对当前面板）写成 CSS 变量，供 .cc-panel-fx 消费（纯 CSS 渲染，不进 React state） */
export const trackFxPointer = (e: React.PointerEvent<HTMLElement>) => {
  const el = e.currentTarget
  const r = el.getBoundingClientRect()
  el.style.setProperty('--mx', `${e.clientX - r.left}px`)
  el.style.setProperty('--my', `${e.clientY - r.top}px`)
}

/** CRT 特效层：扫描线 + 点阵 + 指针磷光。corners 仅主面板使用（四角框线字符） */
export function PanelFx({ corners = false }: { corners?: boolean }) {
  return (
    <div className="cc-panel-fx" aria-hidden>
      {corners && (
        <>
          <span className="absolute left-1 top-0.5">┌</span>
          <span className="absolute right-1 top-0.5">┐</span>
          <span className="absolute bottom-0.5 left-1">└</span>
          <span className="absolute bottom-0.5 right-1">┘</span>
        </>
      )}
    </div>
  )
}

/** 子面板容器：GLASS_SUB + PanelFx + 指针磷光跟踪 */
export function GlassSubPanel(props: { children: React.ReactNode; className?: string }) {
  return (
    <div
      className={`relative p-1 ${GLASS_SUB} ${props.className ?? ''}`}
      onPointerMove={trackFxPointer}
    >
      <PanelFx />
      <div className="relative">{props.children}</div>
    </div>
  )
}
