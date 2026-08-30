import src from '../assets/anyplane.svg?raw'

/** 与 anyplane.svg 注释约定一致：默认留白画板 / 满幅方形裁切 */
const VIEWBOX_PADDED = '0 0 320 320'
const VIEWBOX_FULL_BLEED = '32 32 256 256'

function markup(opts: { fullBleed?: boolean; fill?: string } = {}): string {
  let html = src
  if (opts.fullBleed) {
    html = html.replace(`viewBox="${VIEWBOX_PADDED}"`, `viewBox="${VIEWBOX_FULL_BLEED}"`)
  }
  if (opts.fill) {
    html = html.replaceAll('fill="currentColor"', `fill="${opts.fill}"`)
  }
  return html
}

/** AnyPlane 产品标（fill=currentColor；内联才能继承调用处的 CSS color） */
export function AnyPlaneMark(props: { className?: string; fullBleed?: boolean }) {
  return (
    <span
      role="img"
      aria-label="AnyPlane"
      className={`inline-flex [&_svg]:h-full [&_svg]:w-full ${props.className ?? ''}`}
      dangerouslySetInnerHTML={{ __html: markup({ fullBleed: props.fullBleed }) }}
    />
  )
}

/** 标签栏 / apple-touch：独立文档吃不到 CSS，在调用处改 viewBox。fill 钉中灰（ink 贴白底会溶）。 */
export function applyAnyPlaneFavicon() {
  const href = `data:image/svg+xml,${encodeURIComponent(markup({ fullBleed: true, fill: '#8c8c8c' }))}`
  for (const rel of ['icon', 'apple-touch-icon'] as const) {
    document.querySelector(`link[rel="${rel}"]`)?.setAttribute('href', href)
  }
}
