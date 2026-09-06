import { memo } from 'react'
import type { DraftBlockLike, TranscriptRow } from '../lib/blocks'
import { ActivityGroup } from './ActivityGroup'
import { ImageAttachment } from './ImageAttachment'
import { Markdown } from './Markdown'
import { MessageView } from './MessageView'

/** 对话抄本：跨消息合并相邻思考/工具，流式草稿并进同一组。
 *  memo + useMemo：messages/draft 引用不变（输入击键、status 广播）时整棵树跳过重建。
 *
 *  长会话渲染优化（窗口化 / content-visibility）见 ROADMAP：两者都试过并回退，
 *  根因都是与「打开会话即滚到最新」的交互，记在那里避免重复踩。 */
export const Transcript = memo(function Transcript(props: {
  /** 已摊平的渲染行，由 Chat 层 useMemo 持有（Transcript 保持纯展示） */
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
          return <MessageView key={row.msg.id} msg={row.msg} compact={row.compact} />
        }
        if (row.type === 'activity') {
          return <ActivityGroup key={`act-${i}`} items={row.items} compact={row.compact} />
        }
        return (
          <div
            key={`c-${i}`}
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
