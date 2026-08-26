// 推送分发层：inbox 事件 → Web Push fan-out。
// 自实现 VAPID（RFC 8292）+ aes128gcm 载荷加密（RFC 8291/8188）——不引 web-push 库：
// 其发送路径走 node:https 且假定 TLS（本地 mock/非标端点直接 WRONG_VERSION_NUMBER），
// 而 Bun fetch + node:crypto 的组合在双运行时下行为完全可控。配方由 e2e-push.ts 解密反向验证。
//
// 数据落 ~/.cc-remote/（沿用运行数据约定，不自动清理；410/404 的死订阅例外——已失效才摘）：
//   vapid.json                  VAPID P-256 密钥对（首次启动生成，mode 600）
//   push-subscriptions.json     浏览器订阅注册表，每行带 per-subscription secret（能力密钥）
//
// 能力模型：直接审批 URL 只经端到端加密的推送投递到订阅设备，
// 「持有有效 secret + requestId 处于 pending」即充分条件，不依赖页面登录态。

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import {
  createCipheriv,
  createHmac,
  createPrivateKey,
  createPublicKey,
  createSign,
  diffieHellman,
  generateKeyPairSync,
  randomBytes,
} from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'

export interface PushSubscriptionRow {
  endpoint: string
  keys: { p256dh: string; auth: string }
  /** 能力密钥：直接审批 URL 的鉴权凭据 */
  secret: string
  createdAt: number
  userAgent?: string
}

/** 推送载荷（SW 的 push 事件直接消费）；approval 带直接审批 URL */
export interface PushPayload {
  type: 'approval' | 'done' | 'error'
  title: string
  body: string
  /** 会话 key（深链用） */
  key: string
  /** 会话显示名（项目目录名） */
  session: string
  requestId?: string
  /** 直接审批能力 URL（相对路径，SW 同源 fetch），以 s= 结尾由 pushToAll 按订阅补全 */
  actions?: { allow: string; deny: string }
  /** 同 requestId 的通知互相替换，避免审批堆叠 */
  tag?: string
}

function dataDir(): string {
  const d = join(homedir(), '.cc-remote')
  mkdirSync(d, { recursive: true }) // recursive 幂等：已存在不抛错
  return d
}

const b64url = (b: Buffer) => b.toString('base64url')
const hmac = (key: Buffer, data: Buffer) => createHmac('sha256', key).update(data).digest()
/** HKDF-Expand 单块（输出 ≤32 字节，本协议全部派生都满足） */
const expand1 = (prk: Buffer, info: Buffer) => hmac(prk, Buffer.concat([info, Buffer.from([1])]))

// ---------- VAPID 密钥对（P-256；publicKey 为未压缩点 base64url，privateKey 为 d base64url） ----------

interface VapidKeys { publicKey: string; privateKey: string }
let vapid: VapidKeys | undefined

function loadVapid(): VapidKeys {
  if (!vapid) {
    const path = join(dataDir(), 'vapid.json')
    if (existsSync(path)) {
      vapid = JSON.parse(readFileSync(path, 'utf8')) as VapidKeys
    } else {
      const pair = generateKeyPairSync('ec', { namedCurve: 'P-256' })
      const pub = pair.publicKey.export({ format: 'jwk' }) as { x: string; y: string }
      const priv = pair.privateKey.export({ format: 'jwk' }) as { d: string }
      vapid = {
        publicKey: b64url(Buffer.concat([Buffer.from([4]), Buffer.from(pub.x, 'base64url'), Buffer.from(pub.y, 'base64url')])),
        privateKey: priv.d,
      }
      writeFileSync(path, JSON.stringify(vapid, null, 2), { mode: 0o600 })
    }
  }
  return vapid
}

export function vapidPublicKey(): string {
  return loadVapid().publicKey
}

/** VAPID 证明：ES256 JWT（JWS 签名为 r‖s 原始拼接，即 ieee-p1363）。
 *  同一 origin 的 JWT 在 12h 有效期内可复用——按 origin 缓存，11h 后重签，
 *  避免多订阅扇出时每个订阅重复一次 ECDSA 签名。 */
const jwtCache = new Map<string, { jwt: string; refreshAfter: number }>()

function vapidJwt(audience: string): string {
  const now = Math.floor(Date.now() / 1000)
  const hit = jwtCache.get(audience)
  if (hit && now < hit.refreshAfter) return hit.jwt
  const keys = loadVapid()
  const header = b64url(Buffer.from(JSON.stringify({ typ: 'JWT', alg: 'ES256' })))
  const body = b64url(
    Buffer.from(
      JSON.stringify({ aud: audience, exp: now + 12 * 3600, sub: 'mailto:cc-remote@localhost' }),
    ),
  )
  const priv = createPrivateKey({
    key: {
      kty: 'EC',
      crv: 'P-256',
      d: keys.privateKey,
      ...((): { x: string; y: string } => {
        const raw = Buffer.from(keys.publicKey, 'base64url')
        return { x: b64url(raw.subarray(1, 33)), y: b64url(raw.subarray(33, 65)) }
      })(),
    },
    format: 'jwk',
  })
  const sig = createSign('SHA256')
    .update(`${header}.${body}`)
    .sign({ key: priv, dsaEncoding: 'ieee-p1363' })
  const jwt = `${header}.${body}.${b64url(sig)}`
  jwtCache.set(audience, { jwt, refreshAfter: now + 11 * 3600 })
  return jwt
}

// ---------- 载荷加密（RFC 8291：ECDH + auth secret；RFC 8188：aes128gcm 单 record） ----------

function encryptPayload(plaintext: Buffer, sub: PushSubscriptionRow): Buffer {
  const uaPubRaw = Buffer.from(sub.keys.p256dh, 'base64url')
  const auth = Buffer.from(sub.keys.auth, 'base64url')
  // 每条消息生成一次性发送方密钥对
  const sender = generateKeyPairSync('ec', { namedCurve: 'P-256' })
  const senderPubJwk = sender.publicKey.export({ format: 'jwk' }) as { x: string; y: string }
  const senderPubRaw = Buffer.concat([
    Buffer.from([4]),
    Buffer.from(senderPubJwk.x, 'base64url'),
    Buffer.from(senderPubJwk.y, 'base64url'),
  ])
  const uaPub = createPublicKey({
    key: { kty: 'EC', crv: 'P-256', x: b64url(uaPubRaw.subarray(1, 33)), y: b64url(uaPubRaw.subarray(33, 65)) },
    format: 'jwk',
  })
  const ecdhSecret = diffieHellman({ privateKey: sender.privateKey, publicKey: uaPub })

  // RFC 8291：auth secret 参与派生
  const prkKey = hmac(auth, ecdhSecret)
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0', 'utf8'), uaPubRaw, senderPubRaw])
  const ikm = expand1(prkKey, keyInfo)
  // RFC 8188：salt 派生 CEK/NONCE
  const salt = randomBytes(16)
  const prk = hmac(salt, ikm)
  const cek = expand1(prk, Buffer.from('Content-Encoding: aes128gcm\0', 'utf8')).subarray(0, 16)
  const nonce = expand1(prk, Buffer.from('Content-Encoding: nonce\0', 'utf8')).subarray(0, 12)

  // 内容 + 0x02 定界符（单 record 即最后一个）
  const cipher = createCipheriv('aes-128-gcm', cek, nonce)
  const enc = Buffer.concat([cipher.update(Buffer.concat([plaintext, Buffer.from([2])])), cipher.final()])
  const tag = cipher.getAuthTag()

  // aes128gcm body：salt(16) ‖ rs(4,BE) ‖ idlen(1) ‖ senderPub(65) ‖ ciphertext ‖ tag
  const header = Buffer.alloc(21)
  salt.copy(header, 0)
  header.writeUInt32BE(4096, 16) // rs
  header[20] = senderPubRaw.length
  return Buffer.concat([header, senderPubRaw, enc, tag])
}

// ---------- 订阅注册表 ----------

let subs: PushSubscriptionRow[] | undefined

function subsPath(): string {
  return join(dataDir(), 'push-subscriptions.json')
}

function loadSubs(): PushSubscriptionRow[] {
  if (!subs) {
    const path = subsPath()
    subs = existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as PushSubscriptionRow[]) : []
  }
  return subs
}

function saveSubs(): void {
  writeFileSync(subsPath(), JSON.stringify(loadSubs(), null, 2), { mode: 0o600 })
}

export function addSubscription(
  sub: { endpoint: string; keys: { p256dh: string; auth: string } },
  userAgent?: string,
): { secret: string } {
  const all = loadSubs()
  const existing = all.find((r) => r.endpoint === sub.endpoint)
  if (existing) {
    // 同一 endpoint 重复订阅（浏览器刷新订阅对象）：保留原 secret，更新密钥
    existing.keys = sub.keys
    if (userAgent) existing.userAgent = userAgent
    saveSubs()
    return { secret: existing.secret }
  }
  const row: PushSubscriptionRow = {
    endpoint: sub.endpoint,
    keys: sub.keys,
    secret: randomBytes(24).toString('base64url'),
    createdAt: Date.now(),
    userAgent,
  }
  all.push(row)
  saveSubs()
  return { secret: row.secret }
}

export function removeSubscription(endpoint: string): boolean {
  const all = loadSubs()
  const i = all.findIndex((r) => r.endpoint === endpoint)
  if (i < 0) return false
  all.splice(i, 1)
  saveSubs()
  return true
}

export function subscriptionCount(): number {
  return loadSubs().length
}

/** 能力校验：secret 属于某个存活订阅 */
export function validSecret(secret: string): boolean {
  if (!secret) return false
  return loadSubs().some((r) => r.secret === secret)
}

// ---------- 投递 ----------

/** 单条投递：Bun fetch（http/https 均可），返回 push service 状态码 */
async function sendOne(row: PushSubscriptionRow, payload: PushPayload): Promise<number> {
  const body = payload.actions
    ? JSON.stringify({
        ...payload,
        actions: { allow: payload.actions.allow + row.secret, deny: payload.actions.deny + row.secret },
      })
    : JSON.stringify(payload)
  const origin = new URL(row.endpoint).origin
  const resp = await fetch(row.endpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/octet-stream',
      'content-encoding': 'aes128gcm',
      ttl: '3600',
      urgency: payload.type === 'approval' ? 'high' : 'normal',
      authorization: `vapid t=${vapidJwt(origin)}, k=${vapidPublicKey()}`,
    },
    body: new Uint8Array(encryptPayload(Buffer.from(body, 'utf8'), row)),
  })
  return resp.status
}

/** fan-out 到全部订阅；push service 判定失效（404/410）的订阅摘除 */
export async function pushToAll(payload: PushPayload): Promise<{ sent: number; pruned: number }> {
  const all = loadSubs()
  if (all.length === 0) return { sent: 0, pruned: 0 }
  let sent = 0
  let pruned = 0
  await Promise.allSettled(
    all.map(async (row) => {
      try {
        const status = await sendOne(row, payload)
        if (status === 404 || status === 410) {
          pruned++
          removeSubscription(row.endpoint)
        } else if (status >= 200 && status < 300) {
          sent++
        } else {
          console.warn(`[push] 投递失败 (HTTP ${status})：${row.endpoint.slice(0, 60)}`)
        }
      } catch (e) {
        console.warn(`[push] 投递失败 (network):`, e instanceof Error ? e.message : e)
      }
    }),
  )
  return { sent, pruned }
}
