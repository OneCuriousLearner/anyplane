import { useState } from 'react'
import { toolDetail, toolSummary, type ToolBlock } from '../lib/blocks'

/** 工具调用卡片：一行 trace（图标+名称+摘要+结果状态），点击展开参数与结果 */
export function ToolCard(props: { tool: ToolBlock; className?: string }) {
  const { tool } = props
  const [open, setOpen] = useState(false)
  const summary = toolSummary(tool.name, tool.input)

  return (
    <div className={`my-1.5 overflow-hidden rounded-[14px] bg-surface ${props.className ?? ''}`}>
      <button
        className="flex w-full items-center gap-2 px-3 py-2 text-left font-mono text-[12px] transition-colors hover:bg-surface2"
        onClick={() => setOpen(!open)}
      >
        <span className="text-faint">{open ? '▾' : '▸'}</span>
        <span className="shrink-0 font-semibold text-ink">{tool.name}</span>
        <span className="truncate text-muted">{summary}</span>
        <span className="ml-auto shrink-0">
          {tool.pending ? (
            <span className="text-faint">…</span>
          ) : tool.resultError ? (
            <span className="text-accent">✗</span>
          ) : tool.resultText != null ? (
            <span className="text-ok">✓</span>
          ) : null}
        </span>
      </button>
      {open && (
        <div className="bg-bg/50">
          <pre className="max-h-56 overflow-auto px-3 py-2 font-mono text-[11px] leading-relaxed whitespace-pre-wrap text-muted">
            {toolDetail(tool.name, tool.input) || '（无参数）'}
          </pre>
          {tool.resultText != null && (
            <pre
              className={`max-h-56 overflow-auto px-3 py-2 font-mono text-[11px] leading-relaxed whitespace-pre-wrap ${
                tool.resultError ? 'text-accent' : 'text-ink/80'
              }`}
            >
              {tool.resultText.length > 4000 ? tool.resultText.slice(0, 4000) + '\n…（截断）' : tool.resultText}
            </pre>
          )}
        </div>
      )}
    </div>
  )
}
