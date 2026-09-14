import { describe, expect, test } from 'bun:test'
import { parseArgs, renderCaddyfile, resolvePort, resolveToken } from './public-access-lib'

describe('parseArgs', () => {
  test('三个配方的最小形态', () => {
    expect(parseArgs(['funnel'])).toEqual({ recipe: 'funnel', domain: undefined, port: undefined, httpsPort: 8443 })
    expect(parseArgs(['cf-quick']).recipe).toBe('cf-quick')
    expect(parseArgs(['caddy', 'ap.example.com'])).toEqual({
      recipe: 'caddy',
      domain: 'ap.example.com',
      port: undefined,
      httpsPort: 8443,
    })
  })

  test('caddy 缺域名直接拒绝', () => {
    expect(() => parseArgs(['caddy'])).toThrow(/需要域名/)
  })

  test('未知配方与未知参数拒绝', () => {
    expect(() => parseArgs(['ngrok'])).toThrow(/未知配方/)
    expect(() => parseArgs(['funnel', '--wat'])).toThrow(/未知参数/)
  })

  test('--port / --https-port 解析与校验', () => {
    expect(parseArgs(['cf-quick', '--port', '7481']).port).toBe(7481)
    expect(parseArgs(['caddy', 'a.b', '--https-port', '443']).httpsPort).toBe(443)
    expect(() => parseArgs(['funnel', '--port', '0'])).toThrow(/--port 非法/)
    expect(() => parseArgs(['caddy', 'a.b', '--https-port', 'x'])).toThrow(/--https-port 非法/)
  })
})

describe('resolveToken', () => {
  test('ANYPLANE_TOKEN 优先于配置文件', () => {
    expect(resolveToken({ ANYPLANE_TOKEN: 'env-tok' }, { authToken: 'file-tok' })).toBe('env-tok')
  })

  test('仅配置文件 → 配置文件；都没有 → undefined（脚本 fail-closed 的判定源）', () => {
    expect(resolveToken({}, { authToken: 'file-tok' })).toBe('file-tok')
    expect(resolveToken({}, {})).toBeUndefined()
    expect(resolveToken({ ANYPLANE_TOKEN: '' }, {})).toBeUndefined()
  })
})

describe('resolvePort', () => {
  test('--port > ANYPLANE_PORT > 配置文件 > 7480', () => {
    expect(resolvePort(9000, { ANYPLANE_PORT: '8000' }, { port: 7000 })).toBe(9000)
    expect(resolvePort(undefined, { ANYPLANE_PORT: '8000' }, { port: 7000 })).toBe(8000)
    expect(resolvePort(undefined, {}, { port: 7000 })).toBe(7000)
    expect(resolvePort(undefined, {}, {})).toBe(7480)
    expect(resolvePort(undefined, { ANYPLANE_PORT: 'abc' }, {})).toBe(7480)
  })
})

describe('renderCaddyfile', () => {
  test('域名:端口 站点块反代到回环目标', () => {
    const out = renderCaddyfile('ap.example.com', 7480, 8443)
    expect(out).toContain('ap.example.com:8443 {')
    expect(out).toContain('reverse_proxy 127.0.0.1:7480')
  })
})
