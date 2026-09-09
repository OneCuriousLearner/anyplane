import { expect, test } from 'bun:test'
import {
  WINDOW_MIN_ROWS,
  WINDOW_TAIL_ROWS,
  WINDOW_CHUNK,
  clampWindowStart,
  expandWindowStart,
  initialWindowStart,
  maxWindowStart,
} from './transcriptWindow'

test('阈值以下不切片', () => {
  expect(maxWindowStart(0)).toBe(0)
  expect(maxWindowStart(WINDOW_MIN_ROWS)).toBe(0)
  expect(initialWindowStart(50)).toBe(0)
})

test('超过阈值只留尾部窗口', () => {
  const n = WINDOW_MIN_ROWS + 1
  expect(maxWindowStart(n)).toBe(n - WINDOW_TAIL_ROWS)
  expect(initialWindowStart(320)).toBe(320 - WINDOW_TAIL_ROWS)
})

test('clamp：越界收敛，行数跌回阈值归 0', () => {
  expect(clampWindowStart(999, 320)).toBe(320 - WINDOW_TAIL_ROWS)
  expect(clampWindowStart(-5, 320)).toBe(0)
  // 截断到短会话：无论 raw 多大都恢复全量
  expect(clampWindowStart(500, 30)).toBe(0)
  // 截断后 raw 超新上界：收敛到新上界而非清空
  expect(clampWindowStart(500, 130)).toBe(130 - WINDOW_TAIL_ROWS)
})

test('扩窗：按步长前移，到顶幂等', () => {
  expect(expandWindowStart(240)).toBe(240 - WINDOW_CHUNK)
  expect(expandWindowStart(10)).toBe(0)
  expect(expandWindowStart(0)).toBe(0)
})
