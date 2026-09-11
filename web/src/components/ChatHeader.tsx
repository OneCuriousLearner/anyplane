// 聊天页顶栏：悬浮磨砂横带（返回/标题状态行/后台任务开关/更多菜单/goal 面板/接力链导航条）。
// F2 从 pages/Chat.tsx 逐字切出——纯展示组件，状态经 props 平铺注入，无内部业务逻辑。
// （moreBtnRef 与 idCopied 是本组件私有的展示态，随 JSX 一并下沉。）

import { useRef, useState } from 'react'
import type { LineageResponse, SessionInfo } from '../lib/api'
import type { NavigateSession } from '../lib/sessionHash'
import { copyText } from '../lib/chatText'
import type { SessionState } from '../lib/ws'
import { ClaudeMark } from './ClaudeMark'
import { CodexMark } from './CodexMark'
import { PopupPanel } from './PopupPanel'
import type { TaskFeed } from './TasksPanel'

const MORE_ITEM =
  'flex w-full items-center gap-2 rounded-[10px] px-3 py-2 text-left font-mono text-[12px] text-muted transition-colors hover:bg-surface hover:text-ink'

export function ChatHeader(props: {
  session: SessionInfo
  connected: boolean
  statusLine: string
  busy: boolean
  phase?: string
  onBack: () => void
  tasks: TaskFeed[]
  tasksOpen: boolean
  onToggleTasks: () => void
  isExisting: boolean
  isCodex: boolean
  /** state.sessionId（更多菜单与目标按钮的显隐判定） */
  sessionId?: string
  /** 当前会话权威 ID（复制按钮）；spawn 后以 status 广播为准 */
  currentSessionId?: string
  goal?: SessionState['goal']
  usageLine?: string
  moreOpen: boolean
  setMoreOpen: (v: boolean | ((prev: boolean) => boolean)) => void
  onSystemMessage: (text: string, kind?: 'info' | 'error') => void
  /** 详情抽屉开关：含「打开时顺带发查询」的语义，实现在 Chat 组合层 */
  onToggleDetail: () => void
  goalOpen: boolean
  onToggleGoal: () => void
  onCloseGoal: () => void
  goalDraft: string
  onGoalDraftChange: (v: string) => void
  onSendGoal: (condition?: string) => void
  onBranch: () => void
  handoffBusy: boolean
  onHandoff: () => void
  lineage?: LineageResponse
  onNavigate?: NavigateSession
  /** 玻璃横带内的尾部插槽（详情抽屉在 DOM 上与顶栏/接力链同属 glass-bar，由组合层传入） */
  children?: React.ReactNode
}) {
  const {
    session,
    connected,
    statusLine,
    busy,
    phase,
    onBack,
    tasks,
    tasksOpen,
    onToggleTasks,
    isExisting,
    isCodex,
    sessionId,
    currentSessionId,
    goal,
    usageLine,
    moreOpen,
    setMoreOpen,
    onSystemMessage,
    onToggleDetail,
    goalOpen,
    onToggleGoal,
    onCloseGoal,
    goalDraft,
    onGoalDraftChange,
    onSendGoal,
    onBranch,
    handoffBusy,
    onHandoff,
    lineage,
    onNavigate,
    children,
  } = props
  const moreBtnRef = useRef<HTMLButtonElement>(null)
  const [idCopied, setIdCopied] = useState(false)

  return (
    <div className="glass-bar absolute inset-x-0 top-0 z-30">
      <div className="px-3 py-2.5">
        <div className="flex items-center gap-2">
          <button
            className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-surface2 text-muted transition-colors hover:text-ink md:hidden"
            onClick={onBack}
            title="返回列表"
            aria-label="返回列表"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4" aria-hidden>
              <path d="M19 12H5M12 19l-7-7 7-7" />
            </svg>
          </button>
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-medium">{session.title ?? session.cwd ?? session.sessionId}</div>
            <div className="flex items-center gap-2 font-mono text-[10px] tracking-wide text-faint">
              <span className={connected ? 'text-ok' : 'text-accent'}>{connected ? '●' : '○'}</span>
              <span className={busy || phase ? 'text-busy' : ''}>{statusLine}</span>
            </div>
          </div>
          {/* 后台任务侧栏开关：有任务活动时出现；运行中带计数徽标与呼吸 */}
          {tasks.length > 0 && (
            <button
              type="button"
              className={`relative grid h-8 w-8 shrink-0 place-items-center rounded-full transition-colors ${
                tasksOpen ? 'bg-surface2 text-ink' : 'bg-surface2 text-muted hover:text-ink'
              }`}
              title="后台任务"
              aria-label="后台任务"
              aria-expanded={tasksOpen}
              onClick={onToggleTasks}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4" aria-hidden>
                <path d="M6 3v12" />
                <circle cx="18" cy="6" r="3" />
                <circle cx="6" cy="18" r="3" />
                <path d="M18 9a9 9 0 0 1-9 9" />
              </svg>
              {tasks.some((s) => s.status === 'running') && (
                <span className="absolute top-0.5 right-0.5 size-1.5 animate-pulse rounded-full bg-busy" aria-hidden />
              )}
            </button>
          )}
          {(isExisting || !isCodex || sessionId) && (
            <>
              <button
                ref={moreBtnRef}
                type="button"
                className={`relative grid h-8 w-8 shrink-0 place-items-center rounded-full transition-colors ${
                  moreOpen ? 'bg-surface2 text-ink' : 'bg-surface2 text-muted hover:text-ink'
                }`}
                title="更多"
                aria-label="更多"
                aria-haspopup="menu"
                aria-expanded={moreOpen}
                onClick={() => setMoreOpen((v) => !v)}
              >
                <svg viewBox="0 0 24 24" fill="currentColor" className="h-4 w-4" aria-hidden>
                  <circle cx="5" cy="12" r="1.8" />
                  <circle cx="12" cy="12" r="1.8" />
                  <circle cx="19" cy="12" r="1.8" />
                </svg>
                {goal && (
                  <span className="absolute top-0.5 right-0.5 size-1.5 rounded-full bg-ok" aria-hidden />
                )}
              </button>
              <PopupPanel
                open={moreOpen}
                anchor={moreBtnRef.current}
                onClose={() => setMoreOpen(false)}
                placement="bottom-end"
                offset={6}
                className="min-w-44"
              >
                {currentSessionId && (
                  <button
                    type="button"
                    role="menuitem"
                    className={`${MORE_ITEM} ${idCopied ? 'text-ok hover:text-ok' : ''}`}
                    title={`${isCodex ? 'thread id' : 'session id'}：${currentSessionId}（点击复制完整 ID）`}
                    onClick={() => {
                      void copyText(currentSessionId).then((ok) => {
                        if (!ok) {
                          setMoreOpen(false)
                          onSystemMessage(`⚠ 复制失败，请手动复制：${currentSessionId}`, 'error')
                          return
                        }
                        setIdCopied(true)
                        setTimeout(() => {
                          setIdCopied(false)
                          setMoreOpen(false)
                        }, 900)
                      })
                    }}
                  >
                    {idCopied ? '✓ 已复制' : `⧉ ${currentSessionId.slice(0, 8)}…`}
                  </button>
                )}
                {isExisting && (
                  <button
                    type="button"
                    role="menuitem"
                    className={MORE_ITEM}
                    title="会话详情：context 用量 / MCP 状态 / 设置"
                    onClick={() => {
                      setMoreOpen(false)
                      onToggleDetail()
                    }}
                  >
                    ▤ 详情
                  </button>
                )}
                {(!isCodex || sessionId) && (
                  <button
                    type="button"
                    role="menuitem"
                    className={`${MORE_ITEM} ${goal ? 'text-ok hover:text-ok' : ''}`}
                    title={
                      goal
                        ? `当前目标：${goal.condition}（点击管理）`
                        : '设定目标：agent 会持续工作直到条件达成（claude /goal · codex thread/goal）'
                    }
                    onClick={() => {
                      setMoreOpen(false)
                      onToggleGoal()
                    }}
                  >
                    {goal
                      ? `◎ ${goal.condition.slice(0, 16)}${goal.condition.length > 16 ? '…' : ''}`
                      : '◎ 目标'}
                  </button>
                )}
                {isExisting && !isCodex && (
                  <button
                    type="button"
                    role="menuitem"
                    className={MORE_ITEM}
                    title="分叉当前会话：新分支携带全部历史，原会话保持不动"
                    onClick={() => {
                      setMoreOpen(false)
                      onBranch()
                    }}
                  >
                    ⎇ 分叉
                  </button>
                )}
                {isExisting && (
                  <button
                    type="button"
                    role="menuitem"
                    className={`${MORE_ITEM} disabled:opacity-40`}
                    disabled={handoffBusy}
                    title="让另一个 agent 接续本目录的工作（源会话 fork 自写简报，目标会话带简报进场）"
                    onClick={() => {
                      setMoreOpen(false)
                      onHandoff()
                    }}
                  >
                    {handoffBusy ? '接力中…' : `⇄ 接力给${isCodex ? ' Claude' : ' Codex'}`}
                  </button>
                )}
              </PopupPanel>
            </>
          )}
        </div>
        {usageLine && (
          <div className="mt-1 font-mono text-[10px] tracking-wide text-faint/80">{usageLine}</div>
        )}
        {goalOpen && (
          <div className="mt-2 rounded-[14px] bg-surface2/80 p-2.5 backdrop-blur-xl">
            <div className="mb-1.5 flex items-center justify-between">
              <span className="font-mono text-[10px] tracking-wide text-faint">
                ◎ 会话目标{goal ? '（进行中）' : ''}——agent 会持续工作直到条件达成
              </span>
              <button className="font-mono text-[10px] text-faint hover:text-muted" onClick={onCloseGoal}>
                ✕
              </button>
            </div>
            {goal && (
              <div className="mb-1.5 font-mono text-[11px] leading-relaxed text-ok">
                当前：{goal.condition}
                {goal.tokensUsed != null && (
                  <span className="text-faint"> · {goal.tokensUsed} tok</span>
                )}
              </div>
            )}
            <div className="flex gap-1.5">
              <input
                className="min-w-0 flex-1 rounded-full bg-bg/60 px-3 py-1.5 font-mono text-[11px] text-ink outline-none placeholder:text-faint/60"
                placeholder={isCodex ? '如：迁移完所有调用点并通过测试' : '如：test/auth 全部通过且 lint 干净'}
                value={goalDraft}
                onChange={(e) => onGoalDraftChange(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && goalDraft.trim()) {
                    onSendGoal(goalDraft.trim())
                    onCloseGoal()
                  }
                }}
              />
              <button
                className="shrink-0 rounded-full bg-ink px-3 py-1.5 font-mono text-[11px] text-bg disabled:opacity-40"
                disabled={!goalDraft.trim()}
                onClick={() => {
                  if (!goalDraft.trim()) return
                  onSendGoal(goalDraft.trim())
                  onCloseGoal()
                }}
              >
                设定
              </button>
              {goal && (
                <button
                  className="shrink-0 rounded-full px-3 py-1.5 font-mono text-[11px] text-accent hover:bg-accent/10"
                  onClick={() => {
                    onSendGoal()
                    onCloseGoal()
                  }}
                >
                  清除
                </button>
              )}
            </div>
          </div>
        )}
      </div>

      {/* 接力链导航条：仅在当前会话参与血缘时出现 */}
      {lineage && (
        <div className="flex items-center gap-1.5 overflow-x-auto px-3 py-1.5 font-mono text-[10px]">
          <span className="shrink-0 text-faint">⇄ 接力链:</span>
          {lineage.records
            .map((r) => {
              const fromKey = r.fromResolvedKey ?? r.fromKey
              const toKey = r.toResolvedKey ?? r.toKey
              const node = (k: string, backend: 'claude' | 'codex') => {
                const info = lineage.nodes[k]
                const current = k === session.key
                return (
                  <button
                    key={k}
                    disabled={!info}
                    onClick={() => info && onNavigate?.(info)}
                    className={`flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 ${
                      current
                        ? 'bg-surface2 text-ink'
                        : 'text-faint hover:text-muted'
                    }`}
                    title={k}
                  >
                    {backend === 'codex' ? <CodexMark size={10} /> : <ClaudeMark className="h-2.5 w-2.5" />}
                    {new Date(r.at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}
                  </button>
                )
              }
              return (
                <span key={r.id} className="flex shrink-0 items-center gap-1.5">
                  {node(fromKey, r.fromBackend)}
                  <span className="text-faint/60">→</span>
                  {node(toKey, r.toBackend)}
                </span>
              )
            })}
        </div>
      )}

      {/* 后台任务 Chips 已并入右侧「后台任务」面板（运行中卡片上有停止按钮） */}

      {children}
    </div>
  )
}
