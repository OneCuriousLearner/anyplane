import { describe, expect, test } from 'bun:test'
import {
  classifyClaudeAuth,
  classifyCodexAccount,
  getBackendsStatus,
  resetBackendsStatusCache,
} from './status'

describe('classifyClaudeAuth', () => {
  test('loggedIn 非 true → 未登录', () => {
    expect(classifyClaudeAuth({ loggedIn: false }).state).toBe('not-logged-in')
    expect(classifyClaudeAuth({}).state).toBe('not-logged-in')
  })

  test('claude.ai → 订阅', () => {
    expect(classifyClaudeAuth({ loggedIn: true, authMethod: 'claude.ai' })).toEqual({ state: 'subscription' })
  })

  test('api_key / api_key_helper → API key', () => {
    expect(classifyClaudeAuth({ loggedIn: true, authMethod: 'api_key' }).state).toBe('api-key')
    expect(classifyClaudeAuth({ loggedIn: true, authMethod: 'api_key_helper' }).state).toBe('api-key')
  })

  test('oauth_token → token（env/setup-token 不再细分）', () => {
    expect(classifyClaudeAuth({ loggedIn: true, authMethod: 'oauth_token' })).toEqual({ state: 'token' })
  })

  test('third_party → 三方并保留 provider', () => {
    expect(classifyClaudeAuth({ loggedIn: true, authMethod: 'third_party', apiProvider: 'bedrock' })).toEqual({
      state: 'third-party',
      detail: 'bedrock',
    })
  })

  test('未知新来源 → token 兜底并留原文（协议漂移不致死）', () => {
    expect(classifyClaudeAuth({ loggedIn: true, authMethod: 'quantum' })).toEqual({
      state: 'token',
      detail: 'quantum',
    })
  })
})

describe('classifyCodexAccount', () => {
  test('account=null + requiresOpenaiAuth=true → 未登录', () => {
    expect(classifyCodexAccount({ account: null, requiresOpenaiAuth: true }).state).toBe('not-logged-in')
  })

  test('account=null + requiresOpenaiAuth=false → 自定义 provider（API-key 组织用户）', () => {
    expect(classifyCodexAccount({ account: null, requiresOpenaiAuth: false }).state).toBe('custom-provider')
  })

  test('chatgpt → 订阅，email 与 planType 进 detail', () => {
    expect(
      classifyCodexAccount({ account: { type: 'chatgpt', email: 'a@b.c', planType: 'plus' }, requiresOpenaiAuth: true }),
    ).toEqual({ state: 'subscription', detail: 'a@b.c · plus' })
  })

  test('chatgpt email 为 null 时 detail 只留 planType', () => {
    expect(
      classifyCodexAccount({ account: { type: 'chatgpt', email: null, planType: 'pro' }, requiresOpenaiAuth: true }),
    ).toEqual({ state: 'subscription', detail: 'pro' })
  })

  test('apiKey / amazonBedrock', () => {
    expect(classifyCodexAccount({ account: { type: 'apiKey' }, requiresOpenaiAuth: true }).state).toBe('api-key')
    expect(
      classifyCodexAccount({ account: { type: 'amazonBedrock', usesCodexManagedCredentials: true }, requiresOpenaiAuth: true }),
    ).toEqual({ state: 'third-party', detail: 'Amazon Bedrock' })
  })
})

describe('getBackendsStatus 缓存与并发', () => {
  test('30s 内复用缓存，探针只跑一次', async () => {
    resetBackendsStatusCache()
    let calls = 0
    const deps = {
      probeClaude: async () => {
        calls++
        return { state: 'subscription' } as const
      },
      probeCodex: async () => ({ state: 'api-key' }) as const,
    }
    const a = await getBackendsStatus(deps)
    const b = await getBackendsStatus(deps)
    expect(a).toBe(b)
    expect(calls).toBe(1)
  })

  test('并发调用共享同一在途 Promise（single-flight）', async () => {
    resetBackendsStatusCache()
    let calls = 0
    const deps = {
      probeClaude: async () => {
        calls++
        await new Promise((r) => setTimeout(r, 20))
        return { state: 'subscription' } as const
      },
      probeCodex: async () => ({ state: 'api-key' }) as const,
    }
    const [a, b] = await Promise.all([getBackendsStatus(deps), getBackendsStatus(deps)])
    expect(a).toBe(b)
    expect(calls).toBe(1)
  })

  test('unknown 结果不入缓存，下次调用重新探测', async () => {
    resetBackendsStatusCache()
    let calls = 0
    const deps = {
      probeClaude: async () => {
        calls++
        return { state: 'unknown', error: 'boom' } as const
      },
      probeCodex: async () => ({ state: 'api-key' }) as const,
    }
    await getBackendsStatus(deps)
    await getBackendsStatus(deps)
    expect(calls).toBe(2)
  })
})
