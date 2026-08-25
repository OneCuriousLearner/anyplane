// E2E-Web Push：mock push service + 自造订阅密钥，验证推送全链路
// 覆盖：订阅注册 → 真实审批触发推送 → VAPID JWT 校验 → RFC 8291/8188 解密 →
//       能力 URL 直接审批 → 410 死订阅自动清理
// 用法：bun run server/scripts/e2e-push.ts（需服务端已启动；会真实 spawn 一次 claude 触发审批）
import {
  createHmac,
  createPublicKey,
  createDecipheriv,
  createVerify,
  diffieHellman,
  generateKeyPairSync,
  randomBytes,
} from 'node:crypto'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const BASE = process.env.CC_REMOTE_BASE ?? 'http://127.0.0.1:7480'
const TOKEN_Q = process.env.CC_REMOTE_TOKEN ? `?token=${process.env.CC_REMOTE_TOKEN}` : ''
const results: string[] = []
function note(ok: boolean, label: string, detail = '') {
  results.push(`${ok ? '✓' : '✗'} ${label}${detail ? ` — ${detail}` : ''}`)
  console.log(results[results.length - 1])
}
const b64url = (b: Buffer) => b.toString('base64url')

// ---------- mock push service ----------
interface Captured {
  path: string
  headers: Record<string, string>
  body: Buffer
}
const captured = new Map<string, Captured>()
const gonePaths = new Set<string>()
const mock = Bun.serve({
  port: 18999,
  async fetch(req) {
    const url = new URL(req.url)
    const headers: Record<string, string> = {}
    req.headers.forEach((v, k) => (headers[k] = v))
    // 先捕获再按需 410：死订阅也得留下投递痕迹，测试才能断言"投过但被拒"
    captured.set(url.pathname, { path: url.pathname, headers, body: Buffer.from(await req.arrayBuffer()) })
    if (gonePaths.has(url.pathname)) return new Response('gone', { status: 410 })
    return new Response('ok', { status: 201 })
  },
})

// ---------- HKDF expand（单块，L≤32 足够）与 aes128gcm 解密（RFC 8291 + RFC 8188） ----------
const hmac = (key: Buffer, data: Buffer) => createHmac('sha256', key).update(data).digest()
const expand1 = (prk: Buffer, info: Buffer) => hmac(prk, Buffer.concat([info, Buffer.from([1])]))

function decryptPush(body: Buffer, uaPrivJwk: JsonWebKey, uaPubRaw: Buffer, auth: Buffer): string {
  const salt = body.subarray(0, 16)
  const idLen = body[20]
  const asPubRaw = body.subarray(21, 21 + idLen)
  const ciphertext = body.subarray(21 + idLen)

  const asPub = createPublicKey({
    key: {
      kty: 'EC',
      crv: 'P-256',
      x: b64url(asPubRaw.subarray(1, 33)),
      y: b64url(asPubRaw.subarray(33, 65)),
    },
    format: 'jwk',
  })
  const uaPriv = require('node:crypto').createPrivateKey({ key: uaPrivJwk, format: 'jwk' })
  const ecdhSecret = diffieHellman({ privateKey: uaPriv, publicKey: asPub })

  // RFC 8291：auth secret 参与 key 派生
  const prkKey = hmac(auth, ecdhSecret)
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0', 'utf8'), uaPubRaw, asPubRaw])
  const ikm = expand1(prkKey, keyInfo)
  // RFC 8188 aes128gcm：salt 派生 CEK/NONCE
  const prk = hmac(salt, ikm)
  const cek = expand1(prk, Buffer.from('Content-Encoding: aes128gcm\0', 'utf8')).subarray(0, 16)
  const nonce = expand1(prk, Buffer.from('Content-Encoding: nonce\0', 'utf8')).subarray(0, 12)

  const tag = ciphertext.subarray(ciphertext.length - 16)
  const data = ciphertext.subarray(0, ciphertext.length - 16)
  const dec = createDecipheriv('aes-128-gcm', cek, nonce)
  dec.setAuthTag(tag)
  let plain = Buffer.concat([dec.update(data), dec.final()])
  // 去掉填充定界符（最后一个 record 用 0x02）
  const last = plain.lastIndexOf(0x02)
  plain = plain.subarray(0, last >= 0 ? last : plain.length)
  return plain.toString('utf8')
}

// ---------- 主流程 ----------
const timeout = setTimeout(() => {
  console.error('TIMEOUT\n' + results.join('\n'))
  process.exit(1)
}, 240_000)

try {
  // 1. 造假订阅（模拟浏览器的 p256dh/auth）
  const ua = generateKeyPairSync('ec', { namedCurve: 'P-256' })
  const uaPubJwk = ua.publicKey.export({ format: 'jwk' }) as { x: string; y: string }
  const uaPrivJwk = ua.privateKey.export({ format: 'jwk' }) as JsonWebKey
  const uaPubRaw = Buffer.concat([Buffer.from([4]), Buffer.from(uaPubJwk.x, 'base64url'), Buffer.from(uaPubJwk.y, 'base64url')])
  const auth = randomBytes(16)
  const subA = {
    endpoint: 'http://127.0.0.1:18999/push/A',
    keys: { p256dh: b64url(uaPubRaw), auth: b64url(auth) },
  }
  const reg = await fetch(`${BASE}/api/push/subscriptions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(subA),
  })
  note(reg.ok, '订阅注册', `HTTP ${reg.status}`)
  const { secret } = (await reg.json()) as { secret: string }
  note(typeof secret === 'string' && secret.length > 20, '服务端返回能力密钥')

  // 2. 起 claude 会话，触发真实审批
  const key = `n|${encodeURIComponent('/tmp')}`
  const ws = new WebSocket(`ws://127.0.0.1:7480/ws/sessions/${encodeURIComponent(key)}${TOKEN_Q}`)
  let resolved = false
  let sawResolvedEvent = false
  ws.onmessage = (e) => {
    const ev = JSON.parse(e.data)
    if (ev.kind === 'approval_resolved') sawResolvedEvent = true
  }
  await new Promise<void>((r) => (ws.onopen = () => r()))
  ws.send(JSON.stringify({ kind: 'attach' }))
  await new Promise((r) => setTimeout(r, 500))
  ws.send(
    JSON.stringify({
      kind: 'user',
      text: '请立即用 Write 工具创建文件 /tmp/ccr-push-test.txt，内容写 push-ok。只做这一件事，不要问任何问题。',
    }),
  )

  // 3. 等推送到达 mock（审批事件 → fanout）
  let push: Captured | undefined
  for (let i = 0; i < 120 && !push; i++) {
    await new Promise((r) => setTimeout(r, 1000))
    push = captured.get('/push/A')
  }
  note(!!push, '审批事件触发推送到 mock push service')

  // 4. VAPID JWT 校验
  const authz = push!.headers['authorization'] ?? ''
  const jwtMatch = authz.match(/^vapid t=([^,]+), k=(.+)$/)
  note(!!jwtMatch, 'VAPID Authorization 头形状', authz.slice(0, 40))
  if (jwtMatch) {
    const [h, p, s] = jwtMatch[1].split('.')
    const claims = JSON.parse(Buffer.from(p, 'base64url').toString())
    // web-push VAPID 公钥是 base64url 未压缩点（0x04‖x‖y），转 JWK 验签
    const vapidPub = JSON.parse(readFileSync(join(homedir(), '.cc-remote', 'vapid.json'), 'utf8')).publicKey
    const raw = Buffer.from(vapidPub, 'base64url')
    const vapidKey = createPublicKey({
      key: { kty: 'EC', crv: 'P-256', x: b64url(raw.subarray(1, 33)), y: b64url(raw.subarray(33, 65)) },
      format: 'jwk',
    })
    const sigOk = createVerify('SHA256')
      .update(`${h}.${p}`)
      // JWS 签名是 r‖s 原始拼接（ieee-p1363），verify 默认按 DER 解析会误报
      .verify({ key: vapidKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(s, 'base64url'))
    note(sigOk && claims.aud === 'http://127.0.0.1:18999', 'VAPID JWT 签名有效 + aud 指向 mock', `aud=${claims.aud}`)
    note(Number(claims.exp) > Date.now() / 1000, 'JWT 未过期')
  }

  // 5. 解密推送体
  const text = decryptPush(push!.body, uaPrivJwk, uaPubRaw, auth)
  const payload = JSON.parse(text) as {
    type: string
    title: string
    body: string
    key: string
    requestId?: string
    actions?: { allow: string; deny: string }
  }
  note(payload.type === 'approval' && payload.title.includes('审批'), '推送解密成功（RFC 8291/8188 全链路）', payload.title)
  note(
    !!payload.actions?.allow.endsWith(secret) && !!payload.actions.deny.endsWith(secret),
    '能力 URL 按订阅补全了 secret',
  )
  note(payload.body.includes('/tmp/ccr-push-test.txt'), '推送正文含审批详情（详细内容策略）', payload.body.slice(0, 60))

  // 6. 直接审批：POST 能力 URL（无 authToken——模拟 SW 环境）
  const allowResp = await fetch(`${BASE}${payload.actions!.allow}`, { method: 'POST' })
  const allowJson = (await allowResp.json()) as { ok: boolean; error?: string }
  note(allowResp.ok && allowJson.ok, '能力 URL 直接审批生效', `HTTP ${allowResp.status}`)
  for (let i = 0; i < 10 && !sawResolvedEvent; i++) await new Promise((r) => setTimeout(r, 500))
  note(sawResolvedEvent, 'WS 侧收到 approval_resolved（审批卡同步消失）')
  resolved = true

  // 7. 错 secret 必须 403
  const badResp = await fetch(`${BASE}/api/approval-action?k=x&r=y&d=allow&s=wrong`, { method: 'POST' })
  note(badResp.status === 403, '错误 secret 被拒（403）')

  // 8. 死订阅 410 清理：注册 B（标记 410）→ 再触发一次审批 → B 应被自动摘除
  await fetch(`${BASE}/api/push/subscriptions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      endpoint: 'http://127.0.0.1:18999/push/B',
      keys: { p256dh: b64url(uaPubRaw), auth: b64url(auth) },
    }),
  })
  gonePaths.add('/push/B')
  const countBefore = ((await (await fetch(`${BASE}/api/push/public-key`)).json()) as { subscriptions: number }).subscriptions
  ws.send(JSON.stringify({ kind: 'user', text: '再用 Write 把文件 /tmp/ccr-push-test2.txt 内容写成 push-ok2。只做这一件事。' }))
  let pushB: Captured | undefined
  for (let i = 0; i < 120 && !pushB; i++) {
    await new Promise((r) => setTimeout(r, 1000))
    pushB = captured.get('/push/B')
  }
  note(!!pushB, '第二次审批推送也发到 B（投递了但收到 410）')
  // 同时批掉第二次审批，让会话收尾
  const push2 = captured.get('/push/A')
  if (push2) {
    const p2 = JSON.parse(decryptPush(push2.body, uaPrivJwk, uaPubRaw, auth)) as { actions?: { allow: string } }
    if (p2.actions) await fetch(`${BASE}${p2.actions.allow}`, { method: 'POST' })
  }
  await new Promise((r) => setTimeout(r, 1500))
  const countAfter = ((await (await fetch(`${BASE}/api/push/public-key`)).json()) as { subscriptions: number }).subscriptions
  note(countAfter === countBefore - 1, '410 死订阅自动摘除', `${countBefore} → ${countAfter}`)

  // 9. 清理测试订阅 A
  await fetch(`${BASE}/api/push/subscriptions`, {
    method: 'DELETE',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ endpoint: subA.endpoint }),
  })
  const countFinal = ((await (await fetch(`${BASE}/api/push/public-key`)).json()) as { subscriptions: number }).subscriptions
  note(countFinal === 0, '测试订阅清理完毕', `剩余 ${countFinal}`)

  ws.close()
} finally {
  clearTimeout(timeout)
  mock.stop(true)
}

console.log('\n—— 汇总 ——')
console.log(results.join('\n'))
process.exit(results.some((r) => r.startsWith('✗')) ? 1 : 0)
