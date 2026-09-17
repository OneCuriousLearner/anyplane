import { describe, expect, test } from 'bun:test'
import { notifId, parseNativeAction } from './nativeBridge'

describe('notifId', () => {
  test('稳定且落在 int32 正区间', () => {
    expect(notifId('req-abc')).toBe(notifId('req-abc'))
    expect(notifId('req-abc')).toBeGreaterThanOrEqual(0)
    expect(notifId('req-abc')).toBeLessThan(2 ** 31)
    expect(notifId('req-abc')).not.toBe(notifId('req-abd'))
  })
})

describe('parseNativeAction', () => {
  test('合法 JSON 三字段齐备才放行', () => {
    expect(parseNativeAction('{"key":"s|a|b","requestId":"r1","actionId":"approve"}')).toEqual({
      key: 's|a|b',
      requestId: 'r1',
      actionId: 'approve',
    })
  })

  test('null/坏 JSON/缺字段一律 null', () => {
    expect(parseNativeAction(null)).toBeNull()
    expect(parseNativeAction('not-json')).toBeNull()
    expect(parseNativeAction('{"key":"s|a|b"}')).toBeNull()
    expect(parseNativeAction('{"key":1,"requestId":"r1","actionId":"tap"}')).toBeNull()
  })
})
