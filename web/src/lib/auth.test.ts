// 访问令牌生命周期（lib/auth.ts）：URL ?token= 首次注入 → localStorage 持久化 → 地址栏抹除。
// 认证边界组件：token 滞留在地址栏会随截图/分享/历史记录泄漏，抹除逻辑是安全语义的一部分。
// 浏览器 API 走 globalThis 替换（ws.test.ts 同款模式），不触达真实 location/localStorage/history。

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { authHeaders, getToken, notifyAuthRequired, onAuthRequired, setToken, wsTokenQuery } from './auth'

let stored: Record<string, string>
let replacedUrls: string[]

const real = {
  location: (globalThis as Record<string, unknown>).location,
  localStorage: (globalThis as Record<string, unknown>).localStorage,
  history: (globalThis as Record<string, unknown>).history,
}

function stubBrowser(search: string, href: string): void {
  const g = globalThis as Record<string, unknown>
  g.location = { search, href }
  g.localStorage = {
    getItem: (k: string) => stored[k] ?? null,
    setItem: (k: string, v: string) => {
      stored[k] = v
    },
    removeItem: (k: string) => {
      delete stored[k]
    },
    clear: () => {
      stored = {}
    },
  }
  g.history = {
    replaceState: (_state: unknown, _unused: unknown, url: string) => {
      replacedUrls.push(url)
    },
  }
}

beforeEach(() => {
  stored = {}
  replacedUrls = []
})

afterEach(() => {
  const g = globalThis as Record<string, unknown>
  g.location = real.location
  g.localStorage = real.localStorage
  g.history = real.history
  // listener 是模块级单例：复位防止跨文件泄漏（bun test 共享进程）
  onAuthRequired(() => {})
})

describe('getToken：URL 注入 → 持久化 → 抹除', () => {
  test('?token= 注入：返回令牌、写 localStorage、从地址栏抹除且保留其他参数与 hash', () => {
    stubBrowser('?mode=dev&token=abc123', 'http://cc.test/?mode=dev&token=abc123#s=x%7Cy')

    expect(getToken()).toBe('abc123')
    expect(stored['anyplane-token']).toBe('abc123')
    expect(replacedUrls).toEqual(['/?mode=dev#s=x%7Cy'])
  })

  test('URL token 覆盖已存储的旧令牌（换新场景）', () => {
    stubBrowser('?token=new-token', 'http://cc.test/?token=new-token')
    stored['anyplane-token'] = 'old-token'

    expect(getToken()).toBe('new-token')
    expect(stored['anyplane-token']).toBe('new-token')
  })

  test('URL 无 token：读 localStorage 存量，不触碰地址栏', () => {
    stubBrowser('?mode=dev', 'http://cc.test/?mode=dev')
    stored['anyplane-token'] = 'stored-token'

    expect(getToken()).toBe('stored-token')
    expect(replacedUrls).toEqual([])
  })

  test('两处皆无：null（未配置 authToken 的开放部署）', () => {
    stubBrowser('', 'http://cc.test/')
    expect(getToken()).toBeNull()
  })
})

describe('认证头与 WS query', () => {
  test('authHeaders：有令牌给 Bearer，无令牌给空对象（不发明头）', () => {
    stubBrowser('', 'http://cc.test/')
    expect(authHeaders()).toEqual({})
    setToken('tk-1')
    expect(authHeaders()).toEqual({ authorization: 'Bearer tk-1' })
  })

  test('wsTokenQuery：无令牌为空串；特殊字符 percent-encode（浏览器 WS 握手只能走 query）', () => {
    stubBrowser('', 'http://cc.test/')
    expect(wsTokenQuery()).toBe('')
    const token = 'a b&c=d?e'
    setToken(token)
    const q = wsTokenQuery()
    expect(q).toBe(`?token=${encodeURIComponent(token)}`)
    // 服务端经 query 解析能无损取回原令牌
    expect(new URLSearchParams(q.slice(1)).get('token')).toBe(token)
  })
})

describe('401 通知', () => {
  test('notifyAuthRequired 触发已注册 listener；重复注册后者替换前者', () => {
    let first = 0
    let second = 0
    onAuthRequired(() => {
      first++
    })
    notifyAuthRequired()
    onAuthRequired(() => {
      second++
    })
    notifyAuthRequired()
    expect(first).toBe(1) // 只被第一次 notify 调用
    expect(second).toBe(1)
  })

  test('未注册 listener 时 notify 不抛', () => {
    expect(() => notifyAuthRequired()).not.toThrow()
  })
})
