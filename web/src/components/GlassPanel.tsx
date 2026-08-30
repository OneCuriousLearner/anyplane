/** 玻璃子面板：磨砂浮层，供各类小型弹窗复用（零描边，靠色阶 + 模糊分层） */

/** 子面板样式：磨砂底 + 阴影 */
export const GLASS_SUB =
  'rounded-[14px] bg-surface2/80 shadow-[0_16px_40px_-12px_rgba(0,0,0,0.5)] backdrop-blur-xl'

/** 子面板容器 */
export function GlassSubPanel(props: { children: React.ReactNode; className?: string }) {
  return <div className={`p-1 ${GLASS_SUB} ${props.className ?? ''}`}>{props.children}</div>
}
