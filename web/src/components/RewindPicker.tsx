// /rewind 消息选择器：列出用户消息，支持"仅回滚文件"与"回滚对话+文件"

export interface RewindTarget {
  uuid: string
  text: string
}

export function RewindPicker(props: {
  targets: RewindTarget[]
  onRewindFiles: (uuid: string) => void
  onRewindConversation: (uuid: string) => void
  onClose: () => void
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/70 md:items-center" onClick={props.onClose}>
      <div
        className="max-h-[70dvh] w-full max-w-lg overflow-y-auto rounded-t-xl border border-line bg-surface p-4 md:rounded-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-center justify-between">
          <h2 className="font-mono text-xs tracking-widest text-muted uppercase">回滚到…</h2>
          <button className="text-faint hover:text-ink" onClick={props.onClose}>
            ✕
          </button>
        </div>
        {props.targets.length === 0 && (
          <p className="text-sm text-muted">没有可回滚的用户消息（compact 之前的内容不可回滚）</p>
        )}
        {props.targets.map((t) => (
          <div key={t.uuid} className="mb-2 rounded border border-line bg-surface2/50 p-3">
            <p className="mb-2 line-clamp-2 text-sm text-ink">{t.text || '（空消息）'}</p>
            <div className="flex gap-2">
              <button
                className="flex-1 rounded border border-line py-1.5 font-mono text-[11px] text-muted hover:bg-surface2 hover:text-ink"
                onClick={() => props.onRewindFiles(t.uuid)}
              >
                仅回滚文件
              </button>
              <button
                className="flex-1 rounded bg-accent/90 py-1.5 font-mono text-[11px] font-medium text-bg hover:bg-accent"
                onClick={() => props.onRewindConversation(t.uuid)}
              >
                回滚对话+文件
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
