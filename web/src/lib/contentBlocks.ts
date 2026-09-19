// CLI / transcript content → HistoryBlock 的纯映射（text/thinking/tool_use/tool_result）。
// 与 server/src/backends/claude/contentBlocks.ts 同形；改映射须两边同步。
// 图片由调用方 onImage 承接（服务端历史落盘；前端 live sidechain 不接图）。

import type { HistoryBlock } from '@anyplane/protocol'
import { toolResultText } from './blocks'

export function cliContentToHistoryBlocks(
  content: unknown,
  onImage?: (c: Record<string, unknown>) => HistoryBlock | undefined,
): HistoryBlock[] {
  const blocks: HistoryBlock[] = []
  if (typeof content === 'string') {
    if (content.trim()) blocks.push({ kind: 'text', text: content })
    return blocks
  }
  if (!Array.isArray(content)) return blocks
  for (const raw of content as Record<string, unknown>[]) {
    if (raw?.type === 'text' && typeof raw.text === 'string' && raw.text.trim())
      blocks.push({ kind: 'text', text: raw.text })
    else if (raw?.type === 'thinking' && typeof raw.thinking === 'string' && raw.thinking.trim())
      blocks.push({ kind: 'thinking', text: raw.thinking })
    else if (raw?.type === 'tool_use')
      blocks.push({ kind: 'tool_use', name: raw.name as string, id: raw.id as string, input: raw.input })
    else if (raw?.type === 'image') {
      const img = onImage?.(raw)
      if (img) blocks.push(img)
    } else if (raw?.type === 'tool_result')
      blocks.push({
        kind: 'tool_result',
        id: raw.tool_use_id as string,
        text: toolResultText(raw.content),
        isError: raw.is_error === true,
      })
  }
  return blocks
}
