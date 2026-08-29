// 推送分发层：inbox 事件 → Web Push fan-out + webhook 通道（ntfy/Bark/Server酱）。
// 自实现 VAPID（RFC 8292）+ aes128gcm 载荷加密（RFC 8291/8188）——不引 web-push 库：
// 其发送路径走 node:https 且假定 TLS（本地 mock/非标端点直接 WRONG_VERSION_NUMBER），
// 而 Bun fetch + node:crypto 的组合在双运行时下行为完全可控。配方由 e2e-push.ts 解密反向验证。
//
// 数据落 ~/.anyplane/（沿用运行数据约定，不自动清理；410/404 的死订阅例外——已失效才摘）：
//   vapid.json                  VAPID P-256 密钥对（首次启动生成，mode 600）
//   push-subscriptions.json     浏览器订阅注册表，每行带 per-subscription secret（能力密钥）
//
// 能力模型：直接审批 URL 只经端到端加密的推送（或受信的 webhook 渠道）投递到设备，
// 「持有有效 secret + requestId 处于 pending」即充分条件，不依赖页面登录态。

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
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
import { join } from 'node:path'
import { isLoopbackHostname } from './auth'
import { config, type PushWebhookConfig } from './config'
import { ccDataDir } from './util'

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

const b64url = (b: Buffer) => b.toString('base64url')
const hmac = (key: Buffer, data: Buffer) => createHmac('sha256', key).update(data).digest()
/** HKDF-Expand 单块（输出 ≤32 字节，本协议全部派生都满足） */
const expand1 = (prk: Buffer, info: Buffer) => hmac(prk, Buffer.concat([info, Buffer.from([1])]))

// ---------- VAPID 密钥对（P-256；publicKey 为未压缩点 base64url，privateKey 为 d base64url） ----------

interface VapidKeys { publicKey: string; privateKey: string }
let vapid: VapidKeys | undefined

function loadVapid(): VapidKeys {
  if (!vapid) {
    const path = join(ccDataDir(), 'vapid.json')
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
      JSON.stringify({ aud: audience, exp: now + 12 * 3600, sub: 'mailto:anyplane@localhost' }),
    ),
  )
  const pubRaw = Buffer.from(keys.publicKey, 'base64url')
  const priv = createPrivateKey({
    key: {
      kty: 'EC',
      crv: 'P-256',
      d: keys.privateKey,
      x: b64url(pubRaw.subarray(1, 33)),
      y: b64url(pubRaw.subarray(33, 65)),
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
  return join(ccDataDir(), 'push-subscriptions.json')
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
  if (!endpointAllowed(sub.endpoint)) {
    throw new Error('endpoint 不在允许的推送服务列表（可在配置的 pushAllowHosts 追加）')
  }
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

// ---------- endpoint 白名单（订阅注册 SSRF / 通知窃听防护） ----------
// inbox 事件会扇出给全部订阅（含审批命令摘要与能力 URL），任意 endpoint 注册 =
// 窃听全部会话通知 + 向内网盲 POST。缺省仅主流推送服务 + 回环 mock（e2e/自托管调试）。

const DEFAULT_PUSH_HOSTS = [
  'fcm.googleapis.com',
  'push.services.mozilla.com',
  'updates.push.services.mozilla.com',
  'web.push.apple.com',
  'notify.windows.com',
]

export function endpointAllowed(endpoint: string): boolean {
  let u: URL
  try {
    u = new URL(endpoint)
  } catch {
    return false
  }
  // 本地 mock 推送服务（e2e-push/自托管调试）：回环不限协议。
  // 必须先于 '*' 判定——否则配了 '*' 的环境反而用不了本地 mock。
  if (isLoopbackHostname(u.hostname)) return true
  const allow = config.pushAllowHosts ?? DEFAULT_PUSH_HOSTS
  if (allow.includes('*')) return u.protocol === 'https:'
  if (u.protocol !== 'https:') return false
  return allow.some((h) => u.hostname === h || u.hostname.endsWith(`.${h}`))
}

export function subscriptionCount(): number {
  return loadSubs().length
}

/** 能力校验：secret 属于某个存活订阅或某个配置的 webhook 通道 */
export function validSecret(secret: string): boolean {
  if (!secret) return false
  if (loadSubs().some((r) => r.secret === secret)) return true
  let keys: VapidKeys
  try {
    keys = loadVapid()
  } catch {
    // vapid 私钥无法加载时（权限/损坏），webhook secret 派生不可信，整体拒绝
    return false
  }
  return (config.pushWebhooks ?? []).some((wh) => webhookSecretWithKey(wh, keys) === secret)
}

/** 从指定 vapid 私钥派生的 per-webhook 能力密钥（测试/预计算用） */
function webhookSecretWithKey(wh: PushWebhookConfig, keys: VapidKeys): string {
  return hmac(Buffer.from(keys.privateKey, 'base64url'), Buffer.from(`webhook:${webhookId(wh)}`))
    .subarray(0, 18)
    .toString('base64url')
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
    // 不跟随重定向：302 可把请求带去白名单外的目标
    redirect: 'manual',
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

// ---------- webhook 通道（ntfy / Bark / Server酱 Turbo） ----------
// 国内 Android 无 FCM 的出路：通知经 ntfy app / Bark / 微信（Server酱）触达。
// 配置即信任（配置文件作者 = 服务端管理员，无浏览器注册面），故不需要 endpoint 白名单；
// 代价是渠道方能读通知全文（Web Push 是端到端加密，webhook 不是）——见 config.ts 注释。
//
// 能力密钥不落新状态：secret = HMAC(vapid 私钥, 'webhook:'+渠道标识) 派生，
// 与订阅 secret 同强度（伪造需读取 600 权限的 vapid.json，那时服务端已失守），
// 且配置改动（换 topic/key）自然作废旧 URL。
//
// 直接审批分级保真：
//   ntfy  —— http action 按钮真 POST，app 内一键裁决不打开页面（clear:true 点完即收）
//   Bark/Server酱 —— 无原生按钮，链接落 GET /api/approval-page 确认页（按钮再 POST），
//                    不做直出 GET 审批链接：链接被预览/抓取即误触。

/** 渠道标识：唯一定位一条配置的字符串（secret 派生输入，也用于日志）
 *  ntfy server 必须规范化（去掉末尾斜杠），否则 https://ntfy.sh/ 与 https://ntfy.sh
 *  会派生不同 secret，导致改配置后旧审批 URL 失效。
 */
function webhookId(wh: PushWebhookConfig): string {
  switch (wh.type) {
    case 'ntfy':
      return `ntfy:${(wh.server ?? 'https://ntfy.sh').replace(/\/+$/, '')}/${wh.topic}`
    case 'bark':
      return `bark:${wh.url}`
    case 'sct':
      return `sct:${wh.sendkey}`
  }
}

/** 从 vapid 私钥派生的 per-webhook 能力密钥（18 字节 → 24 字符，与订阅 secret 同长） */
function webhookSecret(wh: PushWebhookConfig): string {
  return webhookSecretWithKey(wh, loadVapid())
}

export function webhookCount(): number {
  return config.pushWebhooks?.length ?? 0
}

/** 绝对 URL：webhook 的深链与审批按钮不在本站上下文，必须有公网基准；未配置则降级纯文本 */
function absoluteUrl(path: string): string | undefined {
  const base = config.publicUrl?.replace(/\/+$/, '')
  return base ? base + path : undefined
}

/** 会话深链（App.tsx 的 #s=<key> 格式） */
function sessionLink(key: string): string | undefined {
  return absoluteUrl(`/#s=${encodeURIComponent(key)}`)
}

/** webhook 审批确认页（Bark/Server酱 的链接落点；GET 只渲染，POST 才执行） */
function approvalPageLink(wh: PushWebhookConfig, payload: PushPayload): string | undefined {
  if (!payload.requestId) return undefined
  return absoluteUrl(
    `/api/approval-page?k=${encodeURIComponent(payload.key)}&r=${encodeURIComponent(payload.requestId)}&s=${webhookSecret(wh)}`,
  )
}

/** ntfy JSON publish（https://docs.ntfy.sh/publish/#publish-as-json，避开 header 非 ASCII 编码问题） */
async function sendNtfy(
  wh: { type: 'ntfy'; topic: string; server?: string; token?: string },
  payload: PushPayload,
): Promise<number> {
  const server = (wh.server ?? 'https://ntfy.sh').replace(/\/+$/, '')
  const body: Record<string, unknown> = {
    topic: wh.topic,
    title: payload.title,
    message: payload.body,
    priority: payload.type === 'done' ? 3 : 4,
  }
  const click = sessionLink(payload.key)
  if (click) body.click = click
  if (payload.actions) {
    const secret = webhookSecret(wh)
    const allow = absoluteUrl(payload.actions.allow + secret)
    const deny = absoluteUrl(payload.actions.deny + secret)
    if (allow && deny) {
      body.actions = [
        { action: 'http', label: '允许', url: allow, method: 'POST', clear: true },
        { action: 'http', label: '拒绝', url: deny, method: 'POST', clear: true },
      ]
    }
  }
  const resp = await fetch(`${server}/`, {
    method: 'POST',
    redirect: 'manual',
    headers: {
      'content-type': 'application/json',
      ...(wh.token ? { authorization: `Bearer ${wh.token}` } : {}),
    },
    body: JSON.stringify(body),
  })
  return resp.status
}

/** Bark：POST JSON 到完整推送 URL（api.day.app/<key> 或自建 bark-server） */
async function sendBark(wh: { type: 'bark'; url: string }, payload: PushPayload): Promise<number> {
  const body: Record<string, unknown> = {
    title: payload.title,
    body: payload.body,
    group: 'anyplane',
    level: payload.type === 'done' ? 'active' : 'timeSensitive',
  }
  const link = payload.type === 'approval' ? approvalPageLink(wh, payload) : sessionLink(payload.key)
  if (link) body.url = link
  const resp = await fetch(wh.url, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return resp.status
}

/** Server酱 Turbo：form POST，desp 走 markdown（审批链接/深链以 markdown 链接呈现） */
async function sendSct(wh: { type: 'sct'; sendkey: string }, payload: PushPayload): Promise<number> {
  const lines = [payload.body]
  if (payload.type === 'approval') {
    const page = approvalPageLink(wh, payload)
    if (page) lines.push('', `[👉 前往审批（允许 / 拒绝）](${page})`)
  } else {
    const click = sessionLink(payload.key)
    if (click) lines.push('', `[查看会话](${click})`)
  }
  const form = new URLSearchParams()
  form.set('title', payload.title.slice(0, 32)) // Server酱标题上限 32 字符
  form.set('desp', lines.join('\n'))
  const resp = await fetch(`https://sctapi.ftqq.com/${wh.sendkey}.send`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: form.toString(),
  })
  return resp.status
}

/** 单 webhook 投递；未知类型返回 undefined，由调用方记日志 */
async function sendWebhook(wh: PushWebhookConfig, payload: PushPayload): Promise<number | undefined> {
  switch (wh.type) {
    case 'ntfy':
      return sendNtfy(wh, payload)
    case 'bark':
      return sendBark(wh, payload)
    case 'sct':
      return sendSct(wh, payload)
    default:
      return undefined
  }
}

/** fan-out 到全部 webhook 通道；单通道失败只记日志，不影响其他通道与 Web Push */
export async function pushWebhooksToAll(payload: PushPayload): Promise<{ sent: number }> {
  const hooks = config.pushWebhooks ?? []
  let sent = 0
  await Promise.allSettled(
    hooks.map(async (wh) => {
      try {
        const status = await sendWebhook(wh, payload)
        if (status === undefined) {
          console.warn(`[push] webhook ${webhookId(wh)} 类型未知，跳过`)
          return
        }
        if (status >= 200 && status < 300) {
          sent++
        } else {
          console.warn(`[push] webhook ${webhookId(wh)} 投递失败 (HTTP ${status})`)
        }
      } catch (e) {
        console.warn(`[push] webhook ${webhookId(wh)} 投递失败:`, e instanceof Error ? e.message : e)
      }
    }),
  )
  return { sent }
}
