import { Markdown } from './Markdown'
import { ActivityGroup } from './ActivityGroup'
import {
  groupCollapsibleRuns,
  parseUserText,
  shortTokens,
  type Block,
  type ChatMsg,
} from '../lib/blocks'

/** user 消息文本：解析斜杠命令回显 / 本地命令输出 / 中断标记 */
function UserText(props: { text: string }) {
  const segs = parseUserText(props.text)
  if (segs.length === 0) return null
  return (
    <>
      {segs.map((s, i) => {
        switch (s.kind) {
          case 'command':
            return (
              <span
                key={i}
                className="inline-block rounded-full bg-transparent px-2 py-0.5 font-mono text-[12px] text-muted"
              >
                {s.text}
                {s.args ? ` ${s.args}` : ''}
              </span>
            )
          case 'local-out':
          case 'local-err':
            return (
              <pre
                key={i}
                className={`mt-1 max-h-40 overflow-auto rounded-[10px] bg-transparent px-2 py-1.5 font-mono text-[11px] whitespace-pre-wrap ${
                  s.kind === 'local-err' ? 'text-accent' : 'text-muted'
                }`}
              >
                {s.text}
              </pre>
            )
          case 'interrupted':
            return (
              <span key={i} className="font-mono text-[11px] text-muted">
                ■ 已被用户中断
              </span>
            )
          default:
            return <Markdown key={i} text={s.text} />
        }
      })}
    </>
  )
}

/** 图片附件：侧问卡片 / user 气泡 / assistant 块三处展示共用 */
function ImageAttachment(props: { src?: string }) {
  return (
    <img
      src={props.src}
      alt="图片附件"
      loading="lazy"
      className="my-1.5 max-h-64 max-w-full rounded-[10px] object-contain"
    />
  )
}

function contentKey(b: Block, i: number): string {
  return b.kind === 'tool' ? b.id : `${b.kind}:${i}`
}

/** 把相邻思考/工具收成一组；flush 用于已有底的容器（侧问、用户气泡） */
function BlockRuns(props: { blocks: Block[]; thinkingStreaming?: boolean; flush?: boolean }) {
  return (
    <>
      {groupCollapsibleRuns(props.blocks).map((run, i) => {
        if (run.kind === 'collapsible') {
          return (
            <ActivityGroup
              key={`g${i}`}
              flush={props.flush}
              items={run.blocks.map((b, j) => ({
                key: contentKey(b, j),
                block: b,
                streaming: b.kind === 'thinking' ? props.thinkingStreaming : undefined,
              }))}
            />
          )
        }
        const b = run.block
        if (b.kind === 'image') return <ImageAttachment key={i} src={b.src} />
        if (b.kind === 'text') return <Markdown key={i} text={b.text} />
        return null
      })}
    </>
  )
}

/** 消息条目：user 右靠气泡 / assistant 按块分行；compact 表示与上一条同角色（连续块，收紧间距） */
export function MessageView(props: { msg: ChatMsg; compact?: boolean }) {
  const { msg, compact } = props

  // 侧问卡片：独立样式，正文 Markdown，思考折叠
  if (msg.btw != null) {
    return (
      <div className="my-3 rounded-[14px] bg-surface">
        <div className="flex items-center gap-2 px-3 py-2">
          <span className="font-mono text-[10px] tracking-widest text-muted uppercase">侧问</span>
          <span className="truncate text-xs text-muted">{msg.btw}</span>
          {msg.btwPending && <span className="ml-auto font-mono text-[10px] text-faint">回答中…</span>}
        </div>
        <div className="px-3 pb-2">
          {msg.blocks.length === 0 && msg.btwPending && (
            <span className="cc-cursor inline-block h-3.5 w-[7px] bg-muted" />
          )}
          <BlockRuns blocks={msg.blocks} thinkingStreaming={msg.btwPending} flush />
        </div>
      </div>
    )
  }

  if (msg.role === 'system') {
    if (msg.systemKind === 'divider') {
      return (
        <div className="my-3 flex items-center gap-3 text-faint">
          <div className="h-px flex-1 bg-line" />
          <span className="font-mono text-[10px] tracking-widest uppercase">
            {msg.compactMeta
              ? `上下文已压缩 ${shortTokens(msg.compactMeta.preTokens)}→${shortTokens(msg.compactMeta.postTokens)}`
              : msg.blocks[0]?.kind === 'text'
                ? msg.blocks[0].text
                : ''}
          </span>
          <div className="h-px flex-1 bg-line" />
        </div>
      )
    }
    const err = msg.systemKind === 'error'
    return (
      <div className={`my-2 pl-7 font-mono text-[11px] ${err ? 'text-accent' : 'text-faint'}`}>
        {msg.blocks.map((b, i) => (b.kind === 'text' ? <div key={i}>{b.text}</div> : null))}
      </div>
    )
  }

  const isUser = msg.role === 'user'

  // user 消息右靠气泡（中性灰，不占用彩色面）；assistant 按块分行
  if (isUser) {
    const runs = groupCollapsibleRuns(msg.blocks)
    return (
      <div className={`${compact ? 'my-1' : 'my-3'} flex justify-end`}>
        <div className="max-w-[85%] rounded-[14px] bg-user-bubble px-3.5 py-2.5">
          {runs.map((run, i) => {
            if (run.kind === 'collapsible') {
              return (
                <ActivityGroup
                  key={`g${i}`}
                  flush
                  items={run.blocks.map((b, j) => ({
                    key: contentKey(b, j),
                    block: b,
                  }))}
                />
              )
            }
            const b = run.block
            if (b.kind === 'image') return <ImageAttachment key={i} src={b.src} />
            if (b.kind === 'text') return <UserText key={i} text={b.text} />
            return null
          })}
        </div>
      </div>
    )
  }

  return (
    <div className={`${compact ? 'my-1' : 'my-3'} flex flex-col`}>
      <BlockRuns blocks={msg.blocks} />
    </div>
  )
}
