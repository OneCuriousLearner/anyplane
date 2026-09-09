// 抄本尾部窗口化的纯函数窗口逻辑（useTranscriptScroll 的决策核，无 DOM 依赖）。
//
// 方案选型与两次回退的根因见 docs/ROADMAP.md「抄本窗口化 / 虚拟列表」。本实现的三条硬规则：
// 1. 初始定位必须先于窗口化完成（auto 行为、layout 阶段），否则首绘 scrollTop=0 会立刻触发扩窗
//    把视图钉在顶部——这条由 hook 侧的 initialAnchorDone 守卫落实，不在本文件。
// 2. 扩窗只由「向上滚动」触发（方向判定在 hook 侧；本仓库不存在任何程序化向上滚动——
//    跟随/回底/锚定补偿全是向下，新增向上滚动必须走 anchoring 守卫）。
// 3. 窗口粒度是「渲染行」不是消息数——活动分组把多条消息并成一行，两者差着量级。

/** 行数超过此值才启用窗口化；以下全量挂载（短会话零行为变化） */
export const WINDOW_MIN_ROWS = 120
/** 启用窗口化后初始保留的尾部行数（打开长会话只挂载这些） */
export const WINDOW_TAIL_ROWS = 80
/** 每次向上扩窗追加的行数 */
export const WINDOW_CHUNK = 60
/** 距视口顶端多少像素内（且方向向上）触发扩窗 */
export const EXPAND_TOP_PX = 480

/** 窗口下界：行数不超标时恒 0（不切片）；超标时为尾部保留 WINDOW_TAIL_ROWS 行 */
export function maxWindowStart(rowCount: number): number {
  return rowCount > WINDOW_MIN_ROWS ? Math.max(0, rowCount - WINDOW_TAIL_ROWS) : 0
}

/** 打开会话 / 跳到最新时的窗口起点（= 只渲染尾部窗口） */
export function initialWindowStart(rowCount: number): number {
  return maxWindowStart(rowCount)
}

/**
 * 渲染期收敛：raw 起点可能因截断（rewind/reverted）或行数缩水而越界，
 * 一律 clamp 到合法区间。rowCount 跌回阈值以下时归 0（恢复全量挂载）。
 */
export function clampWindowStart(raw: number, rowCount: number): number {
  return Math.min(Math.max(0, raw), maxWindowStart(rowCount))
}

/** 向上扩窗一步；到顶（0）后幂等 */
export function expandWindowStart(start: number): number {
  return Math.max(0, start - WINDOW_CHUNK)
}
