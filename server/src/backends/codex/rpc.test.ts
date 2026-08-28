// RpcClient 的传输层语义：应答按 id 配对、notification/server request 路由、
// -32001 过载退避重试、超时、进程退出清理、非 JSON 行容错。
// 用 bun -e 起一个假 app-server 子进程跑真实 NDJSON stdio 链路，不碰真实 codex。

import { afterEach, describe, expect, test } from 'bun:test'
import { RpcClient, RpcError } from './rpc'

// 假 app-server：逐行读 stdin，按 method 脚本化应答。
// 无 id 的是客户端 notify；有 id 无 method 的是客户端 respond（忽略）；其余按 method 分发。
const FAKE_SERVER = `
const rl = require('node:readline').createInterface({ input: process.stdin })
let overloadedHits = 0
rl.on('line', (line) => {
  let msg
  try { msg = JSON.parse(line) } catch { return }
  if (msg.id === undefined) {
    if (msg.method === 'die') process.exit(3)
    if (msg.method === 'push') {
      process.stdout.write(JSON.stringify({ method: 'thread/status/changed', params: { status: 'active' } }) + '\\n')
      process.stdout.write(JSON.stringify({ id: 'srv-1', method: 'item/approval/request', params: { tool: 'Bash' } }) + '\\n')
    }
    return
  }
  if (msg.method === undefined) return
  if (msg.method === 'echo') {
    process.stdout.write(JSON.stringify({ id: msg.id, result: { got: msg.params } }) + '\\n')
  } else if (msg.method === 'overloaded-twice') {
    overloadedHits++
    if (overloadedHits <= 2) {
      process.stdout.write(JSON.stringify({ id: msg.id, error: { code: -32001, message: 'overloaded' } }) + '\\n')
    } else {
      process.stdout.write(JSON.stringify({ id: msg.id, result: { attempts: overloadedHits } }) + '\\n')
    }
  } else if (msg.method === 'always-overloaded') {
    process.stdout.write(JSON.stringify({ id: msg.id, error: { code: -32001, message: 'overloaded' } }) + '\\n')
  } else if (msg.method === 'fail') {
    process.stdout.write(JSON.stringify({ id: msg.id, error: { code: -32600, message: 'thread busy' } }) + '\\n')
  } else if (msg.method === 'garbage') {
    process.stdout.write('this is not json\\n')
    process.stdout.write(JSON.stringify({ id: msg.id, result: 'after-garbage' }) + '\\n')
  }
})
`

const clients: RpcClient[] = []

afterEach(() => {
  for (const c of clients.splice(0)) c.kill()
})

function spawnFake(): RpcClient {
  const c = RpcClient.spawn([process.execPath, '-e', FAKE_SERVER])
  clients.push(c)
  return c
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function waitFor(cond: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('waitFor 超时')
    await sleep(20)
  }
}

describe('RpcClient 请求-应答', () => {
  test('result 应答按 id 配对返回', async () => {
    const rpc = spawnFake()
    const r = await rpc.request('echo', { hello: 'world' })
    expect(r).toEqual({ got: { hello: 'world' } })
  })

  test('并发请求各自配对，互不串扰', async () => {
    const rpc = spawnFake()
    const [a, b] = await Promise.all([rpc.request('echo', { n: 1 }), rpc.request('echo', { n: 2 })])
    expect(a).toEqual({ got: { n: 1 } })
    expect(b).toEqual({ got: { n: 2 } })
  })

  test('error 应答 reject 为 RpcError，保留 code 与 message', async () => {
    const rpc = spawnFake()
    const err = await rpc.request('fail').catch((e) => e)
    expect(err).toBeInstanceOf(RpcError)
    expect((err as RpcError).code).toBe(-32600)
    expect((err as Error).message).toContain('thread busy')
  })

  test('stdout 混入非 JSON 行时不影响后续应答解析', async () => {
    const rpc = spawnFake()
    const r = await rpc.request('garbage')
    expect(r).toBe('after-garbage')
  })
})

describe('RpcClient -32001 过载退避', () => {
  test('前两次 -32001 后自动重试，第三次成功', async () => {
    const rpc = spawnFake()
    const r = (await rpc.request('overloaded-twice')) as { attempts: number }
    expect(r.attempts).toBe(3)
  }, 10000)

  test('超过 maxRetries 后 reject 最后一次 -32001 错误', async () => {
    const rpc = spawnFake()
    const err = await rpc.request('always-overloaded', undefined, { maxRetries: 2 }).catch((e) => e)
    expect(err).toBeInstanceOf(RpcError)
    expect((err as RpcError).code).toBe(-32001)
  }, 10000)
})

describe('RpcClient 超时与进程退出', () => {
  test('超时：pending 请求在 timeoutMs 后 reject', async () => {
    const rpc = spawnFake()
    const err = await rpc.request('slow', undefined, { timeoutMs: 200 }).catch((e) => e)
    expect(err).toBeInstanceOf(Error)
    expect((err as Error).message).toContain('超时')
  })

  test('进程退出：所有 pending 请求 reject，onExit 携带退出码', async () => {
    const rpc = spawnFake()
    const exitCode = new Promise<number>((resolve) => {
      rpc.onExit = resolve
    })
    const slowReq = rpc.request('slow', undefined, { timeoutMs: 30_000 }).catch((e) => e)
    rpc.notify('die')
    expect(await exitCode).toBe(3)
    expect(((await slowReq) as Error).message).toContain('已退出')
    expect(rpc.exited).toBe(true)
  })

  test('进程退出后：request 立即 reject，notify/respond 同步抛错', async () => {
    const rpc = spawnFake()
    rpc.notify('die')
    await waitFor(() => rpc.exited)
    const err = await rpc.request('echo').catch((e) => e)
    expect((err as Error).message).toContain('未运行')
    expect(() => rpc.notify('push')).toThrow(/未运行/)
    expect(() => rpc.respond(1, {})).toThrow(/未运行/)
  })
})

describe('RpcClient 下行消息路由', () => {
  test('notification 与 server 发起的 request 分别路由到对应回调', async () => {
    const rpc = spawnFake()
    const notifications: Array<{ method: string; params?: unknown }> = []
    const serverRequests: Array<{ id: number | string; method: string }> = []
    rpc.onNotification = (n) => notifications.push(n)
    rpc.onServerRequest = (r) => serverRequests.push(r)
    rpc.notify('push')
    await waitFor(() => notifications.length === 1 && serverRequests.length === 1)
    expect(notifications[0]?.method).toBe('thread/status/changed')
    expect(serverRequests[0]).toMatchObject({ id: 'srv-1', method: 'item/approval/request' })
    // 应答 server request 不产生新的 pending，也不应崩溃
    rpc.respond('srv-1', { approved: true })
  })
})
