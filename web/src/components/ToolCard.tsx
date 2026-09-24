import { memo, useState } from 'react'
import { toolDetail, toolSummary, type ToolBlock } from '../lib/blocks'

/** 工具调用卡片：一行 trace（图标+名称+摘要+结果状态），点击展开参数与结果。
 *  streaming（codex 命令输出部分结果流入中）或 latestTurn（最新一轮，还没被下一条
 *  用户消息盖住——走查问题 7：模型说错了要当场核对它读到的原文）时默认展开；
 *  开合是派生值而非 effect——用户点过就以用户为准（流式中收起不被顶开，终态时
 *  展开不被收回，新一轮盖上后未点过的旧卡收回）。
 *  memo：抄本每次 render 重建全部行；tool 块遵循不可变更新纪律（内容变必换新对象），
 *  默认浅比较即可挡掉未变卡片。 */
export const ToolCard = memo(function ToolCard(props: {
  tool: ToolBlock
  streaming?: boolean
  /** 最新一轮的工具卡默认展开（blocks.ts buildTranscriptRows 的 latestTurn 标记） */
  defaultOpen?: boolean
  className?: string
  embedded?: boolean
}) {
  const { tool } = props
  const [userChoice, setUserChoice] = useState<boolean | null>(null)
  const open = userChoice ?? Boolean(props.streaming || props.defaultOpen)
  const summary = toolSummary(tool.name, tool.input)

  return (
    <div
      className={`${props.embedded ? '' : 'my-1.5 overflow-hidden rounded-[14px] bg-surface'} ${props.className ?? ''}`}
    >
      <button
        type="button"
        className="flex w-full items-center gap-2 px-3 py-2 text-left font-mono text-[12px] transition-colors hover:bg-surface2"
        onClick={() => setUserChoice(!open)}
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
