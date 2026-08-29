import src from '../assets/anyplane.svg?raw'

/** AnyPlane 产品标（fill=currentColor；内联才能继承调用处的 CSS color） */
export function AnyPlaneMark(props: { className?: string }) {
  return (
    <span
      role="img"
      aria-label="AnyPlane"
      className={`inline-flex [&_svg]:h-full [&_svg]:w-full ${props.className ?? ''}`}
      dangerouslySetInnerHTML={{ __html: src }}
    />
  )
}
