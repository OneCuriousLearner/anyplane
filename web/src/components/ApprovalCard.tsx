import type { ApprovalDecision } from '../lib/decision'

export function ApprovalCard(props: {
  approval: { requestId: string; toolName: string; input: unknown }
  onDecision: (d: ApprovalDecision) => void
}) {
  const { approval, onDecision } = props
  const inputStr = JSON.stringify(approval.input, null, 2) ?? ''

  return (
    <div className="my-3 rounded-lg border border-busy/50 bg-busy/5">
      <div className="flex items-center gap-2 border-b border-busy/30 px-3 py-2">
        <span className="font-mono text-xs tracking-widest text-busy uppercase">审批</span>
        <span className="rounded border border-busy/40 bg-busy/10 px-1.5 py-0.5 font-mono text-[11px] text-busy">
          {approval.toolName}
        </span>
        <span className="ml-auto font-mono text-[10px] text-faint">等待你的裁决</span>
      </div>
      <pre className="max-h-48 overflow-auto px-3 py-2 font-mono text-[11px] leading-relaxed text-muted">
        {inputStr.length > 2000 ? inputStr.slice(0, 2000) + '\n…（截断）' : inputStr}
      </pre>
      <div className="flex gap-2 border-t border-busy/30 p-2">
        <button
          className="flex-1 rounded bg-ok/90 py-2 text-sm font-medium text-bg hover:bg-ok"
          onClick={() => {
            const input = approval.input as Record<string, unknown> | undefined
            onDecision({ behavior: 'allow', updatedInput: input })
          }}
        >
          ✓ 允许
        </button>
        <button
          className="flex-1 rounded border border-danger/60 py-2 text-sm text-danger hover:bg-danger/10"
          onClick={() => onDecision({ behavior: 'deny', message: '用户在远程端拒绝了该操作' })}
        >
          ✗ 拒绝
        </button>
      </div>
    </div>
  )
}
