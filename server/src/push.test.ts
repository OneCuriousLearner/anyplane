// endpointAllowed 是订阅注册的 SSRF/窃听防线：inbox 事件（含审批摘要与能力 URL）
// 会扇出给全部订阅，任意 endpoint 可注册 = 窃听全部会话通知 + 向内网盲 POST。
import { afterEach, describe, expect, test } from 'bun:test'
import { config } from './config'
import { endpointAllowed, pushWebhooksToAll, validSecret, webhookCount, type PushPayload } from './push'

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

// ---------- webhook 通道（ntfy/Bark/Server酱） ----------
// stub 全局 fetch 捕获出站请求，验证三种渠道的 payload 形状与能力 URL 补全。

const originalWebhooks = config.pushWebhooks
const originalPublicUrl = config.publicUrl
const originalFetch = globalThis.fetch

interface CapturedReq {
  url: string
  method: string
  headers: Record<string, string>
  body: string
}

/** 把全局 fetch 换成捕获器：记录 (url, method, headers, body) 并回 200 */
function captureFetch(captured: CapturedReq[]): void {
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : (input as Request).url
    const headers: Record<string, string> = {}
    new Headers(init?.headers).forEach((v, k) => (headers[k] = v))
    captured.push({ url, method: init?.method ?? 'GET', headers, body: typeof init?.body === 'string' ? init.body : '' })
    return new Response('ok', { status: 200 })
  }) as unknown as typeof fetch
}

/** 从捕获的 URL 里取 s= 能力密钥 */
function secretOf(url: string): string {
  return new URL(url).searchParams.get('s') ?? ''
}

const APPROVAL: PushPayload = {
  type: 'approval',
  title: '需要审批 · Bash',
  body: 'proj｜echo hi',
  key: 's|slug|sid-1',
  session: 'proj',
  requestId: 'req-1',
  actions: {
    allow: '/api/approval-action?k=x&r=req-1&d=allow&s=',
    deny: '/api/approval-action?k=x&r=req-1&d=deny&s=',
  },
}

const DONE: PushPayload = {
  type: 'done',
  title: '✓ 完成 · proj',
  body: '会话已空闲，点击查看结果',
  key: 's|slug|sid-1',
  session: 'proj',
}

describe('webhook 通道', () => {
  afterEach(() => {
    config.pushWebhooks = originalWebhooks
    config.publicUrl = originalPublicUrl
    globalThis.fetch = originalFetch
  })

  test('ntfy：JSON publish + http action 真一键审批（绝对 URL + 有效 secret）', async () => {
    const captured: CapturedReq[] = []
    captureFetch(captured)
    config.publicUrl = 'https://cc.example.com'
    config.pushWebhooks = [{ type: 'ntfy', server: 'https://ntfy.internal', topic: 't-abc', token: 'tk_1' }]

    const r = await pushWebhooksToAll(APPROVAL)
    expect(r.sent).toBe(1)
    expect(webhookCount()).toBe(1)

    expect(captured).toHaveLength(1)
    const req = captured[0]
    expect(req.method).toBe('POST')
    expect(req.url).toBe('https://ntfy.internal/')
    expect(req.headers['authorization']).toBe('Bearer tk_1')
    expect(req.headers['content-type']).toBe('application/json')

    const body = JSON.parse(req.body) as {
      topic: string
      title: string
      message: string
      priority: number
      click: string
      actions: { action: string; label: string; url: string; method: string; clear: boolean }[]
    }
    expect(body.topic).toBe('t-abc')
    expect(body.title).toBe('需要审批 · Bash')
    expect(body.message).toBe('proj｜echo hi')
    expect(body.priority).toBe(4)
    expect(body.click).toBe('https://cc.example.com/#s=s%7Cslug%7Csid-1')
    expect(body.actions).toHaveLength(2)
    expect(body.actions[0].label).toBe('允许')
    expect(body.actions[0].method).toBe('POST')
    expect(body.actions[0].clear).toBe(true)
    // 能力 URL：绝对地址 + secret 补全，且通过能力校验
    expect(body.actions[0].url.startsWith('https://cc.example.com/api/approval-action?')).toBe(true)
    expect(body.actions[0].url).toContain('d=allow')
    expect(validSecret(secretOf(body.actions[0].url))).toBe(true)
    expect(body.actions[1].url).toContain('d=deny')
    // 两个按钮共用同一渠道 secret
    expect(secretOf(body.actions[1].url)).toBe(secretOf(body.actions[0].url))
  })

  test('bark：无原生按钮，url 落确认页（GET approval-page，非直出审批）', async () => {
    const captured: CapturedReq[] = []
    captureFetch(captured)
    config.publicUrl = 'https://cc.example.com'
    config.pushWebhooks = [{ type: 'bark', url: 'https://bark.internal/key-1' }]

    await pushWebhooksToAll(APPROVAL)
    const body = JSON.parse(captured[0].body) as { title: string; group: string; level: string; url: string }
    expect(captured[0].url).toBe('https://bark.internal/key-1')
    expect(body.group).toBe('cc-remote')
    expect(body.level).toBe('timeSensitive')
    expect(body.url).toContain('/api/approval-page?')
    expect(body.url).not.toContain('d=allow') // 确认页不预置决定
    expect(body.url).toContain('r=req-1')
    expect(validSecret(secretOf(body.url))).toBe(true)
  })

  test('sct：form POST 到 sctapi，markdown 携带确认页链接；标题截断 32 字符', async () => {
    const captured: CapturedReq[] = []
    captureFetch(captured)
    config.publicUrl = 'https://cc.example.com'
    config.pushWebhooks = [{ type: 'sct', sendkey: 'SCT123' }]

    await pushWebhooksToAll({ ...APPROVAL, title: '需要审批 · ' + 'x'.repeat(40) })
    expect(captured[0].url).toBe('https://sctapi.ftqq.com/SCT123.send')
    expect(captured[0].headers['content-type']).toBe('application/x-www-form-urlencoded')
    const form = new URLSearchParams(captured[0].body)
    expect(form.get('title')!.length).toBeLessThanOrEqual(32)
    const desp = form.get('desp')!
    expect(desp).toContain('前往审批')
    const link = desp.match(/\((https:\/\/[^)]+)\)/)![1]
    expect(link).toContain('/api/approval-page?')
    expect(validSecret(secretOf(link))).toBe(true)
  })

  test('未配置 publicUrl：降级纯文本（无按钮/深链/确认页），正文仍送达', async () => {
    const captured: CapturedReq[] = []
    captureFetch(captured)
    config.publicUrl = undefined
    config.pushWebhooks = [
      { type: 'ntfy', server: 'https://ntfy.internal', topic: 't-abc' },
      { type: 'bark', url: 'https://bark.internal/key-1' },
      { type: 'sct', sendkey: 'SCT123' },
    ]

    const r = await pushWebhooksToAll(APPROVAL)
    expect(r.sent).toBe(3)
    const ntfy = JSON.parse(captured[0].body) as Record<string, unknown>
    expect(ntfy.actions).toBeUndefined()
    expect(ntfy.click).toBeUndefined()
    expect(ntfy.message).toBe('proj｜echo hi')
    const bark = JSON.parse(captured[1].body) as Record<string, unknown>
    expect(bark.url).toBeUndefined()
    const desp = new URLSearchParams(captured[2].body).get('desp')!
    expect(desp).not.toContain('http')
  })

  test('done 事件：ntfy 优先级 3、Bark level active、sct 落会话深链', async () => {
    const captured: CapturedReq[] = []
    captureFetch(captured)
    config.publicUrl = 'https://cc.example.com'
    config.pushWebhooks = [
      { type: 'ntfy', server: 'https://ntfy.internal', topic: 't-abc' },
      { type: 'bark', url: 'https://bark.internal/key-1' },
      { type: 'sct', sendkey: 'SCT123' },
    ]

    await pushWebhooksToAll(DONE)
    const ntfy = JSON.parse(captured[0].body) as { priority: number; click: string }
    expect(ntfy.priority).toBe(3)
    expect(ntfy.click).toContain('/#s=')
    const bark = JSON.parse(captured[1].body) as { level: string; url: string }
    expect(bark.level).toBe('active')
    expect(bark.url).toContain('/#s=')
    const desp = new URLSearchParams(captured[2].body).get('desp')!
    expect(desp).toContain('查看会话')
  })

  test('webhook 派生 secret 通过能力校验；随机串拒绝；渠道标识变动自然作废', async () => {
    config.pushWebhooks = [{ type: 'ntfy', server: 'https://ntfy.internal', topic: 't-abc' }]
    const captured: CapturedReq[] = []
    captureFetch(captured)
    config.publicUrl = 'https://cc.example.com'
    await pushWebhooksToAll(APPROVAL)
    const body = JSON.parse(captured[0].body) as { actions: { url: string }[] }
    const secret = secretOf(body.actions[0].url)
    expect(secret.length).toBeGreaterThan(20)
    expect(validSecret(secret)).toBe(true)
    expect(validSecret('random-garbage')).toBe(false)
    expect(validSecret('')).toBe(false)
    // 改 topic = 新渠道标识 → 旧 secret 作废
    config.pushWebhooks = [{ type: 'ntfy', server: 'https://ntfy.internal', topic: 't-other' }]
    expect(validSecret(secret)).toBe(false)
  })

  test('单通道失败不影响其他通道（allSettled）', async () => {
    let calls = 0
    globalThis.fetch = (async () => {
      calls++
      if (calls === 1) throw new Error('network down')
      return new Response('ok', { status: 200 })
    }) as unknown as typeof fetch
    config.publicUrl = undefined
    config.pushWebhooks = [
      { type: 'ntfy', server: 'https://ntfy.internal', topic: 't-abc' },
      { type: 'bark', url: 'https://bark.internal/key-1' },
    ]
    const r = await pushWebhooksToAll(DONE)
    expect(calls).toBe(2)
    expect(r.sent).toBe(1)
  })
})
