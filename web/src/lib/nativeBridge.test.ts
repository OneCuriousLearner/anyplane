import { describe, expect, test } from 'bun:test'
import { notifId, parseNativeAction } from './nativeBridge'

describe('notifId', () => {
  test('稳定且落在 int32 正区间', () => {
    expect(notifId('req-abc')).toBe(notifId('req-abc'))
    expect(notifId('req-abc')).toBeGreaterThanOrEqual(0)
    expect(notifId('req-abc')).toBeLessThan(2 ** 31)
    expect(notifId('req-abc')).not.toBe(notifId('req-abd'))
  })

  test('加盐 requestCode 与 Java 同算法：不溢出且 approve≠deny', () => {
    // 与 ApprovalService.requestCode 同一口径：notifId(id + '\\0' + purpose)
    // 替代旧的 notifId*2（id>=0x40000000 时整型溢出撞车）
    const requestCode = (id: string, purpose: string) => notifId(`${id}\0${purpose}`)
    for (const id of ['req-abc', 'x'.repeat(200), '高位碰撞探测']) {
      const approve = requestCode(id, 'approve')
      const deny = requestCode(id, 'deny')
      expect(approve).toBeGreaterThanOrEqual(0)
      expect(approve).toBeLessThan(2 ** 31)
      expect(deny).toBeGreaterThanOrEqual(0)
      expect(deny).toBeLessThan(2 ** 31)
      expect(approve).not.toBe(deny)
      expect(approve).not.toBe(notifId(id) * 2)
    }
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
