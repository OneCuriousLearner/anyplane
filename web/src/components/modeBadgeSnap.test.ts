import { describe, expect, test } from 'bun:test'
import {
  clampPos,
  DEFAULT_SLOT,
  nearestSlot,
  parsePx,
  parseSlot,
  SNAP_MARGIN,
  snapAnchors,
} from './modeBadgeSnap'

const insets = { top: 0, right: 0, bottom: 0, left: 0 }

describe('parseSlot', () => {
  test('defaults to ⑥', () => {
    expect(parseSlot(null)).toBe(DEFAULT_SLOT)
    expect(parseSlot('')).toBe(6)
    expect(parseSlot('0')).toBe(6)
    expect(parseSlot('7')).toBe(6)
    expect(parseSlot('foo')).toBe(6)
  })
  test('accepts 1–6', () => {
    for (const n of [1, 2, 3, 4, 5, 6] as const) {
      expect(parseSlot(String(n))).toBe(n)
    }
  })
})

describe('snapAnchors', () => {
  const a = snapAnchors(1000, 800, 55, 25, insets)

  test('① top-left and ⑥ bottom-right', () => {
    expect(a[1]).toEqual({ x: SNAP_MARGIN, y: SNAP_MARGIN })
    expect(a[6]).toEqual({ x: 1000 - SNAP_MARGIN - 55, y: 800 - SNAP_MARGIN - 25 })
  })
  test('②④ on the right edge, ③⑤ on the left', () => {
    expect(a[2].x).toBe(a[6].x)
    expect(a[4].x).toBe(a[6].x)
    expect(a[3].x).toBe(a[1].x)
    expect(a[5].x).toBe(a[1].x)
  })
  test('③④ vertically centered', () => {
    expect(a[3].y).toBe((800 - 25) / 2)
    expect(a[4].y).toBe(a[3].y)
  })
  test('safe-area insets enlarge the margin', () => {
    const b = snapAnchors(1000, 800, 55, 25, { top: 40, right: 20, bottom: 30, left: 16 })
    expect(b[1]).toEqual({ x: 16, y: 40 })
    expect(b[6]).toEqual({ x: 1000 - 20 - 55, y: 800 - 30 - 25 })
  })
})

describe('nearestSlot', () => {
  const a = snapAnchors(1000, 800, 55, 25, insets)

  test('corners pick themselves', () => {
    expect(nearestSlot(a[1], a)).toBe(1)
    expect(nearestSlot(a[2], a)).toBe(2)
    expect(nearestSlot(a[5], a)).toBe(5)
    expect(nearestSlot(a[6], a)).toBe(6)
  })
  test('center of viewport prefers a mid-edge slot', () => {
    const slot = nearestSlot({ x: (1000 - 55) / 2, y: (800 - 25) / 2 }, a)
    expect(slot === 3 || slot === 4).toBe(true)
  })
  test('near bottom-right parks at ⑥', () => {
    expect(nearestSlot({ x: 900, y: 700 }, a)).toBe(6)
  })
})

describe('clampPos / parsePx', () => {
  test('keeps the badge inside the viewport', () => {
    expect(clampPos({ x: -10, y: -4 }, 1000, 800, 55, 25)).toEqual({ x: 0, y: 0 })
    expect(clampPos({ x: 9999, y: 9999 }, 1000, 800, 55, 25)).toEqual({ x: 945, y: 775 })
  })
  test('parsePx', () => {
    expect(parsePx('12px')).toBe(12)
    expect(parsePx('0')).toBe(0)
    expect(parsePx('')).toBe(0)
  })
})
