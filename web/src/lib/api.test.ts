// web/src/lib/api.ts 纯逻辑：共享口径的四块——
// - resolveModel：模型值 → 显示名/tooltip 的三级回退（tier 直查 → 按模型 ID 大小写不敏感反查 →
//   原样降级），StatusPill/DetailDrawer/Composer 共用同一口径（4d85e26 归并产物）
// - apiError：非 2xx 应答的错误提取（服务端 {error} 优先，空串/非 JSON 回退 HTTP 状态码）
// - makeSessionInfo：本地导航会话条目的缺省值
// - apiFetch/postJson：认证头合并与 401 → AuthRequiredError 语义
// 网络与存储走 FakeWebSocket 同款 globalThis 替换模式（见 ws.test.ts），不发真实请求。
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  apiError,
  apiFetch,
  AuthRequiredError,
  errorMessage,
  makeSessionInfo,
  postJson,
  resolveModel,
} from './api'
import { onAuthRequired } from './auth'

describe('resolveModel：模型显示名三级回退', () => {
  const names = {
    haiku: { name: 'Haiku 4.5', id: 'claude-haiku-4-5' },
    sonnet: { name: 'Sonnet 5', id: 'claude-sonnet-5' },
    fable: { name: 'Fable', id: 'k3[1m]' },
  }

  test('tier 直查命中：显示名 + id 进 tooltip（id 与 name 不同时）', () => {
    expect(resolveModel(names, 'sonnet')).toEqual({ label: 'Sonnet 5', title: 'claude-sonnet-5' })
  })

  test('直查命中但 id 缺席或 id 与 name 相同：无 tooltip（不显示冗余信息）', () => {
    expect(resolveModel({ x: { name: 'Only Name' } }, 'x')).toEqual({ label: 'Only Name', title: undefined })
    expect(resolveModel({ y: { name: 'm', id: 'm' } }, 'y')).toEqual({ label: 'm', title: undefined })
  })

  test('tier 未命中时按模型 ID 反查（大小写不敏感），原始值进 tooltip', () => {
    // init 报的是解析后 ID（如 k3[1m]），设置里的 ID 写法大小写可能不同
    expect(resolveModel(names, 'K3[1M]')).toEqual({ label: 'Fable', title: 'K3[1M]' })
    expect(resolveModel(names, 'claude-haiku-4-5')).toEqual({ label: 'Haiku 4.5', title: 'claude-haiku-4-5' })
  })

  test('反查只匹配配置了 id 的档：name 巧合命中不算', () => {
    expect(resolveModel({ x: { name: 'Only' } }, 'only')).toEqual({ label: 'only', title: undefined })
  })

  test('直查优先于反查（tier 键与另一档的 id 撞名时）', () => {
    const clash = { x: { name: 'X 档', id: 'foo' }, y: { name: 'Y 档', id: 'x' } }
    expect(resolveModel(clash, 'x')).toEqual({ label: 'X 档', title: 'foo' })
  })

  test('未配置与 modelNames 缺省：原样显示降级', () => {
    expect(resolveModel(names, 'unknown-model')).toEqual({ label: 'unknown-model', title: undefined })
    expect(resolveModel(null, 'v')).toEqual({ label: 'v', title: undefined })
    expect(resolveModel(undefined, 'v')).toEqual({ label: 'v', title: undefined })
  })
})

describe('apiError：非 2xx 错误提取', () => {
  test('服务端 {error} 字段优先', async () => {
    const r = new Response(JSON.stringify({ error: '会话正在运行，无法归档' }), { status: 409 })
    expect((await apiError(r)).message).toBe('会话正在运行，无法归档')
  })

  test('error 为空串视同缺失，回退 HTTP 状态码', async () => {
    const r = new Response(JSON.stringify({ error: '' }), { status: 500 })
    expect((await apiError(r)).message).toBe('HTTP 500')
  })

  test('非 JSON 应答（网关错误页等）回退 HTTP 状态码', async () => {
    const r = new Response('<html>bad gateway</html>', { status: 502 })
    expect((await apiError(r)).message).toBe('HTTP 502')
  })
})

describe('makeSessionInfo：本地导航条目缺省值', () => {
  test('只给必填字段时补齐占位状态（随后由 WS status 覆盖）', () => {
    const s = makeSessionInfo({ key: 'n|x', slug: 'slug', sessionId: 'sid', backend: 'claude' })
    expect(s.status).toBe('idle')
    expect(s.sizeBytes).toBe(0)
    expect(typeof s.mtime).toBe('number')
    expect(s.managed).toEqual({ spawned: false, busy: false, clients: 0 })
    expect(s.key).toBe('n|x')
  })

  test('显式字段覆盖缺省', () => {
    const s = makeSessionInfo({ key: 'x|th', slug: 'codex', sessionId: 'th', backend: 'codex', status: 'busy', cwd: '/p' })
    expect(s.status).toBe('busy')
    expect(s.cwd).toBe('/p')
  })
})

describe('errorMessage：unknown 错误单行化', () => {
  test('Error 取 message；其余 String() 化', () => {
    expect(errorMessage(new Error('boom'))).toBe('boom')
    expect(errorMessage('plain')).toBe('plain')
    expect(errorMessage(42)).toBe('42')
    expect(errorMessage(undefined)).toBe('undefined')
  })
})

// ---------- apiFetch/postJson：替换 fetch/location/localStorage 全局 ----------

interface FetchCall {
  input: unknown
  init?: RequestInit
}

let fetchCalls: FetchCall[] = []
let nextResponse: Response
let authRequiredCount = 0

const real = {
  fetch: globalThis.fetch,
  location: (globalThis as Record<string, unknown>).location,
  localStorage: (globalThis as Record<string, unknown>).localStorage,
}

beforeEach(() => {
  fetchCalls = []
  authRequiredCount = 0
  nextResponse = new Response('{}', { status: 200 })
  const store = new Map<string, string>()
  ;(globalThis as Record<string, unknown>).location = { search: '' }
  ;(globalThis as Record<string, unknown>).localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  }
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    fetchCalls.push({ input, init })
    return nextResponse
  }) as typeof fetch
})

onAuthRequired(() => {
  authRequiredCount++
})

afterEach(() => {
  globalThis.fetch = real.fetch
  const g = globalThis as Record<string, unknown>
  if (real.location === undefined) delete g.location
  else g.location = real.location
  if (real.localStorage === undefined) delete g.localStorage
  else g.localStorage = real.localStorage
})

describe('apiFetch：认证头与 401 语义', () => {
  test('无 token 时只带调用方 headers', async () => {
    const r = await apiFetch('/api/sessions', { headers: { 'x-custom': '1' } })
    expect(r.status).toBe(200)
    expect(fetchCalls[0]!.init?.headers).toEqual({ 'x-custom': '1' })
  })

  test('localStorage 有 token 时自动并上 authorization', async () => {
    ;(globalThis as { localStorage: Storage }).localStorage.setItem('anyplane-token', 'tok-1')
    await apiFetch('/api/sessions')
    expect(fetchCalls[0]!.init?.headers).toEqual({ authorization: 'Bearer tok-1' })
  })

  test('401 抛 AuthRequiredError 并通知 App 层弹令牌页', async () => {
    nextResponse = new Response('unauthorized', { status: 401 })
    await expect(apiFetch('/api/sessions')).rejects.toBeInstanceOf(AuthRequiredError)
    expect(authRequiredCount).toBe(1)
  })

  test('其他失败状态不抛（错误检查由调用方按需补）', async () => {
    nextResponse = new Response('x', { status: 500 })
    const r = await apiFetch('/api/sessions')
    expect(r.status).toBe(500)
    expect(authRequiredCount).toBe(0)
  })
})

describe('postJson：method/headers/body 组装', () => {
  test('统一 POST + JSON content-type + 序列化 body', async () => {
    await postJson('/api/sessions/archive', { key: 's|a|b' })
    const init = fetchCalls[0]!.init
    expect(init?.method).toBe('POST')
    expect(init?.headers).toMatchObject({ 'content-type': 'application/json' })
    expect(init?.body).toBe(JSON.stringify({ key: 's|a|b' }))
  })
})
