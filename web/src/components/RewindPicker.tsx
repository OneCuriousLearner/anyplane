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

// 模块级共享实例，避免每行渲染重复构造 Intl.DateTimeFormat
const timeFormatter = new Intl.DateTimeFormat('zh-CN', {
  month: 'numeric',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
})

function formatTime(timestamp?: string): string | undefined {
  if (!timestamp) return undefined
  const date = new Date(timestamp)
  if (Number.isNaN(date.getTime())) return undefined
  return timeFormatter.format(date)
}

export function RewindPicker(props: {
  targets: RewindTarget[]
  onRewindFiles: (uuid: string) => void
  onRewindConversation: (uuid: string) => void
  onRewindBoth: (uuid: string) => void
  onClose: () => void
  /** codex：回滚语义按线程 historyMode 分流（status 下发）——
   *  paginated：thread/revert 原地截断，会话不变；legacy：thread/fork 分叉新线程；
   *  缺省（status 未下发）：中性文案，绝不谎报「原会话不动」 */
  mode?: 'claude' | 'codex'
  historyMode?: string
}) {
  const isCodex = props.mode === 'codex'
  // 三态：paginated=原地截断 / legacy=分叉新线程 / 缺省（服务端重启等 status 未下发）=中性文案——
  // 绝不能缺省兜底成分叉文案：paginated 线程实际执行的是破坏性原地 revert，
  // 「原会话不动」的承诺与真实行为相反（审查发现）
  const codexRevert = isCodex && props.historyMode === 'paginated'
  const codexFork = isCodex && props.historyMode === 'legacy'
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/70 md:items-center" onClick={props.onClose}>
      <div
        className="max-h-[70dvh] w-full max-w-lg overflow-y-auto rounded-[14px] bg-surface2/90 p-4 shadow-[0_24px_60px_-12px_rgba(0,0,0,0.55)] backdrop-blur-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-center justify-between">
          <h2 className="font-mono text-xs tracking-widest text-muted uppercase">
            {isCodex ? (codexRevert ? '回滚到…' : codexFork ? '从…分叉' : '回滚 / 分叉') : '回滚到…'}
          </h2>
          <button className="text-faint hover:text-ink" onClick={props.onClose}>
            ✕
          </button>
        </div>
        {props.targets.length > 0 && !isCodex && (
          <p className="mb-3 text-xs leading-relaxed text-faint">选择一条用户消息作为目标；可单独恢复文件、单独恢复对话，或同时恢复两者。</p>
        )}
        {props.targets.length > 0 && isCodex && (
          <p className="mb-3 text-xs leading-relaxed text-faint">
            {codexRevert
              ? '选择一条用户消息：该消息所在轮及其后的全部内容将从会话中移除，会话原地继续。'
              : codexFork
                ? '选择一条用户消息：新会话将携带该消息所在轮之前的全部历史，原会话保持不动。'
                : '选择一条用户消息：该消息所在轮及其后内容将被移除；旧格式的会话会改为分叉为新会话（原会话不动）。'}
          </p>
        )}
        {props.targets.length === 0 && (
          <p className="text-sm text-muted">没有可回滚的用户消息（compact 之前的内容不可回滚）</p>
        )}
        {props.targets.map((t) => {
          const time = formatTime(t.timestamp)
          return (
          <div key={t.uuid} className="mb-2 rounded-[14px] bg-surface p-3">
            <div className="mb-2 flex items-center gap-2">
              <span className="font-mono text-[10px] text-faint">用户消息</span>
              {time && <span className="font-mono text-[10px] text-faint">{time}</span>}
            </div>
            <p className="text-sm leading-relaxed text-ink">{t.summary || '（无可显示的用户文本）'}</p>
            {t.detail && t.detail !== t.summary && (
              <details className="mt-2 rounded-[10px] bg-bg/50">
                <summary className="cursor-pointer px-2 py-1.5 font-mono text-[11px] text-muted select-none">查看完整内容</summary>
                <pre className="max-h-48 overflow-auto px-2 py-1.5 font-mono text-[11px] leading-relaxed text-muted whitespace-pre-wrap">
                  {t.detail}
                </pre>
              </details>
            )}
            {isCodex ? (
              <button
                className="mt-2 w-full rounded-full bg-ink py-1.5 font-mono text-[11px] font-medium text-bg"
                onClick={() => props.onRewindConversation(t.uuid)}
              >
                {codexRevert ? '回滚到此处（该消息及之后被移除）' : codexFork ? '从此处分叉（原会话不动）' : '回滚 / 分叉到此处'}
              </button>
            ) : (
            <div className="grid grid-cols-2 gap-2">
              <button
                className="rounded-full bg-surface2 py-1.5 font-mono text-[11px] text-muted hover:text-ink"
                onClick={() => props.onRewindFiles(t.uuid)}
              >
                仅回滚文件
              </button>
              <button
                className="rounded-full bg-surface2 py-1.5 font-mono text-[11px] text-muted hover:text-ink"
                onClick={() => props.onRewindConversation(t.uuid)}
              >
                仅回滚对话
              </button>
              <button
                className="col-span-2 rounded-full bg-ink py-1.5 font-mono text-[11px] font-medium text-bg"
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
