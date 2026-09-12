import { describe, expect, test } from 'bun:test'
import { dispatchApi, type ApiRouteHandler } from './api'

const request = new Request('http://localhost/api/example')
const url = new URL(request.url)

describe('dispatchApi', () => {
  test('按 handlers 声明顺序分发', async () => {
    const calls: string[] = []
    const handlers: ApiRouteHandler[] = [
      async () => {
        calls.push('push')
        return undefined
      },
      async () => {
        calls.push('sessions')
        return new Response('hit')
      },
    ]

    expect(await (await dispatchApi(request, url, handlers))?.text()).toBe('hit')
    expect(calls).toEqual(['push', 'sessions'])
  })

  test('首个命中后不再调用后续 handler', async () => {
    let laterCalls = 0
    const first = new Response('first', { status: 201 })

    const response = await dispatchApi(request, url, [
      async () => first,
      async () => {
        laterCalls++
        return new Response('later')
      },
    ])

    expect(response).toBe(first)
    expect(laterCalls).toBe(0)
  })

  test('全部未命中时返回 undefined', async () => {
    const response = await dispatchApi(request, url, [
      async () => undefined,
      async () => undefined,
      async () => undefined,
    ])

    expect(response).toBeUndefined()
  })
})
