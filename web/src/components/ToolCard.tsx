import { memo, useState } from 'react'
import { toolDetail, toolSummary, type ToolBlock } from '../lib/blocks'

/** 工具调用卡片：一行 trace（图标+名称+摘要+结果状态），点击展开参数与结果。
 *  恒默认折叠、开合全由用户——没有任何自动展开（2026-10-02 决策：大量 tool use
 *  摊开阅读难度大；此前的 latestTurn 默认展开与 codex 部分结果 streaming 展开
 *  均已移除，不要加回——运行进度看行尾的 …/✓/✗，长命令想盯输出手动展开即可，
 *  本地 open 状态不会被流式更新顶掉）。
 *  memo：抄本每次 render 重建全部行；tool 块遵循不可变更新纪律（内容变必换新对象），
 *  默认浅比较即可挡掉未变卡片。 */
export const ToolCard = memo(function ToolCard(props: {
  tool: ToolBlock
  className?: string
  embedded?: boolean
}) {
  const { tool } = props
  const [open, setOpen] = useState(false)
  const summary = toolSummary(tool.name, tool.input)

  return (
    <div
      className={`${props.embedded ? '' : 'my-1.5 overflow-hidden rounded-[14px] bg-surface'} ${props.className ?? ''}`}
    >
      <button
        type="button"
        data-card="tool"
        className="flex w-full items-center gap-2 px-3 py-2 text-left font-mono text-[12px] transition-colors hover:bg-surface2"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
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
})
