// 抄本窗口化验收 fixture（方向七 + 历史分页）：合成分页数据源的混合抄本，
// 驱动与 Chat 完全同一份 useTranscriptScroll + buildTranscriptRows + Transcript。
//
// 仅 Vite dev 提供（/transcript-fixture.html）；生产构建默认只打 index.html，本页不进 dist。
// ?autorun=1 自动跑四段场景并把结果写到 window.__fixtureResult 与 #results <pre>，
// 供浏览器自动化（chrome-devtools MCP）读取；断言全过 document.title 变为 FIXTURE:PASS。
//
// 数据源：全部 76 轮（≈532 行）按页下发——首载只给最近 46 轮（322 行，模拟服务端 300 条窗口），
// 向上到顶且 hasMore 时异步 prepend 更早一页（20 轮/页，120ms 延迟模拟网络）。
//
// 场景（对齐 ROADMAP 方向七验收口径 + 历史分页回归）：
//   S1 打开会话：首绘 layout 阶段 auto 直达底部，只挂载尾部窗口，无 smooth 漂移
//   S2 流式追加：atBottom 期间持续追加，挂载行数恒定有界（DOM 不随会话长度增长）
//   S3 手动上翻：本地窗口逐段扩窗 + 到顶自动翻页直至最早一页，锚定补偿保证视口不跳变
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

const TURNS_TOTAL = 76 // ≈ 532 渲染行（全量）
const FIRST_PAGE_TURNS = 46 // 首载 46 轮 ≈ 322 行（模拟服务端首页窗口）
const PAGE_TURNS = 20 // 每次翻页 prepend 20 轮

function longText(t: number, k: number): string {
  return `第 ${t} 轮第 ${k} 段正文。\n\n这里是一段 markdown：\n\n- 要点 A（fixture 行 ${t}.${k}）\n- 要点 B\n\n\`\`\`ts\nconst turn = ${t}\nconsole.log(turn)\n\`\`\`\n\n结尾句。`
}

/** 生成 [from, TURNS_TOTAL) 轮的消息（确定性内容，按轮号对齐） */
function makeTurns(from: number): ChatMsg[] {
  const msgs: ChatMsg[] = []
  for (let t = from; t < TURNS_TOTAL; t++) {
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
  /** 分页数据源：最早已加载的轮号 / 是否还有更早页 / 翻页进行中 */
  startTurn: number
  hasMore: boolean
  fetchingEarlier: boolean
}

declare global {
  interface Window {
    __fixtureState?: FixtureState
    __fixtureResult?: { pass: boolean; lines: string[] }
  }
}

function Fixture() {
  const [startTurn, setStartTurn] = useState(TURNS_TOTAL - FIRST_PAGE_TURNS)
  const [appended, setAppended] = useState<ChatMsg[]>([])
  const [draftText, setDraftText] = useState<string | null>(null)
  const [results, setResults] = useState<string[] | null>(null)
  const [fetchingEarlier, setFetchingEarlier] = useState(false)
  const fetchingRef = useRef(false)
  const scrollRef = useRef<HTMLDivElement>(null)

  const hasMore = startTurn > 0
  const messages = useMemo(() => [...makeTurns(startTurn), ...appended], [startTurn, appended])
  const draft = useMemo(
    () => (draftText == null ? null : { blocks: [{ idx: 0, kind: 'text' as const, text: draftText }] }),
    [draftText],
  )
  const rows = useMemo(() => buildTranscriptRows(messages, draft), [messages, draft])

  /** 翻页（模拟 Chat 的 loadEarlier）：异步延迟后锚定 prepend 更早一轮页 */
  const loadEarlierRef = useRef<() => void>(() => {})
  loadEarlierRef.current = () => {
    if (fetchingRef.current || startTurn === 0) return
    fetchingRef.current = true
    setFetchingEarlier(true)
    void sleep(120).then(() => {
      scrollApiRef.current?.preparePrepend()
      setStartTurn((s) => Math.max(0, s - PAGE_TURNS))
      fetchingRef.current = false
      setFetchingEarlier(false)
    })
  }

  const transcriptScroll = useTranscriptScroll({
    scrollRef,
    rowCount: rows.length,
    resetKey: 'fixture',
    followDeps: [messages, draft],
    streaming: draft != null,
    onReachTop: () => loadEarlierRef.current(),
  })
  const { windowStart, atBottom, onScroll, jumpToBottom, expandWindow } = transcriptScroll
  const scrollApiRef = useRef<typeof transcriptScroll | null>(null)
  scrollApiRef.current = transcriptScroll
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
    startTurn,
    hasMore,
    fetchingEarlier,
  }

  /** 流式追加：40ms 一个 token，共 25 拍，然后定稿进 appended（tool+text 两块=两行，
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
      setAppended((prev) => [
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
      note(s.hasMore, 'S1 数据源还有更早页', `startTurn=${s.startTurn}`)
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

    // ---- S3 手动上翻：本地扩窗 + 到顶翻页，直到最早一页 ----
    {
      const el = scrollRef.current!
      let anchorOk = true
      let anchorDetail = ''
      for (let i = 0; i < 250; i++) {
        const s = st()
        if (s.windowStart === 0 && !s.hasMore && !s.fetchingEarlier && el.scrollTop <= 2) break
        // 锚点取证：给视口内元素打临时属性并记录其 y，扩窗/翻页后精确找回比对位移。
        // 向上滚动使元素在视口中下移（scrollTop -800 ⇒ viewport top +800，delta ≈ -800）；
        // 锚定补偿失效时 prepend 会额外叠加数千 px 位移
        const probe = document.elementFromPoint(el.clientWidth / 2, 200) as HTMLElement | null
        const beforeTop = probe?.getBoundingClientRect().top
        probe?.setAttribute('data-fx-anchor', '1')
        const scrollBefore = el.scrollTop
        el.scrollTop = Math.max(0, el.scrollTop - 800)
        const intended = scrollBefore - el.scrollTop // 钳位到 0 时实际滚动量 < 800
        await sleep(50)
        await frames(2)
        // 翻页是异步的（120ms）：等一拍让进行中的 prepend 落地再测
        if (st().fetchingEarlier) {
          await sleep(150)
          await frames(2)
        }
        const s2 = st()
        const grown = s2.windowStart < s.windowStart || s2.rowCount > s.rowCount
        const hit = el.querySelector('[data-fx-anchor="1"]') as HTMLElement | null
        hit?.removeAttribute('data-fx-anchor')
        if (grown && probe && hit && beforeTop != null && intended > 0) {
          // 位移应等于本步实际滚动量（锚定补偿把扩窗/翻页的 prepend 影响抵消为零）
          const delta = beforeTop - hit.getBoundingClientRect().top
          if (Math.abs(delta + intended) > 160) {
            anchorOk = false
            anchorDetail = `位移 ${delta.toFixed(0)}px 异常（本步滚动 ${intended.toFixed(0)}px，期望≈${(-intended).toFixed(0)}）`
            break
          }
        }
      }
      const s = st()
      note(s.startTurn === 0 && !s.hasMore, 'S3 翻页加载到最早一页', `startTurn=${s.startTurn} hasMore=${s.hasMore}`)
      note(
        s.windowStart === 0 && s.mountedRows === s.rowCount,
        'S3 扩窗到顶（全部挂载）',
        `start=${s.windowStart} mounted=${s.mountedRows}/${s.rowCount}`,
      )
      note(s.rowCount >= 530, 'S3 全量行数符合数据源', `rows=${s.rowCount}`)
      note(anchorOk, 'S3 扩窗/翻页锚定补偿无跳变', anchorDetail)
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
        抄本窗口 fixture · {rows.length} 行（挂载 {visibleRows.length}）· 窗口起点 {windowStart} · 最早第 {startTurn} 轮
        {hasMore ? '（还有更早页）' : ''}
        {results == null && autorun && ' · 运行中…'}
      </div>
      <div ref={scrollRef} onScroll={onScroll} className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl px-[17px] pb-[300px] pt-[84px] md:px-[29px]">
          {windowStart > 0 || hasMore ? (
            <button
              type="button"
              onClick={expandWindow}
              disabled={fetchingEarlier}
              className="mb-3 w-full rounded-[14px] bg-surface/60 py-2 font-mono text-[11px] tracking-wide text-faint transition-colors hover:bg-surface2 hover:text-muted disabled:opacity-60"
            >
              {fetchingEarlier ? '正在加载更早的消息…' : '向上滚动或点此加载更早的消息'}
            </button>
          ) : null}
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
