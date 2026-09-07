// Web Push 订阅管理与能力 URL 审批路由：
// /api/push/*、/api/approval-action、/api/approval-page。

import { resolveApproval } from '../hub/lifecycle'
import { hubs } from '../hub/registry'
import { log } from '../log'
import {
  addSubscription,
  pushToAll,
  pushWebhooksToAll,
  removeSubscription,
  subscriptionCount,
  vapidPublicKey,
  validSecret,
  webhookCount,
  type PushPayload,
} from '../push'
import { approvalPageHtml, sessionNameOf } from '../push/fanout'
import { errorMessage } from '../util'
import { json, readJsonBody } from './http'

export async function handlePushRoutes(req: Request, url: URL): Promise<Response | undefined> {
  if (url.pathname === '/api/push/public-key' && req.method === 'GET') {
    return json({ publicKey: vapidPublicKey(), subscriptions: subscriptionCount(), webhooks: webhookCount() })
  }
  if (url.pathname === '/api/push/subscriptions' && req.method === 'POST') {
    const body = await readJsonBody<{ endpoint?: string; keys?: { p256dh: string; auth: string } }>(req)
    if (!body.endpoint || !body.keys?.p256dh || !body.keys?.auth) {
      return json({ error: 'endpoint 与 keys.p256dh/auth 必填' }, { status: 400 })
    }
    let secret: string
    try {
      secret = addSubscription(
        { endpoint: body.endpoint, keys: body.keys },
        req.headers.get('user-agent') ?? undefined,
      ).secret
    } catch (e) {
      return json({ error: errorMessage(e) }, { status: 400 })
    }
    log.info(`[push] 新订阅（共 ${subscriptionCount()}）：${body.endpoint.slice(0, 60)}…`)
    return json({ ok: true, secret })
  }
  if (url.pathname === '/api/push/subscriptions' && req.method === 'DELETE') {
    const body = await readJsonBody<{ endpoint?: string }>(req)
    return json({ ok: body.endpoint ? removeSubscription(body.endpoint) : false })
  }
  // 推送通道自检：向全部订阅与 webhook 通道 fanout 一条测试通知（不带审批能力，点击落应用首页）
  if (url.pathname === '/api/push/test' && req.method === 'POST') {
    const payload: PushPayload = {
      type: 'done',
      title: '测试通知 · AnyPlane',
      body: '推送链路可达：全部订阅与 webhook 通道会同时收到这一条。',
      key: '',
      session: 'anyplane',
      tag: 'ccr-test',
    }
    const [push, hooks] = await Promise.all([pushToAll(payload), pushWebhooksToAll(payload)])
    return json({
      ok: true,
      subscriptions: subscriptionCount(),
      webhooks: webhookCount(),
      sent: push.sent + hooks.sent,
      pruned: push.pruned,
    })
  }
  // 推送直接审批（能力 URL：secret 鉴权，不走 authToken——该 URL 只经加密推送投递到订阅设备）
  if (url.pathname === '/api/approval-action' && req.method === 'POST') {
    const key = url.searchParams.get('k') ?? ''
    const requestId = url.searchParams.get('r') ?? ''
    const decision = url.searchParams.get('d') ?? ''
    const secret = url.searchParams.get('s') ?? ''
    if (!validSecret(secret)) return json({ ok: false, error: '无效的能力密钥' }, { status: 403 })
    if (decision !== 'allow' && decision !== 'deny') {
      return json({ ok: false, error: 'd 只接受 allow/deny' }, { status: 400 })
    }
    const hub = hubs.get(key)
    if (!hub || !hub.pendingApprovals.has(requestId)) {
      return json({ ok: false, error: '该审批已处理或不存在' }, { status: 409 })
    }
    const pending = hub.pendingApprovals.get(requestId)!
    const ok = resolveApproval(
      hub,
      requestId,
      decision === 'allow'
        ? { behavior: 'allow', updatedInput: pending.input }
        : { behavior: 'deny', message: '用户在推送通知上拒绝了该操作' },
    )
    log.info(`[push] 通知直接审批 ${decision}：${sessionNameOf(key)} · ${pending.toolName}`)
    return json({ ok })
  }
  // webhook 通知的审批确认页（Bark/Server酱 无原生按钮：点链接进此页，按钮再 POST 到 approval-action）。
  // GET 只渲染不执行——通知链接被预览/抓取也不会误触审批。能力 URL 模型同 approval-action。
  if (url.pathname === '/api/approval-page' && req.method === 'GET') {
    const key = url.searchParams.get('k') ?? ''
    const requestId = url.searchParams.get('r') ?? ''
    const secret = url.searchParams.get('s') ?? ''
    if (!validSecret(secret)) return new Response('无效的能力密钥', { status: 403 })
    const pending = hubs.get(key)?.pendingApprovals.get(requestId)
    return new Response(approvalPageHtml(key, pending), {
      headers: { 'content-type': 'text/html; charset=utf-8' },
    })
  }
  return undefined
}
