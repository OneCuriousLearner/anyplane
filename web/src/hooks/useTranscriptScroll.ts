// 抄本滚动与尾部窗口化 hook：Chat.tsx 与 300+ 行 fixture 页共用同一份实现。
//
// 设计硬约束（两次回退的根因，详见 docs/ROADMAP.md「抄本窗口化 / 虚拟列表」）：
// 1. 初始定位是硬前提：首个非空抄本在 layout 阶段以 auto 行为直达底部（useLayoutEffect，
//    绘制前完成），完成前扩窗门控恒关——首绘 scrollTop=0 不会误触发扩窗把视图钉在顶部。
// 2. 扩窗只认「向上滚动」：本仓库不存在任何程序化向上滚动（跟随/回底/锚定补偿全部向下），
//    方向向上 ⟺ 用户主动上翻（滚轮/touch/拖滚动条全覆盖）。新增程序化向上滚动是违约，
//    必须套 ignoreScrollUntil 守卫。
// 3. 窗口粒度是渲染行（TranscriptRow），不是消息数——活动分组把多条消息并成一行。
//
// 窗口策略：扩窗只向上生长、不向下收缩；atBottom 期间窗口随行数自动保持尾部
// （rawStart=null 的漂移语义，跟随滚动每帧钉底，顶部卸载不可见）；离开底部即冻结起点，
// 回到底部（滚动或 ↓ 按钮）恢复尾部窗口，DOM 重回收敛。

import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import {
  EXPAND_TOP_PX,
  clampWindowStart,
  expandWindowStart,
  initialWindowStart,
} from '../lib/transcriptWindow'

/** 距底多少像素内视为「在底部」（跟随意愿判定；沿用原 Chat 口径） */
const AT_BOTTOM_PX = 80
/** 程序化滚动后忽略扩窗的时长（覆盖异步 scroll 事件派发窗口） */
const IGNORE_SCROLL_MS = 200

export function useTranscriptScroll(opts: {
  /** 滚动容器（h-full overflow-y-auto 那个 div） */
  scrollRef: React.RefObject<HTMLDivElement | null>
  /** 摊平后的渲染行数（含 draft 行） */
  rowCount: number
  /** 会话 key：变化时重置定位/窗口/atBottom（Chat 组件跨会话复用） */
  resetKey: string
  /** 跟随滚动的触发依赖（[messages, approvals, draft]）；数组内容逐位比较 */
  followDeps: readonly unknown[]
  /** 流式进行中（有 draft）：跟随用 auto；收尾/新消息才 smooth */
  streaming: boolean
}): {
  /** 已 clamp 的窗口起点；调用方 rows.slice(windowStart) 后渲染 */
  windowStart: number
  atBottom: boolean
  /** 挂到滚动容器的 onScroll */
  onScroll: () => void
  /** ↓ 按钮：恢复尾部窗口并直达底部 */
  jumpToBottom: () => void
  /** 顶部哨兵按钮的显式扩窗（与上翻扩窗同一条锚定补偿路径） */
  expandWindow: () => void
} {
  const { scrollRef, rowCount, resetKey, followDeps, streaming } = opts
  const [atBottom, setAtBottom] = useState(true)
  const atBottomRef = useRef(true)
  /** 用户显式扩窗/冻结后的窗口起点；null = 未交互，跟随初始策略（尾部窗口，随行数漂移） */
  const [rawStart, setRawStart] = useState<number | null>(null)
  /** 初始定位已完成（首个非空抄本已在 layout 阶段 auto 直达底部） */
  const initialAnchorDoneRef = useRef(false)
  /** 扩窗前的滚动量快照：渲染后按 scrollHeight 增量补偿，视口内容保持不动 */
  const pendingAnchorRef = useRef<{ height: number; top: number } | null>(null)
  /** 上一次 scrollTop：方向判定（仅向上才允许扩窗） */
  const lastScrollTopRef = useRef(0)
  /** 程序化滚动（锚定补偿/回底重置的钳位滚动）的扩窗豁免截止时间 */
  const ignoreScrollUntilRef = useRef(0)
  const followRaf = useRef(0)

  const windowStart =
    rawStart == null ? initialWindowStart(rowCount) : clampWindowStart(rawStart, rowCount)

  // 只滚消息列表容器。禁止 scrollIntoView：它会连带滚动 overflow 祖先，
  // 把 absolute 顶/底栏一起顶出视口（表现为先对齐再跳到 top=-8px）。
  const scrollToBottom = (smooth = false) => {
    const el = scrollRef.current
    if (!el) return
    if (smooth) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
    else el.scrollTop = el.scrollHeight
  }

  // ---- 初始定位：首个非空抄本在 layout 阶段 auto 直达底部（绘制前完成，无 smooth 漂移） ----
  useLayoutEffect(() => {
    if (initialAnchorDoneRef.current || rowCount === 0) return
    const el = scrollRef.current
    if (!el) return
    el.scrollTop = el.scrollHeight
    lastScrollTopRef.current = el.scrollTop
    initialAnchorDoneRef.current = true
    atBottomRef.current = true
    setAtBottom(true)
  }, [rowCount, scrollRef])

  // ---- 扩窗锚定补偿：prepend 增加 scrollHeight，按增量把视口钉回原有内容 ----
  // 无 deps：每次渲染检查一次，有待补偿锚点才动手（cheap）
  useLayoutEffect(() => {
    const pending = pendingAnchorRef.current
    if (!pending) return
    pendingAnchorRef.current = null
    const el = scrollRef.current
    if (!el) return
    ignoreScrollUntilRef.current = performance.now() + IGNORE_SCROLL_MS
    el.scrollTop = pending.top + (el.scrollHeight - pending.height)
    lastScrollTopRef.current = el.scrollTop
  })

  // ---- 跟随滚动：rAF 合帧（流式输出时 draft 每个 token 都变引用，逐次 smooth scrollTo
  // 会在移动端积出可感 jank；合到下一帧只滚一次，流式期间用 auto——smooth 缓动跟不上 token 速率） ----
  const scheduleFollow = (smooth: boolean) => {
    if (followRaf.current) return
    followRaf.current = requestAnimationFrame(() => {
      followRaf.current = 0
      if (atBottomRef.current) scrollToBottom(smooth)
    })
  }
  useEffect(() => () => cancelAnimationFrame(followRaf.current), [])

  // 贴底时才自动跟随滚动；用户上翻时保持位置（用 ↓ 按钮回到底部）。
  // followDeps 由调用方按现状语义给出（[messages, approvals, draft]），逐位比较。
  useEffect(() => {
    if (!atBottomRef.current) return
    scheduleFollow(!streaming)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, followDeps)

  // ---- 会话切换：重置定位/窗口/atBottom（被动效应即可：历史是异步落地，锚点在 rows>0 时才设）。
  // 跳过首次挂载：挂载时初始值即重置值，且首渲染可能已有行（fixture/缓存），
  // 挂载即重置会清掉同帧 layout 锚点刚设好的 initialAnchorDone（实测扩窗门控因此永久关闭） ----
  const prevKeyRef = useRef(resetKey)
  useEffect(() => {
    if (prevKeyRef.current === resetKey) return
    prevKeyRef.current = resetKey
    initialAnchorDoneRef.current = false
    pendingAnchorRef.current = null
    lastScrollTopRef.current = 0
    atBottomRef.current = true
    setAtBottom(true)
    setRawStart(null)
  }, [resetKey])

  // ---- 滚动事件：atBottom 维护 + 窗口冻结/恢复 + 门控扩窗 ----
  const onScroll = () => {
    const el = scrollRef.current
    if (!el) return
    const top = el.scrollTop
    const at = el.scrollHeight - top - el.clientHeight < AT_BOTTOM_PX
    atBottomRef.current = at
    setAtBottom(at)
    const last = lastScrollTopRef.current
    lastScrollTopRef.current = top

    if (at) {
      // 回到底部（手动滚动到位）：恢复尾部窗口漂移语义，DOM 重回收敛
      if (rawStart != null) setRawStart(null)
      return
    }
    // 离开底部：冻结窗口起点——否则 atBottom 漂移语义会让尾部窗口随行数增长
    // 静默卸载用户正在阅读的行
    if (rawStart == null) setRawStart(windowStart)

    // 扩窗门控：初始定位完成 + 非程序化滚动回链 + 方向向上 + 近顶端 + 还有更早的行
    if (!initialAnchorDoneRef.current) return
    if (performance.now() < ignoreScrollUntilRef.current) return
    if (top >= last) return // 仅向上滚动可扩窗
    if (windowStart <= 0 || top >= EXPAND_TOP_PX) return
    pendingAnchorRef.current = { height: el.scrollHeight, top }
    setRawStart(expandWindowStart(windowStart))
  }

  // ---- ↓ 按钮：恢复尾部窗口 + 直达底部 ----
  const jumpToBottom = () => {
    ignoreScrollUntilRef.current = performance.now() + IGNORE_SCROLL_MS
    setRawStart(null)
    atBottomRef.current = true
    setAtBottom(true)
    // 先按当前（可能全量）高度滚到底；窗口重置后顶部卸载，scrollTop 钳位落底
    scrollToBottom(false)
  }

  // ---- 顶部哨兵按钮：显式扩窗（程序化，但与上翻扩窗共用锚定补偿，视口不动） ----
  const expandWindow = () => {
    const el = scrollRef.current
    if (!el || windowStart <= 0) return
    pendingAnchorRef.current = { height: el.scrollHeight, top: el.scrollTop }
    setRawStart(expandWindowStart(windowStart))
  }

  return { windowStart, atBottom, onScroll, jumpToBottom, expandWindow }
}
