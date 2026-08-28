// -32001 过载退避重试的回归测试：重试请求必须重新注册 pending 并重新武装超时，
// 否则重试应答被静默丢弃、Promise 永久悬挂（修复前行为）。
import { describe, expect, test } from 'bun:test'
import { RpcClient } from './rpc'

/** mock app-server：对同一 id 的第 1 次请求应答 -32001，第 2 次应答成功 */
function spawnFlakyServer(): RpcClient {
  const script = `
const decoder = new TextDecoder()
let buf = ''
const seen = new Map()
process.stdin.on('data', (chunk) => {
  buf += decoder.decode(chunk)
  let i
  while ((i = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, i)
    buf = buf.slice(i + 1)
    if (!line.trim()) continue
    const msg = JSON.parse(line)
    const n = (seen.get(msg.id) ?? 0) + 1
    seen.set(msg.id, n)
    if (n === 1) {
      process.stdout.write(JSON.stringify({ id: msg.id, error: { code: -32001, message: 'overloaded' } }) + '\\n')
    } else {
      process.stdout.write(JSON.stringify({ id: msg.id, result: { ok: true, attempt: n } }) + '\\n')
    }
  }
})
`
  const bun = process.execPath // 当前 bun 可执行文件
  return RpcClient.spawn([bun, '-e', script])
}

describe('RpcClient -32001 过载退避', () => {
  test('重试后应答能送达调用方（而非静默丢弃导致永久悬挂）', async () => {
    const client = spawnFlakyServer()
    try {
      const result = (await client.request('thread/start', {}, { timeoutMs: 5_000 })) as {
        ok: boolean
        attempt: number
      }
      expect(result.ok).toBe(true)
      expect(result.attempt).toBe(2) // 首次 -32001，重试成功
    } finally {
      client.kill()
    }
  }, 15_000)

  test('持续过载：重试次数耗尽后以最后一次 -32001 拒绝', async () => {
    const script = `
const decoder = new TextDecoder()
let buf = ''
process.stdin.on('data', (chunk) => {
  buf += decoder.decode(chunk)
  let i
  while ((i = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, i)
    buf = buf.slice(i + 1)
    if (!line.trim()) continue
    const msg = JSON.parse(line)
    process.stdout.write(JSON.stringify({ id: msg.id, error: { code: -32001, message: 'overloaded' } }) + '\\n')
  }
})
`
    const client = RpcClient.spawn([process.execPath, '-e', script])
    try {
      await expect(client.request('turn/start', {}, { timeoutMs: 5_000, maxRetries: 2 })).rejects.toThrow('-32001')
    } finally {
      client.kill()
    }
  }, 15_000)

  test('重试等待期间进程退出：请求被拒绝而非悬挂', async () => {
    // 首次应答 -32001 后立即退出
    const script = `
const decoder = new TextDecoder()
let buf = ''
process.stdin.on('data', (chunk) => {
  buf += decoder.decode(chunk)
  let i
  while ((i = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, i)
    buf = buf.slice(i + 1)
    if (!line.trim()) continue
    const msg = JSON.parse(line)
    process.stdout.write(JSON.stringify({ id: msg.id, error: { code: -32001, message: 'overloaded' } }) + '\\n')
    setTimeout(() => process.exit(1), 50)
  }
})
`
    const client = RpcClient.spawn([process.execPath, '-e', script])
    await expect(client.request('turn/start', {}, { timeoutMs: 5_000, maxRetries: 4 })).rejects.toThrow()
  }, 15_000)
})
