// endpointAllowed 是订阅注册的 SSRF/窃听防线：inbox 事件（含审批摘要与能力 URL）
// 会扇出给全部订阅，任意 endpoint 可注册 = 窃听全部会话通知 + 向内网盲 POST。
import { afterEach, describe, expect, test } from 'bun:test'
import { config } from './config'
import { endpointAllowed } from './push'

const originalAllow = config.pushAllowHosts

afterEach(() => {
  config.pushAllowHosts = originalAllow
})

describe('endpointAllowed（默认白名单）', () => {
  test('主流推送服务及其子域放行', () => {
    expect(endpointAllowed('https://fcm.googleapis.com/wp/abc')).toBe(true)
    expect(endpointAllowed('https://updates.push.services.mozilla.com/wpush/v2/xyz')).toBe(true)
    expect(endpointAllowed('https://web.push.apple.com/QmFja2VudA')).toBe(true)
    expect(endpointAllowed('https://notify.windows.com/w/?token=1')).toBe(true)
    expect(endpointAllowed('https://jp.notify.windows.com/w/?token=1')).toBe(true)
  })

  test('未知 https 域拒绝', () => {
    expect(endpointAllowed('https://evil.com/push')).toBe(false)
    expect(endpointAllowed('https://attacker.example.org/')).toBe(false)
  })

  test('非 https 一律拒绝（file/javascript 等 scheme 同样堵死）', () => {
    expect(endpointAllowed('http://fcm.googleapis.com/wp/abc')).toBe(false)
    expect(endpointAllowed('file:///etc/passwd')).toBe(false)
    expect(endpointAllowed('javascript:alert(1)')).toBe(false)
  })

  test('白名单域名后缀不能伪造', () => {
    // evilfcm.googleapis.com 不是 .fcm.googleapis.com 后缀
    expect(endpointAllowed('https://evilfcm.googleapis.com/')).toBe(false)
    expect(endpointAllowed('https://fcm.googleapis.com.evil.com/')).toBe(false)
  })

  test('回环 mock 不限协议（e2e/自托管调试）', () => {
    expect(endpointAllowed('http://127.0.0.1:9001/push')).toBe(true)
    expect(endpointAllowed('http://localhost:9001/push')).toBe(true)
    expect(endpointAllowed('http://[::1]:9001/push')).toBe(true)
    expect(endpointAllowed('http://127.10.20.30:9001/push')).toBe(true)
  })

  test('无法解析的 URL 拒绝', () => {
    expect(endpointAllowed('not a url')).toBe(false)
    expect(endpointAllowed('')).toBe(false)
  })
})

describe('endpointAllowed（配置覆盖）', () => {
  test("pushAllowHosts=['*'] 放行任意 https，但仍拒绝明文 http（回环除外）", () => {
    config.pushAllowHosts = ['*']
    expect(endpointAllowed('https://self-hosted.example.com/push')).toBe(true)
    expect(endpointAllowed('http://self-hosted.example.com/push')).toBe(false)
    expect(endpointAllowed('http://127.0.0.1:9001/push')).toBe(true)
  })

  test('自托管域名追加后放行，其余默认域不再生效', () => {
    config.pushAllowHosts = ['push.internal.example.com']
    expect(endpointAllowed('https://push.internal.example.com/sub')).toBe(true)
    expect(endpointAllowed('https://eu.push.internal.example.com/sub')).toBe(true)
    // 配置覆盖语义：默认列表被整体替换
    expect(endpointAllowed('https://fcm.googleapis.com/wp/abc')).toBe(false)
  })
})
