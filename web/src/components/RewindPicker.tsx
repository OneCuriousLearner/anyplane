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
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 md:items-center" onClick={props.onClose}>
      <div
        className="max-h-[70dvh] w-full max-w-lg overflow-y-auto rounded-t-xl bg-zinc-900 p-4 md:rounded-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-zinc-100">选择回滚到的消息</h2>
          <button className="text-zinc-400 hover:text-zinc-200" onClick={props.onClose}>
            ✕
          </button>
        </div>
        {props.targets.length === 0 && <p className="text-sm text-zinc-500">没有可回滚的用户消息</p>}
        {props.targets.map((t) => (
          <div key={t.uuid} className="mb-2 rounded bg-zinc-800 p-3">
            <p className="mb-2 line-clamp-2 text-sm text-zinc-200">{t.text || '（空消息）'}</p>
            <div className="flex gap-2">
              <button
                className="flex-1 rounded bg-zinc-700 py-1.5 text-xs hover:bg-zinc-600"
                onClick={() => props.onRewindFiles(t.uuid)}
              >
                仅回滚文件
              </button>
              <button
                className="flex-1 rounded bg-amber-700 py-1.5 text-xs hover:bg-amber-600"
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
