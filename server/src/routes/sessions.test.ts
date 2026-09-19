import { describe, expect, test } from 'bun:test'
import { claudePort } from '../backends/claude/port'
import { codexPort } from '../backends/codex/port'
import { registerBackend } from '../backends/port'
import {
  defaultSessionRouteDeps,
  handleSessionRoutes,
  type SessionRouteDeps,
} from './sessions'

// POST /api/sessions 与 archived 列表经 backendPort 注册表取用（13.3 起）：
// 注册真实适配器，镜像 index.ts 装配（各测试文件同一单例，幂等）。
registerBackend('claude', claudePort)
registerBackend('codex', codexPort)

function request(method: string, body?: unknown): Request {
  return new Request('http://localhost/api/sessions', {
    method,
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

function deps(overrides: Partial<SessionRouteDeps>): SessionRouteDeps {
  return { ...defaultSessionRouteDeps, ...overrides }
}

describe('GET /api/sessions', () => {
  test('返回数组形状并合并 Codex 与 Claude，Codex 排在前面', async () => {
    const response = await handleSessionRoutes(
      request('GET'),
      new URL('http://localhost/api/sessions'),
      deps({
        listCodexSessions: async () => [
          {
            backend: 'codex',
            key: 'x|thread-1',
            id: 'thread-1',
            cwd: '/repo/codex',
            title: 'Codex thread',
            lastPrompt: 'fix it',
            mtime: 200,
            status: 'idle',
          },
        ],
        listSessions: () => [
          {
            sessionId: 'session-1',
            cwd: '/repo/claude',
            slug: '-repo-claude',
            title: 'Claude session',
            mtime: 100,
            sizeBytes: 42,
            status: 'busy',
            live: { pid: 123 },
          },
        ],
        readGitInfo: (cwd) =>
          cwd.endsWith('codex')
            ? { branch: 'codex-branch' }
            : { branch: 'claude-branch', worktreeOf: '/repo/main' },
        statusOf: (key) => ({ spawned: false, busy: false, sessionId: key }),
      }),
    )

    expect(response?.status).toBe(200)
    const rows = (await response!.json()) as Record<string, unknown>[]
    expect(Array.isArray(rows)).toBe(true)
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({
      sessionId: 'thread-1',
      backend: 'codex',
      key: 'x|thread-1',
      slug: 'codex',
      gitBranch: 'codex-branch',
      managed: { sessionId: 'x|thread-1' },
    })
    // codex 行无 worktreeOf 字段（mock 未给），claude 行透传 worktreeOf
    expect('worktreeOf' in rows[0]!).toBe(false)
    expect(rows[1]).toMatchObject({
      sessionId: 'session-1',
      backend: 'claude',
      key: 's|-repo-claude|session-1',
      gitBranch: 'claude-branch',
      worktreeOf: '/repo/main',
      managed: { sessionId: 's|-repo-claude|session-1' },
    })
  })

  test('Codex 列表失败时仅返回 Claude 会话', async () => {
    const response = await handleSessionRoutes(
      request('GET'),
      new URL('http://localhost/api/sessions'),
      deps({
        listCodexSessions: async () => {
          throw new Error('codex unavailable')
        },
        listSessions: () => [
          {
            sessionId: 'session-fallback',
            slug: 'repo',
            mtime: 1,
            sizeBytes: 2,
            status: 'offline',
          },
        ],
        readGitInfo: () => undefined,
        statusOf: () => ({ spawned: false, busy: false, sessionState: 'idle' }),
      }),
    )

    expect(await response!.json()).toEqual([
      {
        sessionId: 'session-fallback',
        slug: 'repo',
        mtime: 1,
        sizeBytes: 2,
        status: 'offline',
        backend: 'claude',
        key: 's|repo|session-fallback',
        managed: { spawned: false, busy: false, sessionState: 'idle' },
      },
    ])
  })
})

describe('POST /api/sessions', () => {
  test('缺少 cwd 返回 400', async () => {
    const response = await handleSessionRoutes(
      request('POST', { backend: 'codex' }),
      new URL('http://localhost/api/sessions'),
    )

    expect(response?.status).toBe(400)
    expect(await response!.json()).toEqual({ error: '缺少 cwd' })
  })

  test('Codex 后端返回 xn key', async () => {
    const response = await handleSessionRoutes(
      request('POST', { cwd: '/repo/demo', backend: 'codex' }),
      new URL('http://localhost/api/sessions'),
    )

    expect(await response!.json()).toEqual({
      key: 'xn|%2Frepo%2Fdemo',
      slug: 'codex',
      backend: 'codex',
    })
  })

  test('未指定后端时保持 Claude 默认语义', async () => {
    const response = await handleSessionRoutes(
      request('POST', { cwd: '/repo/demo' }),
      new URL('http://localhost/api/sessions'),
    )

    expect(await response!.json()).toEqual({
      key: 'n|%2Frepo%2Fdemo',
      slug: '-repo-demo',
      backend: 'claude',
    })
  })
})
