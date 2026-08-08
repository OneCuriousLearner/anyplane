import type { ApprovalDecision } from '../lib/decision'

export function ApprovalCard(props: {
  approval: { requestId: string; toolName: string; input: unknown }
  onDecision: (d: ApprovalDecision) => void
}) {
  const { approval, onDecision } = props
  const inputStr = JSON.stringify(approval.input, null, 2) ?? ''

  return (
    <div className="my-3 rounded-lg border border-amber-600/50 bg-amber-950/40 p-3">
      <div className="mb-2 flex items-center gap-2 text-sm font-medium text-amber-300">
        <span>🛡️ 工具审批</span>
        <span className="rounded bg-amber-800/60 px-1.5 py-0.5 text-xs">{approval.toolName}</span>
      </div>
      <pre className="mb-3 max-h-48 overflow-auto rounded bg-zinc-900 p-2 text-xs text-zinc-300">
        {inputStr.length > 2000 ? inputStr.slice(0, 2000) + '\n…（截断）' : inputStr}
      </pre>
      <div className="flex gap-2">
        <button
          className="flex-1 rounded bg-green-700 py-2 text-sm hover:bg-green-600"
          onClick={() => {
            const input = approval.input as Record<string, unknown> | undefined
            onDecision({ behavior: 'allow', updatedInput: input })
          }}
        >
          ✓ 允许
        </button>
        <button
          className="flex-1 rounded bg-red-800 py-2 text-sm hover:bg-red-700"
          onClick={() => onDecision({ behavior: 'deny', message: '用户在远程端拒绝了该操作' })}
        >
          ✗ 拒绝
        </button>
      </div>
    </div>
  )
}
