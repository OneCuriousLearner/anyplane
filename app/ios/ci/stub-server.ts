// iOS simulator spike 的桩服务器：静态托管 web/dist + 记录裁决 POST。
// 用法：bun app/ios/ci/stub-server.ts <dist目录>（监听 127.0.0.1:7480，
// 裁决请求追加写入 /tmp/resolve.log 并回 409——虚构 requestId，409 属预期，
// 断言点是请求本身到达）。
import { appendFileSync } from 'node:fs'
import { join } from 'node:path'

const dist = process.argv[2] ?? 'web/dist'

Bun.serve({
  port: 7480,
  hostname: '127.0.0.1',
  async fetch(req) {
    const url = new URL(req.url)
    if (url.pathname === '/api/approvals/resolve' && req.method === 'POST') {
      const body = await req.text()
      appendFileSync('/tmp/resolve.log', body + '\n')
      console.log('[stub] resolve POST:', body)
      return Response.json({ error: 'stub 409' }, { status: 409 })
    }
    if (url.pathname === '/api/client-log' && req.method === 'POST') {
      console.log('[stub] client-log:', await req.text())
      return Response.json({ ok: true })
    }
    const p = join(dist, url.pathname === '/' ? 'index.html' : url.pathname)
    const f = Bun.file(p)
    if (await f.exists()) return new Response(f)
    return new Response(Bun.file(join(dist, 'index.html')))
  },
})
console.log(`[stub] listening 127.0.0.1:7480, dist=${dist}`)
