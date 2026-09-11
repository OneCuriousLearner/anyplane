import { describe, expect, test } from 'bun:test'
import { shouldInterceptLink } from './Markdown'

describe('shouldInterceptLink（Markdown 空链接/锚点/相对路径拦截）', () => {
  test('空 href 与缺省 href 拦截（<a href=""> 点击 = 刷新当前页）', () => {
    expect(shouldInterceptLink('')).toBe(true)
    expect(shouldInterceptLink('   ')).toBe(true)
    expect(shouldInterceptLink(null)).toBe(true)
  })

  test('# 锚点拦截（改 hash 会与 #s=<key> 路由打架，弹回列表）', () => {
    expect(shouldInterceptLink('#')).toBe(true)
    expect(shouldInterceptLink('#anchor')).toBe(true)
    expect(shouldInterceptLink('#s=s%7Cslug%7Csid')).toBe(true)
  })

  test('javascript:/data: 拦截', () => {
    expect(shouldInterceptLink('javascript:alert(1)')).toBe(true)
    expect(shouldInterceptLink('JavaScript:void(0)')).toBe(true)
    expect(shouldInterceptLink('data:text/html,x')).toBe(true)
  })

  test('相对路径 / Windows 路径 / 同站绝对路径拦截（会卸掉 SPA）', () => {
    expect(shouldInterceptLink('foo.ts')).toBe(true)
    expect(shouldInterceptLink('./README.md')).toBe(true)
    expect(shouldInterceptLink('/abs/path')).toBe(true)
    expect(shouldInterceptLink('D:\\Coder\\x.ts')).toBe(true)
  })

  test('真实外链放行', () => {
    expect(shouldInterceptLink('https://example.com/x')).toBe(false)
    expect(shouldInterceptLink('http://example.com/x')).toBe(false)
    expect(shouldInterceptLink('mailto:a@b.c')).toBe(false)
    expect(shouldInterceptLink('file:///C:/tmp/a.txt')).toBe(false)
  })
})
