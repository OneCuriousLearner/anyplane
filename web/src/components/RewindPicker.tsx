// /rewind 消息选择器：列出用户消息，支持"仅回滚文件"与"回滚对话+文件"

export interface RewindTarget {
  uuid: string
  /** 清理内部标签后的单行摘要。 */
  summary: string
  /** 供展开确认的完整可读文本。 */
  detail: string
  /** 历史消息时间（若可用）。 */
  timestamp?: string
}

function formatTime(timestamp?: string): string | undefined {
  if (!timestamp) return undefined
  const date = new Date(timestamp)
  if (Number.isNaN(date.getTime())) return undefined
  // 模块级共享实例，避免每行渲染重复构造 Intl.DateTimeFormat
  return timeFormatter.format(date)
}

const timeFormatter = new Intl.DateTimeFormat('zh-CN', {
  month: 'numeric',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
})

export function RewindPicker(props: {
  targets: RewindTarget[]
  onRewindFiles: (uuid: string) => void
  onRewindConversation: (uuid: string) => void
  onRewindBoth: (uuid: string) => void
  onClose: () => void
  /** codex：分叉语义（thread/fork beforeTurnId），无文件回滚 */
  mode?: 'claude' | 'codex'
}) {
  const isCodex = props.mode === 'codex'
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/70 md:items-center" onClick={props.onClose}>
      <div
        className="max-h-[70dvh] w-full max-w-lg overflow-y-auto rounded-t-xl border border-line bg-surface p-4 md:rounded-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-center justify-between">
          <h2 className="font-mono text-xs tracking-widest text-muted uppercase">{isCodex ? '从…分叉' : '回滚到…'}</h2>
          <button className="text-faint hover:text-ink" onClick={props.onClose}>
            ✕
          </button>
        </div>
        {props.targets.length > 0 && !isCodex && (
          <p className="mb-3 text-xs leading-relaxed text-faint">选择一条用户消息作为目标；可单独恢复文件、单独恢复对话，或同时恢复两者。</p>
        )}
        {props.targets.length > 0 && isCodex && (
          <p className="mb-3 text-xs leading-relaxed text-faint">选择一条用户消息：新会话将携带该消息所在轮<b>之前</b>的全部历史，原会话保持不动。</p>
        )}
        {props.targets.length === 0 && (
          <p className="text-sm text-muted">没有可回滚的用户消息（compact 之前的内容不可回滚）</p>
        )}
        {props.targets.map((t) => {
          const time = formatTime(t.timestamp)
          return (
          <div key={t.uuid} className="mb-2 rounded border border-line bg-surface2/50 p-3">
            <div className="mb-2 flex items-center gap-2">
              <span className="font-mono text-[10px] text-faint">用户消息</span>
              {time && <span className="font-mono text-[10px] text-faint">{time}</span>}
            </div>
            <p className="text-sm leading-relaxed text-ink">{t.summary || '（无可显示的用户文本）'}</p>
            {t.detail && t.detail !== t.summary && (
              <details className="mt-2 rounded border border-line/60 bg-surface/40">
                <summary className="cursor-pointer px-2 py-1.5 font-mono text-[11px] text-muted select-none">查看完整内容</summary>
                <pre className="max-h-48 overflow-auto border-t border-line/60 px-2 py-1.5 font-mono text-[11px] leading-relaxed text-muted whitespace-pre-wrap">
                  {t.detail}
                </pre>
              </details>
            )}
            {isCodex ? (
              <button
                className="mt-2 w-full rounded bg-accent/90 py-1.5 font-mono text-[11px] font-medium text-bg hover:bg-accent"
                onClick={() => props.onRewindConversation(t.uuid)}
              >
                从此处分叉（原会话不动）
              </button>
            ) : (
            <div className="grid grid-cols-2 gap-2">
              <button
                className="rounded border border-line py-1.5 font-mono text-[11px] text-muted hover:bg-surface2 hover:text-ink"
                onClick={() => props.onRewindFiles(t.uuid)}
              >
                仅回滚文件
              </button>
              <button
                className="rounded border border-line py-1.5 font-mono text-[11px] text-muted hover:bg-surface2 hover:text-ink"
                onClick={() => props.onRewindConversation(t.uuid)}
              >
                仅回滚对话
              </button>
              <button
                className="col-span-2 rounded bg-accent/90 py-1.5 font-mono text-[11px] font-medium text-bg hover:bg-accent"
                onClick={() => props.onRewindBoth(t.uuid)}
              >
                回滚对话+文件
              </button>
            </div>
            )}
          </div>
          )
        })}
      </div>
    </div>
  )
}
