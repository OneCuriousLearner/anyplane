/** DEV 徽章六个贴边槽：左/右 × 上/中/下。默认 ⑥ 右下。 */

export type SnapSlot = 1 | 2 | 3 | 4 | 5 | 6
export type Pt = { x: number; y: number }
export type Insets = { top: number; right: number; bottom: number; left: number }

export const DEFAULT_SLOT: SnapSlot = 6
export const SNAP_MARGIN = 12
export const DRAG_THRESHOLD = 6
export const SLOT_KEY = 'anyplane-dev-badge-slot'

const SLOTS: readonly SnapSlot[] = [1, 2, 3, 4, 5, 6]

export function parseSlot(raw: string | null | undefined): SnapSlot {
  const n = Number(raw)
  return n === 1 || n === 2 || n === 3 || n === 4 || n === 5 || n === 6 ? n : DEFAULT_SLOT
}

export function loadSlot(): SnapSlot {
  try {
    return parseSlot(localStorage.getItem(SLOT_KEY))
  } catch {
    return DEFAULT_SLOT
  }
}

export function saveSlot(slot: SnapSlot): void {
  try {
    localStorage.setItem(SLOT_KEY, String(slot))
  } catch {
    /* 隐私模式等写失败时忽略 */
  }
}

/** 视口内六个磁吸锚点（徽章左上角坐标）。 */
export function snapAnchors(
  vw: number,
  vh: number,
  bw: number,
  bh: number,
  insets: Insets = { top: 0, right: 0, bottom: 0, left: 0 },
): Record<SnapSlot, Pt> {
  const left = Math.max(SNAP_MARGIN, insets.left)
  const right = vw - Math.max(SNAP_MARGIN, insets.right) - bw
  const top = Math.max(SNAP_MARGIN, insets.top)
  const bottom = vh - Math.max(SNAP_MARGIN, insets.bottom) - bh
  const midY = (vh - bh) / 2
  return {
    1: { x: left, y: top },
    2: { x: right, y: top },
    3: { x: left, y: midY },
    4: { x: right, y: midY },
    5: { x: left, y: bottom },
    6: { x: right, y: bottom },
  }
}

export function nearestSlot(p: Pt, anchors: Record<SnapSlot, Pt>): SnapSlot {
  let best: SnapSlot = DEFAULT_SLOT
  let bestD = Infinity
  for (const slot of SLOTS) {
    const a = anchors[slot]
    const d = (p.x - a.x) ** 2 + (p.y - a.y) ** 2
    if (d < bestD) {
      bestD = d
      best = slot
    }
  }
  return best
}

export function clampPos(p: Pt, vw: number, vh: number, bw: number, bh: number): Pt {
  return {
    x: Math.min(Math.max(0, p.x), Math.max(0, vw - bw)),
    y: Math.min(Math.max(0, p.y), Math.max(0, vh - bh)),
  }
}

export function parsePx(value: string): number {
  const n = parseFloat(value)
  return Number.isFinite(n) ? n : 0
}
