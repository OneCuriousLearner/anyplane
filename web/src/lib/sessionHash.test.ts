import { describe, expect, test } from 'bun:test'
import { parseDeepLinkHash, sessionHashUrl, shouldWriteHash } from './sessionHash'

describe('parseDeepLinkHash', () => {
  test('标准 #s=<encodeURIComponent(key)> 解出原 key', () => {
    const key = 's|-srv|01a03cac-3fdc-7b80-9c5d-f14ba518f4dc'
    expect(parseDeepLinkHash(`#s=${encodeURIComponent(key)}`)).toBe(key)
  })

  test('无 hash / 空 #s= / 非会话 hash → null', () => {
    expect(parseDeepLinkHash('')).toBeNull()
    expect(parseDeepLinkHash('#')).toBeNull()
    expect(parseDeepLinkHash('#s=')).toBeNull()
    expect(parseDeepLinkHash('#other')).toBeNull()
  })

  test('损坏百分号编码 → null（不抛 URIError）', () => {
    expect(parseDeepLinkHash('#s=%')).toBeNull()
    expect(parseDeepLinkHash('#s=%E0%A4%A')).toBeNull()
    expect(parseDeepLinkHash('#s=b|%E4%B8')).toBeNull()
  })
})

describe('sessionHashUrl', () => {
  test('有 key 只写 hash 段（与 sw.js 深链同编码）', () => {
    expect(sessionHashUrl('s|slug|sid')).toBe('#s=s%7Cslug%7Csid')
  })

  test('无 key 回到 pathname+search', () => {
    expect(sessionHashUrl(undefined, '/', '')).toBe('/')
    expect(sessionHashUrl(undefined, '/app', '?x=1')).toBe('/app?x=1')
  })
})

describe('shouldWriteHash', () => {
  test('同 key 不写（避免重复 push 吞后退）', () => {
    expect(shouldWriteHash('s|a|1', 's|a|1')).toBe(false)
    expect(shouldWriteHash(null, undefined)).toBe(false)
  })

  test('切会话或回列表要写', () => {
    expect(shouldWriteHash('s|a|1', 's|b|2')).toBe(true)
    expect(shouldWriteHash('s|a|1', undefined)).toBe(true)
    expect(shouldWriteHash(null, 's|a|1')).toBe(true)
  })
})
