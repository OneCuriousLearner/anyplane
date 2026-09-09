import { memo } from 'react'
import type { DraftBlockLike, TranscriptRow } from '../lib/blocks'
import { ActivityGroup } from './ActivityGroup'
import { ImageAttachment } from './ImageAttachment'
import { Markdown } from './Markdown'
import { MessageView } from './MessageView'

/** 行的稳定 key：窗口化扩窗会让行的数组下标整体平移，索引 key 会导致整棵子树 remount，
 *  用户已展开的思考/工具卡（Thinking/ToolCard 的局部 open 状态）会被重置。
 *  行内容首块 key 由消息 id / 工具 id 派生，跨窗口平移稳定且行间唯一。 */
function rowKey(row: TranscriptRow, i: number): string {
  if (row.type === 'message') return row.msg.id
  if (row.type === 'activity') return `act:${row.items[0]?.key ?? i}`
  return `c:${row.blocks[0]?.key ?? i}`
}

/** 对话抄本：跨消息合并相邻思考/工具，流式草稿并进同一组。
 *  memo + useMemo：messages/draft 引用不变（输入击键、status 广播）时整棵树跳过重建。
 *
 *  长会话窗口化：调用方传入的 rows 已是尾部窗口切片（useTranscriptScroll），
 *  本组件保持纯展示；窗口方案与两次回退的根因见 docs/ROADMAP.md。 */
export const Transcript = memo(function Transcript(props: {
  /** 已摊平并切片的渲染行，由 Chat 层 useMemo 持有（Transcript 保持纯展示） */
  rows: readonly TranscriptRow[]
  draft?: { blocks: readonly DraftBlockLike[] } | null
}) {
  const rows = props.rows
  const showCursor =
    Boolean(props.draft?.blocks.length) && props.draft!.blocks.every((b) => b.kind !== 'text')

  return (
    <>
      {rows.map((row, i) => {
        if (row.type === 'message') {
          return <MessageView key={rowKey(row, i)} msg={row.msg} compact={row.compact} />
        }
        if (row.type === 'activity') {
          return <ActivityGroup key={rowKey(row, i)} items={row.items} compact={row.compact} />
        }
        return (
          <div
            key={rowKey(row, i)}
            className={`${row.compact ? 'my-1' : 'my-3'} flex flex-col`}
          >
            {row.blocks.map((b) => (
              <div key={b.key} className="min-w-0">
                {b.block.kind === 'image' ? (
                  <ImageAttachment src={b.block.src} />
                ) : b.block.kind === 'text' ? (
                  <div className="relative">
                    <Markdown text={b.block.text} />
                    {b.streaming && (
                      <span className="cc-cursor ml-0.5 inline-block h-3.5 w-[7px] bg-muted align-text-bottom" />
                    )}
                  </div>
                ) : null}
              </div>
            ))}
          </div>
        )
      })}
      {showCursor && (
        <div className="min-w-0">
          <span className="cc-cursor inline-block h-3.5 w-[7px] bg-muted" />
        </div>
      )}
    </>
  )
})
