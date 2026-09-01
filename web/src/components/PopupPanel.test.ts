import { describe, expect, test } from 'bun:test'
import { popupPosition } from './PopupPanel'

const vp = { width: 1400, height: 800 }
/** 用户点选的环形：54×32，右下在输入行 */
const ring = { top: 541, left: 1216, right: 1270, bottom: 573 }

describe('popupPosition', () => {
  test('cover-end 面板右下角与锚点右下角重合', () => {
    const pos = popupPosition(ring, 'cover-end', 6, vp)
    expect(pos).toEqual({ bottom: vp.height - ring.bottom, right: vp.width - ring.right })
    expect(vp.width - pos.right!).toBe(ring.right)
    expect(vp.height - pos.bottom!).toBe(ring.bottom)
  })

  test('cover-start 面板左下角与锚点左下角重合（StatusPill 同款）', () => {
    const pill = { top: 540, left: 200, right: 420, bottom: 572 }
    const pos = popupPosition(pill, 'cover-start', 0, vp)
    expect(pos).toEqual({ bottom: vp.height - pill.bottom, left: pill.left })
  })

  test('top-end 仍在锚点上方留出 offset，不盖住锚点', () => {
    const pos = popupPosition(ring, 'top-end', 6, vp)
    expect(pos.top).toBe(ring.top - 6)
    expect(pos.left).toBe(ring.right)
    expect(pos.transform).toBe('translate(-100%, -100%)')
  })
})
