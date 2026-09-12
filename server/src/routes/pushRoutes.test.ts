import { describe, expect, test } from 'bun:test'
import { defaultPushRouteDeps, handlePushRoutes, type PushRouteDeps } from './pushRoutes'

function deps(overrides: Partial<PushRouteDeps>): PushRouteDeps {
  return { ...defaultPushRouteDeps, ...overrides }
}

function subscriptionRequest(body: unknown): Request {
  return new Request('http://localhost/api/push/subscriptions', {
    method: 'POST',
    body: JSON.stringify(body),
  })
}

describe('POST /api/push/subscriptions', () => {
  test('endpoint 与两个 key 任一缺失都拒绝，且不创建订阅', async () => {
    let addCalls = 0
    const isolatedDeps = deps({
      addSubscription: () => {
        addCalls++
        return { secret: 'must-not-be-created' }
      },
    })
    const invalidBodies = [
      { keys: { p256dh: 'p', auth: 'a' } },
      { endpoint: 'https://push.example', keys: { auth: 'a' } },
      { endpoint: 'https://push.example', keys: { p256dh: 'p' } },
    ]

    for (const body of invalidBodies) {
      const response = await handlePushRoutes(
        subscriptionRequest(body),
        new URL('http://localhost/api/push/subscriptions'),
        isolatedDeps,
      )
      expect(response?.status).toBe(400)
      expect(await response!.json()).toEqual({ error: 'endpoint 与 keys.p256dh/auth 必填' })
    }
    expect(addCalls).toBe(0)
  })
})

describe('审批能力边界', () => {
  test('approval-action 的无效 secret 返回 403', async () => {
    let checkedSecret = ''
    const url = new URL('http://localhost/api/approval-action?k=session&r=req&d=allow&s=bad')
    const response = await handlePushRoutes(
      new Request(url, { method: 'POST' }),
      url,
      deps({
        validSecret: (secret) => {
          checkedSecret = secret
          return false
        },
      }),
    )

    expect(checkedSecret).toBe('bad')
    expect(response?.status).toBe(403)
    expect(await response!.json()).toEqual({ ok: false, error: '无效的能力密钥' })
  })

  test('approval-page 的无效 secret 返回 403 且不渲染确认页', async () => {
    const url = new URL('http://localhost/api/approval-page?k=session&r=req&s=bad')
    const response = await handlePushRoutes(
      new Request(url),
      url,
      deps({ validSecret: () => false }),
    )

    expect(response?.status).toBe(403)
    expect(await response!.text()).toBe('无效的能力密钥')
  })

  test('secret 有效但 decision 非法时返回 400', async () => {
    const url = new URL('http://localhost/api/approval-action?k=session&r=req&d=maybe&s=valid')
    const response = await handlePushRoutes(
      new Request(url, { method: 'POST' }),
      url,
      deps({ validSecret: () => true }),
    )

    expect(response?.status).toBe(400)
    expect(await response!.json()).toEqual({ ok: false, error: 'd 只接受 allow/deny' })
  })
})
