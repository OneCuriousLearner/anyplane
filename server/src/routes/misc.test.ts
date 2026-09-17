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

describe('GET /api/backends/status', () => {
  test('透传探测结果；探测抛错返回 500', async () => {
    const ok = await handleMiscRoutes(
      new Request('http://localhost/api/backends/status'),
      new URL('http://localhost/api/backends/status'),
      deps({
        getBackendsStatus: async () => ({
          checkedAt: 1,
          claude: { state: 'subscription' },
          codex: { state: 'not-logged-in' },
        }),
      }),
    )
    expect(ok?.status).toBe(200)
    expect(await ok!.json()).toEqual({
      checkedAt: 1,
      claude: { state: 'subscription' },
      codex: { state: 'not-logged-in' },
    })

    const boom = await handleMiscRoutes(
      new Request('http://localhost/api/backends/status'),
      new URL('http://localhost/api/backends/status'),
      deps({
        getBackendsStatus: async () => {
          throw new Error('probe exploded')
        },
      }),
    )
    expect(boom?.status).toBe(500)
    expect(await boom!.json()).toEqual({ error: 'probe exploded' })
  })
})

describe('POST /api/approvals/resolve（原生壳一键审批）', () => {
  const KEY = 's|repo|native-bridge-test'

  function resolveReq(body: unknown): Request {
    return new Request('http://localhost/api/approvals/resolve', {
      method: 'POST',
      body: JSON.stringify(body),
    })
  }

  test('缺 key/requestId 返回 400', async () => {
    const r = await handleMiscRoutes(resolveReq({ decision: 'allow' }), new URL('http://localhost/api/approvals/resolve'), deps({}))
    expect(r?.status).toBe(400)
  })

  test('decision 非法返回 400', async () => {
    const r = await handleMiscRoutes(
      resolveReq({ key: KEY, requestId: 'r1', decision: 'maybe' }),
      new URL('http://localhost/api/approvals/resolve'),
      deps({}),
    )
    expect(r?.status).toBe(400)
    expect(await r!.json()).toEqual({ error: '只接受 allow/deny' })
  })

  test('未知会话或已处理返回 409', async () => {
    const r = await handleMiscRoutes(
      resolveReq({ key: KEY, requestId: 'r-gone', decision: 'allow' }),
      new URL('http://localhost/api/approvals/resolve'),
      deps({}),
    )
    expect(r?.status).toBe(409)
  })

  test('allow 成功裁决并清空 pending', async () => {
    const { hubs } = await import('../hub/registry')
    hubs.set(KEY, {
      key: KEY,
      clients: new Set(),
      pendingApprovals: new Map([['r1', { requestId: 'r1', toolName: 'Bash', input: { command: 'ls' } }]]),
    })
    try {
      const r = await handleMiscRoutes(
        resolveReq({ key: KEY, requestId: 'r1', decision: 'allow' }),
        new URL('http://localhost/api/approvals/resolve'),
        deps({}),
      )
      expect(r?.status).toBe(200)
      expect(await r!.json()).toEqual({ ok: true })
      expect(hubs.get(KEY)?.pendingApprovals.size).toBe(0)
      // 重复点击：同一 requestId 第二次裁决返回 409
      const again = await handleMiscRoutes(
        resolveReq({ key: KEY, requestId: 'r1', decision: 'allow' }),
        new URL('http://localhost/api/approvals/resolve'),
        deps({}),
      )
      expect(again?.status).toBe(409)
    } finally {
      hubs.delete(KEY)
    }
  })
})
