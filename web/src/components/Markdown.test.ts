import { describe, expect, test } from 'bun:test'
import { shouldInterceptLink } from './Markdown'

describe('shouldInterceptLink（Markdown 空链接/锚点拦截）', () => {
  test('空 href 与缺省 href 拦截（<a href=""> 点击 = 刷新当前页）', () => {
    expect(shouldInterceptLink('')).toBe(true)
    expect(shouldInterceptLink(null)).toBe(true)
  })

  test('# 锚点拦截（改 hash 会与 #s=<key> 路由打架，弹回列表）', () => {
    expect(shouldInterceptLink('#')).toBe(true)
    expect(shouldInterceptLink('#anchor')).toBe(true)
  })

  test('真实外链放行', () => {
    expect(shouldInterceptLink('https://example.com/x')).toBe(false)
    expect(shouldInterceptLink('file:///C:/tmp/a.txt')).toBe(false)
    expect(shouldInterceptLink('D:\\Coder\\x.ts')).toBe(false)
  })
})
