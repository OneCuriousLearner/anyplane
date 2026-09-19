import type { SessionInfo } from '@anyplane/protocol'
import { ClaudeMark } from './ClaudeMark'
import { CodexMark } from './CodexMark'
import { BranchIcon, dirBasename, STATUS_META, timeAgo } from './listChrome'
import type { SessionMenuAnchor } from './SessionRowMenu'

export function SessionGroupList(props: {
  groups: Map<string, { list: SessionInfo[]; branch?: string; worktreeOf?: string }>
  collapsed: Set<string>
  onToggleCollapse: (cwd: string) => void
  selectedKey?: string
  onSelect: (s: SessionInfo) => void
  menuKey: string | null
  onMenu: (anchor: SessionMenuAnchor | null) => void
}) {
  return (
    <>
      {[...props.groups.entries()].map(([cwd, group]) => {
        const folded = props.collapsed.has(cwd)
        return (
          <div key={cwd}>
            <button
              type="button"
              aria-expanded={!folded}
              title={folded ? '展开分组' : '折叠分组'}
              className="glass-bar sticky top-[58px] z-10 flex w-full items-center gap-2 px-3 py-2 text-left text-muted"
              onClick={() => props.onToggleCollapse(cwd)}
            >
              <svg className="h-3 w-3 shrink-0 text-[var(--caret)]" viewBox="0 0 8 8" aria-hidden="true">
                {folded ? (
                  <path fill="currentColor" d="M2.2 1.2 L6.6 4 L2.2 6.8Z" />
                ) : (
                  <path fill="currentColor" d="M1.2 2.2 L6.8 2.2 L4 6.6Z" />
                )}
              </svg>
              <span className="truncate text-[15px] font-semibold" title={cwd}>
                {dirBasename(cwd)}
              </span>
              <span className="shrink-0 font-mono text-[11px] font-normal text-faint">{group.list.length}</span>
              {(group.branch || group.worktreeOf) && (
                <span className="ml-auto flex shrink-0 items-center gap-1.5 font-mono text-[11px] font-normal text-faint">
                  {group.worktreeOf && (
                    <span className="rounded-sm border border-line px-1 text-[10px]" title={`worktree of ${group.worktreeOf}`}>
                      wt·{dirBasename(group.worktreeOf)}
                    </span>
                  )}
                  {group.branch && (
                    <>
                      <BranchIcon className="h-3 w-3" />
                      {group.branch}
                    </>
                  )}
                </span>
              )}
            </button>
            {!folded &&
              group.list.map((s) => {
                const stKey = s.managed.waiting ? 'waiting' : s.managed.busy ? 'busy' : s.managed.spawned ? 'idle' : s.status
                const st = STATUS_META[stKey] ?? STATUS_META.offline
                const active = props.selectedKey === s.key
                const busyRow = stKey === 'busy'
                return (
                  <div
                    key={s.key}
                    className={`group relative mx-1 mb-0.5 w-[calc(100%-0.5rem)] rounded-[14px] transition-colors ${
                      busyRow ? 'wave-surface bg-surface' : 'hover:bg-surface'
                    } ${active ? 'bg-surface2' : ''}`}
                  >
                    <button
                      type="button"
                      onClick={() => props.onSelect(s)}
                      className="block w-full cursor-pointer rounded-[14px] px-3 py-2.5 text-left"
                    >
                      <div className="flex items-center gap-2.5 pr-[22px]">
                        <span className={`h-2 w-2 shrink-0 rounded-full ${st.cls}`} />
                        <span className="truncate text-[15px] font-semibold">{s.title ?? s.sessionId.slice(0, 8)}</span>
                        <span className="ml-auto shrink-0 font-mono text-[11px] text-faint">{timeAgo(s.mtime)}</span>
                      </div>
                      <div className="mt-1 flex items-center gap-1.5 pl-[18px] text-[12px]">
                        <span className={`shrink-0 font-medium ${stKey === 'waiting' ? 'text-accent' : 'text-muted'}`}>
                          {st.label}
                        </span>
                        {s.lastPrompt && <span className="truncate font-mono text-[11px] text-faint">{s.lastPrompt}</span>}
                      </div>
                    </button>
                    <button
                      type="button"
                      className="absolute right-3 top-2.5 flex h-[18px] w-[18px] shrink-0 items-center justify-center overflow-hidden rounded-full transition-colors hover:bg-surface2"
                      title="更多操作"
                      aria-label={`会话操作：${s.title ?? s.sessionId.slice(0, 8)}`}
                      onClick={(e) => {
                        e.stopPropagation()
                        props.onMenu(props.menuKey === s.key ? null : { session: s, anchor: e.currentTarget })
                      }}
                    >
                      {s.backend === 'codex' ? (
                        <CodexMark size={15} static />
                      ) : (
                        <ClaudeMark className="h-[15px] w-[15px]" />
                      )}
                    </button>
                  </div>
                )
              })}
          </div>
        )
      })}
    </>
  )
}
