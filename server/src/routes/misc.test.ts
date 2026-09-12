import { describe, expect, test } from 'bun:test'
import { defaultMiscRouteDeps, handleMiscRoutes, type MiscRouteDeps } from './misc'

function deps(overrides: Partial<MiscRouteDeps>): MiscRouteDeps {
  return { ...defaultMiscRouteDeps, ...overrides }
}

function post(body: unknown): Request {
  return new Request('http://localhost/api/handoff', {
    method: 'POST',
    body: JSON.stringify(body),
  })
}

describe('POST /api/handoff 参数校验', () => {
  test('缺少 fromKey 时返回 400 且不执行 handoff', async () => {
    let calls = 0
    const response = await handleMiscRoutes(
      post({ toBackend: 'codex' }),
      new URL('http://localhost/api/handoff'),
      deps({
        runHandoff: () => {
          calls++
          return undefined
        },
      }),
    )

    expect(response?.status).toBe(400)
    expect(await response!.json()).toEqual({ error: '缺少 fromKey' })
    expect(calls).toBe(0)
  })

  test('非法目标后端时返回 400 且不执行 handoff', async () => {
    let calls = 0
    const response = await handleMiscRoutes(
      post({ fromKey: 's|repo|session-1', toBackend: 'other' }),
      new URL('http://localhost/api/handoff'),
      deps({
        runHandoff: () => {
          calls++
          return undefined
        },
      }),
    )

    expect(response?.status).toBe(400)
    expect(await response!.json()).toEqual({ error: 'toBackend 必须是 claude 或 codex' })
    expect(calls).toBe(0)
  })
})

describe('GET /api/history/:slug/:sessionId 查询参数', () => {
  test('before=0 被保留，limit 被限制到 10000', async () => {
    let captured:
      | { slug: string; sessionId: string; opts?: { limit?: number; before?: number } }
      | undefined
    const response = await handleMiscRoutes(
      new Request('http://localhost/api/history/repo/session-1?before=0&limit=20000'),
      new URL('http://localhost/api/history/repo/session-1?before=0&limit=20000'),
      deps({
        readHistory: (slug, sessionId, opts) => {
          captured = { slug, sessionId, opts }
          return { messages: [], fileBytes: 0, hasMore: false }
        },
      }),
    )

    expect(response?.status).toBe(200)
    expect(captured).toEqual({
      slug: 'repo',
      sessionId: 'session-1',
      opts: { before: 0, limit: 10_000 },
    })
    expect(await response!.json()).toEqual({ messages: [], fileBytes: 0, hasMore: false })
  })
})
