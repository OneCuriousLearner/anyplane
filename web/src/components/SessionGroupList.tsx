import { useEffect, useRef, useState } from 'react'
import type { SessionInfo } from '@anyplane/protocol'
import { ClaudeMark } from './ClaudeMark'
import { CodexMark } from './CodexMark'
import { BranchIcon, dirBasename, STATUS_META, timeAgo } from './listChrome'
import type { SessionMenuAnchor } from './SessionRowMenu'

/** 每组默认渲染条数（走查问题 1：187 条全铺开时首屏全是旧会话）；
 *  等待审批与当前选中的行始终渲染（钉在组顶），不受窗口限制 */
const GROUP_PAGE = 5

export function SessionGroupList(props: {
  groups: Map<string, { list: SessionInfo[]; branch?: string; worktreeOf?: string }>
  collapsed: Set<string>
  onToggleCollapse: (cwd: string) => void
  selectedKey?: string
  onSelect: (s: SessionInfo) => void
  menuKey: string | null
  onMenu: (anchor: SessionMenuAnchor | null) => void
}) {
  // 每组已展开条数（默认 GROUP_PAGE，「查看更多」每次 +GROUP_PAGE）
  const [shown, setShown] = useState<Record<string, number>>({})

  // 当前选中行滚进视口（深链还原/通知点回来时行可能在视口外）。
  // 只滚最近的滚动容器（侧栏），block:'nearest' 已在视口内时不动。
  // 每个 key 只滚成功一次：① 行还没渲染（列表 fetch 与深链还原竞态、组折叠）就等
  // 数据/折叠态变化重试；② 成功后不再滚——轮询刷新不能把用户手动滚走的位置拽回来
  const scrolledForKeyRef = useRef<string | undefined>(undefined)
  useEffect(() => {
    const key = props.selectedKey
    if (!key || scrolledForKeyRef.current === key) return
    const el = document.querySelector(`[data-session-key="${CSS.escape(key)}"]`)
    if (!el) return
    el.scrollIntoView({ block: 'nearest' })
    scrolledForKeyRef.current = key
  }, [props.selectedKey, props.groups, props.collapsed])

  return (
    <>
      {[...props.groups.entries()].map(([cwd, group]) => {
        const folded = props.collapsed.has(cwd)
        // 钉顶行：等待审批（需要我）+ 当前选中（我在哪）——即使落在窗口外也留在组顶
        const pinned = group.list.filter((s) => s.managed.waiting || s.key === props.selectedKey)
        const pinnedKeys = new Set(pinned.map((s) => s.key))
        const rest = group.list.filter((s) => !pinnedKeys.has(s.key))
        const visible = [...pinned, ...rest.slice(0, shown[cwd] ?? GROUP_PAGE)]
        const remaining = group.list.length - visible.length
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
              visible.map((s) => {
                const stKey = s.managed.waiting ? 'waiting' : s.managed.busy ? 'busy' : s.managed.spawned ? 'idle' : s.status
                const st = STATUS_META[stKey] ?? STATUS_META.offline
                const active = props.selectedKey === s.key
                const busyRow = stKey === 'busy'
                // 主标题兜底：无 title 时用首条消息预览（codex 线程恒无 title，前 8 位 id 不可读）；
                // 已被提升为主标题的 lastPrompt 不再在副标题重复
                const displayTitle = s.title ?? s.lastPrompt ?? s.sessionId.slice(0, 8)
                const subPrompt = s.title ? s.lastPrompt : undefined
                return (
                  <div
                    key={s.key}
                    data-session-key={s.key}
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
                        <span className="truncate text-[15px] font-semibold">{displayTitle}</span>
                        <span className="ml-auto shrink-0 font-mono text-[11px] text-faint">{timeAgo(s.mtime)}</span>
                      </div>
                      <div className="mt-1 flex items-center gap-1.5 pl-[18px] text-[12px]">
                        <span className={`shrink-0 font-medium ${stKey === 'waiting' ? 'text-accent' : 'text-muted'}`}>
                          {st.label}
                        </span>
                        {subPrompt && <span className="truncate font-mono text-[11px] text-faint">{subPrompt}</span>}
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
            {!folded && remaining > 0 && (
              <button
                type="button"
                className="mx-1 mb-1 block w-[calc(100%-0.5rem)] rounded-[10px] py-1.5 text-center font-mono text-[11px] text-faint hover:bg-surface hover:text-muted"
                onClick={() => setShown((prev) => ({ ...prev, [cwd]: (prev[cwd] ?? GROUP_PAGE) + GROUP_PAGE }))}
              >
                查看更多（还剩 {remaining} 条）
              </button>
            )}
          </div>
        )
      })}
    </>
  )
}
