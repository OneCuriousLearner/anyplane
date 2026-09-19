// 其余 REST 路由：fs/list、handoff、lineage、uploads、history（claude/codex）、
// codex/models、config、claude/model-names、backends/status。

import type { HistoryResponse, LineageNode, LineageResponse, ServerConfigInfo } from '@anyplane/protocol'
import { backendPort, describeKey } from '../backends/port'
import { getBackendsStatus } from '../backends/status'
import { config } from '../config'
import { FsBrowseError, listDirectories } from '../fsbrowse'
import { lineageFor, type HandoffDetail } from '../lineage'
import { runHandoff } from '../hub/handoff'
import { resolveApprovalRest } from '../hub/lifecycle'
import { log } from '../log'
import { resolveUpload } from '../uploads'
import { errorMessage, sanitizePath } from '../util'
import { json, readJsonBody } from './http'

export interface MiscRouteDeps {
  readHistory: (
    slug: string,
    sessionId: string,
    opts?: { limit?: number; before?: number },
  ) => HistoryResponse | Promise<HistoryResponse>
  runHandoff: typeof runHandoff
  getBackendsStatus: typeof getBackendsStatus
}

export const defaultMiscRouteDeps: MiscRouteDeps = {
  readHistory: (slug, sessionId, opts) =>
    backendPort('claude').readHistory(sessionId, { slug, before: opts?.before, limit: opts?.limit }),
  runHandoff,
  getBackendsStatus,
}

export async function handleMiscRoutes(
  req: Request,
  url: URL,
  deps: MiscRouteDeps = defaultMiscRouteDeps,
): Promise<Response | undefined> {
  if (url.pathname === '/api/fs/list' && req.method === 'GET') {
    // searchParams.get 已完成 URL 解码，禁止再 decodeURIComponent（含 % 的路径会被二次解码破坏）
    const target = url.searchParams.get('path') ?? ''
    try {
      return json(listDirectories(target))
    } catch (e) {
      if (e instanceof FsBrowseError) return json({ error: e.message }, { status: e.status })
      return json({ error: errorMessage(e) }, { status: 500 })
    }
  }
  if (url.pathname === '/api/handoff' && req.method === 'POST') {
    const body = await readJsonBody<{ fromKey?: string; toBackend?: string; detail?: HandoffDetail }>(req)
    if (!body.fromKey) return json({ error: '缺少 fromKey' }, { status: 400 })
    if (body.toBackend !== 'claude' && body.toBackend !== 'codex') {
      return json({ error: 'toBackend 必须是 claude 或 codex' }, { status: 400 })
    }
    const detail: HandoffDetail =
      body.detail === 'brief' || body.detail === 'detailed' ? body.detail : 'standard'
    const error = deps.runHandoff(body.fromKey, body.toBackend, detail)
    if (error) return json({ error }, { status: 400 })
    return json({ ok: true })
  }
  // 原生壳（Capacitor）通知按钮的一键审批：Bearer 令牌鉴权（走通用 auth 中间件），
  // 与能力 URL 的 /api/approval-action 互为兄弟路径，共用 resolveApprovalRest 核。
  // 红线不变：审批规则引擎不经过任何 REST 路径，一键审批永远是人触发。
  if (url.pathname === '/api/approvals/resolve' && req.method === 'POST') {
    const body = await readJsonBody<{ key?: string; requestId?: string; decision?: string }>(req)
    if (!body.key || !body.requestId) return json({ error: 'key 与 requestId 必填' }, { status: 400 })
    const r = resolveApprovalRest(body.key, body.requestId, body.decision ?? '', '用户在原生壳通知上拒绝了该操作')
    if (!r.ok) return json({ error: r.error }, { status: r.status })
    log.info(`[app] 原生壳通知审批 ${body.decision}：${body.key} · ${r.toolName}`)
    return json({ ok: true })
  }
  // 客户端遥测：原生壳把关键里程碑（权限状态/插件调用成败/异常）上报到服务端日志——
  // 设备侧静默死无法本地排查时的唯一事实来源（方向二实机调试产出）
  if (url.pathname === '/api/client-log' && req.method === 'POST') {
    const body = await readJsonBody<{ tag?: string; msg?: string }>(req)
    const tag = String(body.tag ?? '').slice(0, 40)
    const msg = String(body.msg ?? '').slice(0, 300)
    if (tag) log.info(`[client:${tag}] ${msg}`)
    return json({ ok: true })
  }
  if (url.pathname === '/api/lineage' && req.method === 'GET') {
    const key = url.searchParams.get('key') ?? ''
    const records = lineageFor(key)
    // 为链上每个 key 附带导航所需的节点元数据（前端接力链渲染用）
    const nodes: Record<string, LineageNode> = {}
    for (const r of records) {
      for (const k of [r.fromKey, r.toKey, r.fromResolvedKey, r.toResolvedKey]) {
        if (!k || nodes[k]) continue
        const d = describeKey(k)
        if (d?.kind === 'existing') {
          nodes[k] = { key: k, backend: d.backend, slug: d.slug ?? 'codex', sessionId: d.sessionId ?? '', cwd: r.cwd }
        } else if (d?.kind === 'new') {
          nodes[k] = {
            key: k,
            backend: d.backend,
            slug: d.backend === 'codex' ? 'codex' : sanitizePath(d.cwd ?? ''),
            sessionId: 'new',
            cwd: r.cwd,
          }
        } else if (d?.kind === 'branch') {
          // 懒分叉源（分叉后从未 spawn 或被回收，fromResolvedKey 缺省时记录里仍是 b| key）：
          // 缺节点会让前端接力链按钮 disabled（死按钮）；sessionId 内嵌的是分叉源 id
          nodes[k] = {
            key: k,
            backend: 'claude',
            slug: sanitizePath(d.cwd ?? ''),
            sessionId: d.sessionId ?? '',
            cwd: r.cwd,
          }
        }
      }
    }
    const res: LineageResponse = { records, nodes }
    return json(res)
  }
  // 上传图片：仅 ~/.anyplane/uploads/ 内的 hash 命名文件（resolveUpload 边界校验）
  const uploadMatch = url.pathname.match(/^\/api\/uploads\/([^/]+)$/)
  if (uploadMatch && req.method === 'GET') {
    const path = resolveUpload(uploadMatch[1])
    if (!path) return json({ error: 'not found' }, { status: 404 })
    const ext = path.split('.').pop() ?? ''
    const mime =
      ({ jpg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp' })[ext] ??
      'application/octet-stream'
    return new Response(Bun.file(path), {
      headers: { 'content-type': mime, 'cache-control': 'public, max-age=31536000, immutable' },
    })
  }
  const histMatch = url.pathname.match(/^\/api\/history\/([^/]+)\/([^/]+)$/)
  if (histMatch && req.method === 'GET') {
    const [, slug, sessionId] = histMatch
    // fileBytes = 本次实际读取的字节数，前端拿它作为 tailer 的起始偏移；
    // ?before=<行号> 翻更早的页（响应 nextBefore 续传），?limit= 覆盖默认 300
    //（上限 10000：replay_gap 保载重载按已加载数+余量拉取，长会话需要突破首窗 300）
    const num = (k: string, allowZero = false) => {
      const v = url.searchParams.get(k)
      if (v == null) return undefined
      const n = Number(v)
      // before 是行号游标，0 合法：最老可入历史消息在文件第 0 行时 nextBefore=0，
      // 吞掉它会让前端按无 before 处理拿到最新一页，翻页死循环重复 prepend。
      // limit 不允许 0（slice(-0) 会退化成全量），保持 n > 0。
      return Number.isFinite(n) && (allowZero ? n >= 0 : n > 0) ? Math.floor(n) : undefined
    }
    const limit = num('limit')
    return json(
      await deps.readHistory(slug, sessionId, {
        before: num('before', true),
        limit: limit == null ? undefined : Math.min(limit, 10_000),
      }),
    )
  }
  // codex 历史：thread/read includeTurns（只读），无 tailer 偏移概念
  const codexHistMatch = url.pathname.match(/^\/api\/codex\/history\/([^/]+)$/)
  if (codexHistMatch && req.method === 'GET') {
    try {
      return json(await backendPort('codex').readHistory(codexHistMatch[1]))
    } catch (e) {
      return json({ error: errorMessage(e) }, { status: 500 })
    }
  }
  // codex 模型目录（model/list）：经注册表取适配器（routes 不 import codexRuntime——依赖红线③）
  if (url.pathname === '/api/codex/models' && req.method === 'GET') {
    try {
      const models = await backendPort('codex').listModels?.()
      return json({ models: models ?? [] })
    } catch (e) {
      return json({ error: errorMessage(e) }, { status: 500 })
    }
  }
  if (url.pathname === '/api/config' && req.method === 'GET') {
    const res: ServerConfigInfo = {
      permissionPolicy: config.permissionPolicy,
      permissionModes: ['default', 'acceptEdits', 'auto', 'plan', 'bypassPermissions'],
      effortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
      models: ['haiku', 'sonnet', 'opus', 'fable'],
      authRequired: !!config.authToken,
    }
    return json(res)
  }
  // 各档实际配置的模型名（StatusPill 透传显示；每次调用实时读盘，配置改动即见）
  if (url.pathname === '/api/claude/model-names' && req.method === 'GET') {
    return json({
      models: backendPort('claude').listTierModelNames?.(url.searchParams.get('cwd') ?? undefined) ?? {},
    })
  }
  // 双后端登录状态（列表页「该去登录哪个」指引；60s 服务端缓存，探针成本不随轮询放大）
  if (url.pathname === '/api/backends/status' && req.method === 'GET') {
    try {
      return json(await deps.getBackendsStatus())
    } catch (e) {
      return json({ error: errorMessage(e) }, { status: 500 })
    }
  }
  return undefined
}
