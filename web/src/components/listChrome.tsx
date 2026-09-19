import type { SessionInfo } from '@anyplane/protocol'

export const STATUS_META: Record<SessionInfo['status'], { cls: string; label: string }> = {
  busy: { cls: 'bg-busy', label: '工作中' },
  idle: { cls: 'bg-ok', label: '空闲' },
  waiting: { cls: 'bg-accent', label: '等待审批' },
  offline: { cls: 'bg-faint', label: '离线' },
}

/** 顶栏圆形图标按钮（双轨圆角制：控件一律全圆） */
export function IconBtn(props: {
  title: string
  onClick: () => void
  accent?: boolean
  active?: boolean
  redDot?: boolean
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      title={props.title}
      aria-label={props.title}
      onClick={props.onClick}
      className={`relative grid h-8 w-8 shrink-0 place-items-center rounded-full transition-colors ${
        props.accent
          ? 'bg-ink text-bg'
          : props.active
            ? 'bg-surface2 text-ink'
            : 'bg-surface2 text-muted hover:text-ink'
      }`}
    >
      {props.children}
      {props.redDot && (
        <span className="absolute top-1 right-1 h-[7px] w-[7px] rounded-full bg-accent" aria-hidden />
      )}
    </button>
  )
}

export function PlusIcon(props: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" className={props.className} aria-hidden>
      <path d="M12 5v14M5 12h14" />
    </svg>
  )
}

export function TrashIcon(props: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={props.className} aria-hidden>
      <path d="M3 6h18" />
      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
      <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
    </svg>
  )
}

export function BranchIcon(props: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={props.className} aria-hidden>
      <line x1="6" y1="3" x2="6" y2="15" />
      <circle cx="18" cy="6" r="3" />
      <circle cx="6" cy="18" r="3" />
      <path d="M18 9a9 9 0 0 1-9 9" />
    </svg>
  )
}

export function timeAgo(ms: number): string {
  const s = Math.floor((Date.now() - ms) / 1000)
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m`
  if (s < 86400) return `${Math.floor(s / 3600)}h`
  return `${Math.floor(s / 86400)}d`
}

/** 分组标题用末级目录名（Windows / POSIX 都切）；hover 仍看完整路径 */
export function dirBasename(path: string): string {
  return path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || path
}
