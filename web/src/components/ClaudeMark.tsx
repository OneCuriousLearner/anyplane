import claudeUrl from '../assets/claude.svg'

/** Claude 官方星芒标（SVG 资源统一从 assets 导入，不在页面手绘） */
export function ClaudeMark(props: { className?: string }) {
  return <img src={claudeUrl} alt="Claude" draggable={false} className={props.className} />
}
