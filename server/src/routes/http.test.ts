import { describe, expect, test } from 'bun:test'
import { json, readJsonBody } from './http'

describe('json', () => {
  test('序列化 JSON 并设置默认 content-type', async () => {
    const response = json({ ok: true })

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('application/json')
    expect(await response.json()).toEqual({ ok: true })
  })

  test('保留 ResponseInit 状态与自定义响应头', () => {
    const response = json({ error: 'bad' }, { status: 422, headers: { 'x-trace': 'route-test' } })

    expect(response.status).toBe(422)
    expect(response.headers.get('x-trace')).toBe('route-test')
    expect(response.headers.get('content-type')).toBe('application/json')
  })
})

describe('readJsonBody', () => {
  test('解析合法 JSON body', async () => {
    const request = new Request('http://localhost/api/test', {
      method: 'POST',
      body: JSON.stringify({ cwd: '/repo' }),
    })

    expect(await readJsonBody<{ cwd: string }>(request)).toEqual({ cwd: '/repo' })
  })

  test('非法 JSON 降级为空对象', async () => {
    const request = new Request('http://localhost/api/test', { method: 'POST', body: '{' })

    expect(await readJsonBody<Record<string, unknown>>(request)).toEqual({})
  })
})
