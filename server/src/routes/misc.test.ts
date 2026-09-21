import { describe, expect, test } from 'bun:test'
import { claudePort } from '../backends/claude/port'
import { codexPort } from '../backends/codex/port'
import { registerBackend } from '../backends/port'
import { defaultMiscRouteDeps, handleMiscRoutes, type MiscRouteDeps } from './misc'

// approvals/resolve 的裁决链路经 portFor 注册表取用（13.3 起）：
// 注册真实适配器，镜像 index.ts 装配——不依赖其他测试文件先执行的共享注册。
registerBackend('claude', claudePort)
registerBackend('codex', codexPort)

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
  test('async readHistory 被 await，不会把 Promise 序列化成 {}', async () => {
    const page = {
      messages: [{ role: 'user' as const, blocks: [{ kind: 'text' as const, text: 'hi' }] }],
      fileBytes: 12,
      hasMore: false,
    }
    const response = await handleMiscRoutes(
      new Request('http://localhost/api/history/repo/session-1'),
      new URL('http://localhost/api/history/repo/session-1'),
      deps({
        readHistory: async () => page,
      }),
    )
    expect(response?.status).toBe(200)
    expect(await response!.json()).toEqual(page)
  })

  test('默认依赖走 port：缺文件返回空页，不是 {}', async () => {
    const response = await handleMiscRoutes(
      new Request('http://localhost/api/history/no-such-slug/no-such-sid'),
      new URL('http://localhost/api/history/no-such-slug/no-such-sid'),
    )
    expect(response?.status).toBe(200)
    const body = (await response!.json()) as Record<string, unknown>
    expect(body).not.toEqual({})
    expect(body).toMatchObject({ messages: [], fileBytes: 0 })
  })

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

  // slug/sessionId/threadId 会拼进文件路径——形状闸与 splitExistingKey 同口径（[a-zA-Z0-9-]），
  // 异常形状不匹配路由（聚合层落 404），readHistory 不被调用
  test('形状闸：含 . / _ 等路径字符的标识不落路由', async () => {
    let called = false
    const d = deps({
      readHistory: () => {
        called = true
        return { messages: [], fileBytes: 0, hasMore: false }
      },
    })
    for (const p of ['/api/history/re..po/x', '/api/history/repo/x.y', '/api/history/repo/x_y']) {
      const res = await handleMiscRoutes(new Request(`http://localhost${p}`), new URL(`http://localhost${p}`), d)
      expect(res).toBeUndefined()
    }
    const codexRes = await handleMiscRoutes(
      new Request('http://localhost/api/codex/history/ab..cd'),
      new URL('http://localhost/api/codex/history/ab..cd'),
    )
    expect(codexRes).toBeUndefined()
    expect(called).toBe(false)
    // 合法形状照常落路由（闸不误伤）
    const ok = await handleMiscRoutes(
      new Request('http://localhost/api/history/repo/session-1'),
      new URL('http://localhost/api/history/repo/session-1'),
      d,
    )
    expect(ok?.status).toBe(200)
    expect(called).toBe(true)
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

describe('POST /api/client-log（设备侧遥测）', () => {
  test('正常上报返回 ok；空 tag 不落日志', async () => {
    const logs: string[] = []
    const { log } = await import('../log')
    const orig = log.info
    log.info = (m: unknown) => {
      logs.push(String(m))
    }
    try {
      const ok = await handleMiscRoutes(
        new Request('http://localhost/api/client-log', {
          method: 'POST',
          body: JSON.stringify({ tag: 'native', msg: 'configure ok' }),
        }),
        new URL('http://localhost/api/client-log'),
        deps({}),
      )
      expect(ok?.status).toBe(200)
      expect(logs).toEqual(['[client:native] configure ok'])

      const empty = await handleMiscRoutes(
        new Request('http://localhost/api/client-log', { method: 'POST', body: JSON.stringify({ msg: 'x' }) }),
        new URL('http://localhost/api/client-log'),
        deps({}),
      )
      expect(empty?.status).toBe(200)
      expect(logs.length).toBe(1)
    } finally {
      log.info = orig
    }
  })
})
