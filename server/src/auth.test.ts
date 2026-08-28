import { afterEach, describe, expect, test } from 'bun:test'
import {
  hostAllowed,
  hostNameOf,
  isAuthorized,
  isLoopbackHost,
  isLoopbackHostname,
  jsonContentTypeRequired,
  originAllowed,
} from './auth'
import { config } from './config'

const originalToken = config.authToken

afterEach(() => {
  config.authToken = originalToken
})

function req(path: string, init?: { method?: string; headers?: Record<string, string> }): { req: Request; url: URL } {
  const url = new URL(path, 'http://127.0.0.1:7480')
  return { req: new Request(url, init), url }
}

describe('isAuthorized', () => {
  test('未配置 token 时全部放行', () => {
    config.authToken = undefined
    const { req: r, url } = req('http://127.0.0.1:7480/api/sessions')
    expect(isAuthorized(r, url)).toBe(true)
  })

  test('Bearer 头与 ?token= 两种凭据都接受', () => {
    config.authToken = 's3cret'
    const bearer = req('http://127.0.0.1:7480/api/sessions', {
      headers: { authorization: 'Bearer s3cret' },
    })
    expect(isAuthorized(bearer.req, bearer.url)).toBe(true)
    const query = req('http://127.0.0.1:7480/ws/s|a|b?token=s3cret')
    expect(isAuthorized(query.req, query.url)).toBe(true)
  })

  test('错误/缺失凭据拒绝', () => {
    config.authToken = 's3cret'
    const wrong = req('http://127.0.0.1:7480/api/sessions', {
      headers: { authorization: 'Bearer nope' },
    })
    expect(isAuthorized(wrong.req, wrong.url)).toBe(false)
    const missing = req('http://127.0.0.1:7480/api/sessions')
    expect(isAuthorized(missing.req, missing.url)).toBe(false)
    // Basic 等其他 scheme 不能混过
    const basic = req('http://127.0.0.1:7480/api/sessions', {
      headers: { authorization: 'Basic s3cret' },
    })
    expect(isAuthorized(basic.req, basic.url)).toBe(false)
  })
})

describe('isLoopbackHost / isLoopbackHostname', () => {
  test('回环判定', () => {
    expect(isLoopbackHost('127.0.0.1')).toBe(true)
    expect(isLoopbackHost('localhost')).toBe(true)
    expect(isLoopbackHost('::1')).toBe(true)
    expect(isLoopbackHost('0.0.0.0')).toBe(false)
    expect(isLoopbackHost('192.168.1.10')).toBe(false)
  })
  test('hostname 级判定含 127.0.0.0/8 全网段', () => {
    expect(isLoopbackHostname('127.1.2.3')).toBe(true)
    expect(isLoopbackHostname('10.0.0.1')).toBe(false)
    expect(isLoopbackHostname('localhost.evil.com')).toBe(false)
  })
})

describe('hostNameOf', () => {
  test('去端口，含 IPv6 方括号形态', () => {
    expect(hostNameOf('localhost:7480')).toBe('localhost')
    expect(hostNameOf('127.0.0.1:7480')).toBe('127.0.0.1')
    expect(hostNameOf('[::1]:7480')).toBe('::1')
    expect(hostNameOf('example.com')).toBe('example.com')
  })
})

describe('originAllowed（无 token 模式的 CSWSH 防线）', () => {
  const withHeaders = (headers: Record<string, string>) => new Request('http://127.0.0.1:7480/ws/x', { headers })

  test('无 Origin 头放行（非浏览器客户端：e2e 脚本/curl）', () => {
    expect(originAllowed(withHeaders({ host: '127.0.0.1:7480' }))).toBe(true)
  })

  test('Origin: null 拒绝（file:// 沙箱页/iframe 的浏览器特征）', () => {
    expect(originAllowed(withHeaders({ host: '127.0.0.1:7480', origin: 'null' }))).toBe(false)
  })

  test('Origin 与 Host 完全相同放行', () => {
    expect(originAllowed(withHeaders({ host: 'example.com:7480', origin: 'http://example.com:7480' }))).toBe(true)
  })

  test('双回环跨端口放行（dev 模式 Vite:5173 → server:7480）', () => {
    expect(originAllowed(withHeaders({ host: '127.0.0.1:7480', origin: 'http://localhost:5173' }))).toBe(true)
    expect(originAllowed(withHeaders({ host: '[::1]:7480', origin: 'http://127.0.0.1:5173' }))).toBe(true)
    // WHATWG URL 的 IPv6 hostname 保留方括号（[::1]），不能因此漏判回环
    expect(originAllowed(withHeaders({ host: 'localhost:7480', origin: 'http://[::1]:5173' }))).toBe(true)
  })

  test('恶意跨源拒绝', () => {
    expect(originAllowed(withHeaders({ host: '127.0.0.1:7480', origin: 'https://evil.com' }))).toBe(false)
    // 回环字样子域名不是回环
    expect(originAllowed(withHeaders({ host: 'localhost:7480', origin: 'http://localhost.evil.com' }))).toBe(false)
  })

  test('非法 Origin URL 拒绝', () => {
    expect(originAllowed(withHeaders({ host: '127.0.0.1:7480', origin: 'not a url' }))).toBe(false)
  })
})

describe('hostAllowed（无 token 模式的 DNS rebinding 防线）', () => {
  const withHost = (host?: string) =>
    new Request('http://127.0.0.1:7480/api/sessions', host ? { headers: { host } } : undefined)

  test('回环 Host 放行（直连/Vite 代理/SSH 转发）', () => {
    expect(hostAllowed(withHost('127.0.0.1:7480'))).toBe(true)
    expect(hostAllowed(withHost('localhost:5173'))).toBe(true)
    expect(hostAllowed(withHost('[::1]:7480'))).toBe(true)
    expect(hostAllowed(withHost('127.1.2.3:7480'))).toBe(true)
  })

  test('缺 Host 头放行（HTTP/1.0/非浏览器客户端；浏览器必定携带）', () => {
    expect(hostAllowed(withHost())).toBe(true)
  })

  test('rebinding 场景拒绝：攻击者域名 rebind 到 127.0.0.1 后，浏览器 Host 是攻击者域名', () => {
    // Origin 与 Host 同名同宿主（originAllowed 的"相同放行"分支救不了这个场景），
    // Host 是浏览器禁改头，攻击者无法谎称回环
    expect(hostAllowed(withHost('attacker.com:7480'))).toBe(false)
    expect(hostAllowed(withHost('cc-remote.devcloud.woa.com'))).toBe(false)
    expect(hostAllowed(withHost('localhost.evil.com:7480'))).toBe(false)
    // 内网 IP 也不是回环
    expect(hostAllowed(withHost('192.168.1.10:7480'))).toBe(false)
  })
})

describe('jsonContentTypeRequired（text/plain 简单请求 CSRF 通道封堵）', () => {
  test('GET/HEAD 不受约束', () => {
    const { req: r, url } = req('http://127.0.0.1:7480/api/sessions', { method: 'GET' })
    expect(jsonContentTypeRequired(r, url)).toBe(true)
  })

  test('非 /api 路径不受约束', () => {
    const { req: r, url } = req('http://127.0.0.1:7480/assets/index.js', {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
    })
    expect(jsonContentTypeRequired(r, url)).toBe(true)
  })

  test('POST /api 必须 application/json（charset 后缀可接受）', () => {
    const ok = req('http://127.0.0.1:7480/api/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=utf-8' },
    })
    expect(jsonContentTypeRequired(ok.req, ok.url)).toBe(true)

    const plain = req('http://127.0.0.1:7480/api/sessions', {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
    })
    expect(jsonContentTypeRequired(plain.req, plain.url)).toBe(false)

    // 表单提交同样是 preflight 豁免通道
    const form = req('http://127.0.0.1:7480/api/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    })
    expect(jsonContentTypeRequired(form.req, form.url)).toBe(false)
  })
})
