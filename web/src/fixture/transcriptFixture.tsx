// 抄本窗口化验收 fixture（方向七）：合成 300+ 渲染行的混合抄本，
// 驱动与 Chat 完全同一份 useTranscriptScroll + buildTranscriptRows + Transcript。
//
// 仅 Vite dev 提供（/transcript-fixture.html）；生产构建默认只打 index.html，本页不进 dist。
// ?autorun=1 自动跑四段场景并把结果写到 window.__fixtureResult 与 #results <pre>，
// 供浏览器自动化（chrome-devtools MCP）读取；断言全过 document.title 变为 FIXTURE:PASS。
//
// 场景（对齐 ROADMAP 方向七验收口径）：
//   S1 打开会话：首绘 layout 阶段 auto 直达底部，只挂载尾部窗口，无 smooth 漂移
//   S2 流式追加：atBottom 期间持续追加，挂载行数恒定有界（DOM 不随会话长度增长）
//   S3 手动上翻：向上滚动逐段扩窗到顶，锚定补偿保证视口内容不跳变
//   S4 回到底部：jumpToBottom 恢复尾部窗口，挂载重回收敛且停在底部

import { createRoot } from 'react-dom/client'
import { useEffect, useMemo, useRef, useState } from 'react'
import '../index.css'
import { buildTranscriptRows, type ChatMsg, type Block } from '../lib/blocks'
import { WINDOW_TAIL_ROWS } from '../lib/transcriptWindow'
import { useTranscriptScroll } from '../hooks/useTranscriptScroll'
import { Transcript } from '../components/Transcript'

// ---------------------------------------------------------------------------
// 合成数据：每 turn = user + [thinking+tool][text][tool][text][tool][text] ≈ 7 行
// ---------------------------------------------------------------------------

const TURNS = 46 // ≈ 322 渲染行

function longText(t: number, k: number): string {
  return `第 ${t} 轮第 ${k} 段正文。\n\n这里是一段 markdown：\n\n- 要点 A（fixture 行 ${t}.${k}）\n- 要点 B\n\n\`\`\`ts\nconst turn = ${t}\nconsole.log(turn)\n\`\`\`\n\n结尾句。`
}

function makeMessages(): ChatMsg[] {
  const msgs: ChatMsg[] = []
  for (let t = 0; t < TURNS; t++) {
    msgs.push({
      id: `fx-u-${t}`,
      role: 'user',
      blocks: [{ kind: 'text', text: `第 ${t} 轮用户指令：请处理模块 ${t} 的改造` }],
    })
    const blocks: Block[] = [
      { kind: 'thinking', text: `思考 ${t}：` + '分析上下文与约束。'.repeat(6) },
      { kind: 'tool', id: `fx-t${t}-a`, name: 'Bash', input: { command: `ls module-${t}` }, resultText: `ok ${t}\n` + '输出行。\n'.repeat(30) },
      { kind: 'text', text: longText(t, 0) },
      { kind: 'tool', id: `fx-t${t}-b`, name: 'Read', input: { file_path: `/src/module-${t}/index.ts` }, resultText: '文件内容。\n'.repeat(40) },
      { kind: 'text', text: longText(t, 1) },
      { kind: 'tool', id: `fx-t${t}-c`, name: 'Edit', input: { file_path: `/src/module-${t}/index.ts` }, resultText: 'applied' },
      { kind: 'text', text: longText(t, 2) },
    ]
    msgs.push({ id: `fx-a-${t}`, role: 'assistant', blocks })
  }
  return msgs
}

// ---------------------------------------------------------------------------
// 场景驱动小工具
// ---------------------------------------------------------------------------

const frames = (n: number) =>
  new Promise<void>((r) => {
    const step = (left: number) => (left <= 0 ? r() : requestAnimationFrame(() => step(left - 1)))
    step(n)
  })
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

interface FixtureState {
  scrollTop: number
  scrollHeight: number
  clientHeight: number
  atBottom: boolean
  windowStart: number
  rowCount: number
  mountedRows: number
  streaming: boolean
}

declare global {
  interface Window {
    __fixtureState?: FixtureState
    __fixtureResult?: { pass: boolean; lines: string[] }
  }
}

function Fixture() {
  const [messages, setMessages] = useState<ChatMsg[]>(makeMessages)
  const [draftText, setDraftText] = useState<string | null>(null)
  const [results, setResults] = useState<string[] | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)

  const draft = useMemo(
    () => (draftText == null ? null : { blocks: [{ idx: 0, kind: 'text' as const, text: draftText }] }),
    [draftText],
  )
  const rows = useMemo(() => buildTranscriptRows(messages, draft), [messages, draft])
  const { windowStart, atBottom, onScroll, jumpToBottom, expandWindow } = useTranscriptScroll({
    scrollRef,
    rowCount: rows.length,
    resetKey: 'fixture',
    followDeps: [messages, draft],
    streaming: draft != null,
  })
  const visibleRows = useMemo(() => rows.slice(windowStart), [rows, windowStart])

  // 状态桥：每渲染把内部状态吐给 window，供自动化读取
  const el = scrollRef.current
  window.__fixtureState = {
    scrollTop: el?.scrollTop ?? -1,
    scrollHeight: el?.scrollHeight ?? -1,
    clientHeight: el?.clientHeight ?? -1,
    atBottom,
    windowStart,
    rowCount: rows.length,
    mountedRows: visibleRows.length,
    streaming: draft != null,
  }

  /** 流式追加：40ms 一个 token，共 25 拍，然后定稿进 messages（tool+text 两块=两行，
   *  纯 text 会被相邻 content 行合并导致行数不变——S2 断言需要真实行数增长），重复 count 条 */
  const appendStreaming = async (count: number) => {
    for (let m = 0; m < count; m++) {
      let text = ''
      for (let i = 0; i < 25; i++) {
        text += `流式 token ${m}-${i}。`
        setDraftText(text)
        await sleep(40)
      }
      const finalText = text
      setMessages((prev) => [
        ...prev,
        {
          id: `fx-s-${m}`,
          role: 'assistant',
          blocks: [
            { kind: 'tool', id: `fx-s-t${m}`, name: 'Bash', input: { command: `echo ${m}` }, resultText: `done ${m}` },
            { kind: 'text', text: finalText },
          ],
        },
      ])
      setDraftText(null)
      await frames(2)
    }
  }

  const runAll = async () => {
    const lines: string[] = []
    const note = (ok: boolean, label: string, detail = '') => {
      lines.push(`${ok ? '✓' : '✗'} ${label}${detail ? ` — ${detail}` : ''}`)
    }
    const st = () => window.__fixtureState!

    await frames(4)
    // ---- S1 打开定位 ----
    {
      const s = st()
      const bottomGap = s.scrollHeight - s.scrollTop - s.clientHeight
      note(bottomGap <= 1 && s.atBottom, 'S1 首绘直达底部', `gap=${bottomGap}`)
      note(s.windowStart === s.rowCount - WINDOW_TAIL_ROWS, 'S1 只挂载尾部窗口', `start=${s.windowStart}/${s.rowCount}`)
      note(s.mountedRows === WINDOW_TAIL_ROWS, 'S1 挂载行数=尾窗', `mounted=${s.mountedRows}`)
      const before = s.scrollTop
      await sleep(350)
      note(st().scrollTop === before, 'S1 无 smooth 漂移', `Δ=${st().scrollTop - before}`)
    }

    // ---- S2 流式追加 ----
    {
      const rowsBefore = st().rowCount
      await appendStreaming(6)
      const s = st()
      note(s.rowCount > rowsBefore, 'S2 行数增长', `${rowsBefore}→${s.rowCount}`)
      note(s.mountedRows <= WINDOW_TAIL_ROWS + 2, 'S2 流式期间挂载行数有界', `mounted=${s.mountedRows}`)
      const bottomGap = s.scrollHeight - s.scrollTop - s.clientHeight
      note(bottomGap <= 1 && s.atBottom, 'S2 流式结束仍钉在底部', `gap=${bottomGap}`)
    }

    // ---- S3 手动上翻 ----
    {
      const el = scrollRef.current!
      let anchorOk = true
      let anchorDetail = ''
      for (let i = 0; i < 200; i++) {
        if ((window.__fixtureState?.windowStart ?? 0) === 0 && el.scrollTop <= 2) break
        const startBefore = window.__fixtureState?.windowStart ?? 0
        // 锚点取证：给视口内元素打临时属性并记录其 y，扩窗后精确找回同一元素比对位移。
        // 向上滚动使元素在视口中下移（scrollTop -600 ⇒ viewport top +600，delta ≈ -600）；
        // 锚定补偿失效时扩窗 prepend 会额外叠加数千 px 位移
        const probe = document.elementFromPoint(el.clientWidth / 2, 200) as HTMLElement | null
        const beforeTop = probe?.getBoundingClientRect().top
        probe?.setAttribute('data-fx-anchor', '1')
        el.scrollTop = Math.max(0, el.scrollTop - 600)
        await sleep(50)
        await frames(2)
        const startAfter = window.__fixtureState?.windowStart ?? 0
        const hit = el.querySelector('[data-fx-anchor="1"]') as HTMLElement | null
        hit?.removeAttribute('data-fx-anchor')
        if (startAfter < startBefore && probe && hit && beforeTop != null) {
          const delta = beforeTop - hit.getBoundingClientRect().top
          if (Math.abs(delta + 600) > 120) {
            anchorOk = false
            anchorDetail = `位移 ${delta.toFixed(0)}px 异常（期望≈-600）`
            break
          }
        }
      }
      const s = st()
      note(s.windowStart === 0, 'S3 扩窗到顶（全部挂载）', `start=${s.windowStart} mounted=${s.mountedRows}/${s.rowCount}`)
      note(anchorOk, 'S3 扩窗锚定补偿无跳变', anchorDetail)
    }

    // ---- S4 回到底部 ----
    {
      jumpToBottom()
      await sleep(50)
      await frames(3)
      const s = st()
      const bottomGap = s.scrollHeight - s.scrollTop - s.clientHeight
      note(bottomGap <= 1 && s.atBottom, 'S4 回到底部', `gap=${bottomGap}`)
      note(s.mountedRows <= WINDOW_TAIL_ROWS + 2, 'S4 窗口重回收敛', `mounted=${s.mountedRows}`)
    }

    const pass = lines.every((l) => l.startsWith('✓'))
    window.__fixtureResult = { pass, lines }
    document.title = pass ? 'FIXTURE:PASS' : 'FIXTURE:FAIL'
    setResults(lines)
  }

  const autorun = new URLSearchParams(location.search).has('autorun')
  const ranRef = useRef(false)
  useEffect(() => {
    if (autorun && !ranRef.current) {
      ranRef.current = true
      void runAll()
    }
    // runAll 只需触发一次；闭包内 setState 全部走 React 状态，无需依赖
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <div className="relative flex h-dvh flex-col bg-bg text-ink">
      <div className="border-b border-line px-4 py-2 font-mono text-[11px] text-faint">
        抄本窗口 fixture · {rows.length} 行（挂载 {visibleRows.length}）· 窗口起点 {windowStart}
        {results == null && autorun && ' · 运行中…'}
      </div>
      <div ref={scrollRef} onScroll={onScroll} className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl px-[17px] pb-[300px] pt-[84px] md:px-[29px]">
          {windowStart > 0 && (
            <button
              type="button"
              onClick={expandWindow}
              className="mb-3 w-full rounded-[14px] bg-surface/60 py-2 font-mono text-[11px] tracking-wide text-faint transition-colors hover:bg-surface2 hover:text-muted"
            >
              向上滚动或点此加载更早的消息
            </button>
          )}
          <Transcript rows={visibleRows} draft={draft} />
        </div>
      </div>
      {!atBottom && (
        <button
          type="button"
          onClick={jumpToBottom}
          className="absolute right-4 bottom-16 rounded-full bg-ink px-3 py-1.5 font-mono text-[11px] text-bg"
        >
          ↓ 回到底部
        </button>
      )}
      {results && (
        <pre
          id="results"
          className="absolute top-10 right-4 z-10 max-h-[70vh] overflow-auto rounded-[14px] bg-surface2/95 p-3 font-mono text-[11px] whitespace-pre-wrap"
        >
          {results.join('\n')}
        </pre>
      )}
    </div>
  )
}

createRoot(document.getElementById('root')!).render(<Fixture />)
