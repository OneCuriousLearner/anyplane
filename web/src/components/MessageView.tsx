import { Markdown } from './Markdown'
import { ToolCard } from './ToolCard'
import { parseUserText, shortTokens, type ChatMsg } from '../lib/blocks'

/** 思考块：默认折叠 */
function Thinking(props: { text: string; streaming?: boolean }) {
  return (
    <details className="my-1.5 rounded-md border border-line/60 bg-surface2/30" open={props.streaming}>
      <summary className="cursor-pointer px-2.5 py-1.5 font-mono text-[11px] tracking-wide text-faint select-none">
        思考{props.streaming && <span className="ml-1 animate-pulse text-busy">进行中…</span>}
      </summary>
      <div className="border-t border-line/40 px-3 py-2 text-[13px] leading-relaxed whitespace-pre-wrap text-muted">
        {props.text}
      </div>
    </details>
  )
}

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
                className="inline-block rounded border border-accent/50 bg-accent/20 px-1.5 py-0.5 font-mono text-[12px] text-accent-soft"
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
                className={`mt-1 max-h-40 overflow-auto rounded border border-accent/25 bg-black/20 px-2 py-1.5 font-mono text-[11px] whitespace-pre-wrap ${
                  s.kind === 'local-err' ? 'text-danger' : 'text-muted'
                }`}
              >
                {s.text}
              </pre>
            )
          case 'interrupted':
            return (
              <span key={i} className="font-mono text-[11px] text-busy">
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

/** 抄本式消息条目：左栏角色符号 + 内容区；compact 表示与上一条同角色（连续块，收紧间距、省略符号） */
export function MessageView(props: { msg: ChatMsg; compact?: boolean }) {
  const { msg, compact } = props

  // 侧问卡片：独立样式，正文 Markdown，思考折叠，回答中有呼吸态
  if (msg.btw != null) {
    return (
      <div className="my-3 rounded-lg border border-accent/30 bg-accent/5">
        <div className="flex items-center gap-2 border-b border-accent/20 px-3 py-2">
          <span className="font-mono text-[10px] tracking-widest text-accent-soft uppercase">侧问</span>
          <span className="truncate text-xs text-muted">{msg.btw}</span>
          {msg.btwPending && <span className="ml-auto animate-pulse font-mono text-[10px] text-busy">回答中…</span>}
        </div>
        <div className="px-3 py-2">
          {msg.blocks.length === 0 && msg.btwPending && (
            <span className="cc-cursor inline-block h-3.5 w-[7px] bg-accent-soft" />
          )}
          {msg.blocks.map((b, i) => {
            if (b.kind === 'text') return <Markdown key={i} text={b.text} />
            if (b.kind === 'thinking') return <Thinking key={i} text={b.text} streaming={msg.btwPending} />
            return <ToolCard key={b.id} tool={b} />
          })}
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
      <div className={`my-2 pl-7 font-mono text-[11px] ${err ? 'text-danger' : 'text-faint'}`}>
        {msg.blocks.map((b, i) => (b.kind === 'text' ? <div key={i}>{b.text}</div> : null))}
      </div>
    )
  }

  const isUser = msg.role === 'user'
  const assistantStartsWithCard = !isUser && msg.blocks[0]?.kind !== 'text'
  return (
    <div className={`${compact ? 'my-1' : 'my-3'} flex items-start gap-2.5`}>
      <span
        className={`flex w-5 shrink-0 justify-center font-mono text-sm leading-none select-none ${
          isUser
            ? 'pt-[12px] text-accent-soft'
            : assistantStartsWithCard
              ? 'pt-[17px] text-faint'
              : 'pt-[8px] text-faint'
        }`}
        aria-hidden="true"
      >
        {compact ? '' : isUser ? '›' : <span className="block h-1.5 w-1.5 rounded-full bg-zinc-400/70" />}
      </span>
      <div
        className={`min-w-0 flex-1 ${
          isUser ? 'rounded-md border border-accent/30 bg-accent/15 px-3 py-2' : ''
        }`}
      >
        {msg.blocks.map((b, i) => {
          if (b.kind === 'text') return isUser ? <UserText key={i} text={b.text} /> : <Markdown key={i} text={b.text} />
          if (b.kind === 'thinking') return <Thinking key={i} text={b.text} />
          return <ToolCard key={b.id} tool={b} />
        })}
      </div>
    </div>
  )
}
