// 其余 REST 路由：fs/list、handoff、lineage、uploads、history（claude/codex）、
// codex/models、config、claude/model-names。

import { readHistory, sanitizePath } from '../backends/claude/discovery'
import { resolveTierModelNames } from '../backends/claude/modelNames'
import { readHistory as readCodexHistory } from '../backends/codex/backend'
import { codexRuntime } from '../backends/codex/runtime'
import { describeKey } from '../backends/port'
import { config } from '../config'
import { FsBrowseError, listDirectories } from '../fsbrowse'
import { lineageFor, type HandoffDetail } from '../handoff'
import { runHandoff } from '../hub/handoff'
import { resolveUpload } from '../uploads'
import { errorMessage } from '../util'
import { json, readJsonBody } from './http'

export async function handleMiscRoutes(req: Request, url: URL): Promise<Response | undefined> {
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
    const error = runHandoff(body.fromKey, body.toBackend, detail)
    if (error) return json({ error }, { status: 400 })
    return json({ ok: true })
  }
  if (url.pathname === '/api/lineage' && req.method === 'GET') {
    const key = url.searchParams.get('key') ?? ''
    const records = lineageFor(key)
    // 为链上每个 key 附带导航所需的节点元数据（前端接力链渲染用）
    const nodes: Record<string, Record<string, unknown>> = {}
    for (const r of records) {
      for (const k of [r.fromKey, r.toKey, r.fromResolvedKey, r.toResolvedKey]) {
        if (!k || nodes[k]) continue
        const d = describeKey(k)
        if (d?.kind === 'existing') {
          nodes[k] = { key: k, backend: d.backend, slug: d.slug ?? 'codex', sessionId: d.sessionId, cwd: r.cwd }
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
            sessionId: d.sessionId,
            cwd: r.cwd,
          }
        }
      }
    }
    return json({ records, nodes })
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
      readHistory(slug, sessionId, {
        before: num('before', true),
        limit: limit == null ? undefined : Math.min(limit, 10_000),
      }),
    )
  }
  // codex 历史：thread/read includeTurns（只读），无 tailer 偏移概念
  const codexHistMatch = url.pathname.match(/^\/api\/codex\/history\/([^/]+)$/)
  if (codexHistMatch && req.method === 'GET') {
    try {
      const messages = await readCodexHistory(codexHistMatch[1])
      return json({ messages, fileBytes: 0 })
    } catch (e) {
      return json({ error: errorMessage(e) }, { status: 500 })
    }
  }
  // codex 模型目录（model/list）：模型 id/显示名/effort 列表/默认 effort
  if (url.pathname === '/api/codex/models' && req.method === 'GET') {
    try {
      const models = await codexRuntime.listModels()
      return json({ models })
    } catch (e) {
      return json({ error: errorMessage(e) }, { status: 500 })
    }
  }
  if (url.pathname === '/api/config' && req.method === 'GET') {
    return json({
      permissionPolicy: config.permissionPolicy,
      permissionModes: ['default', 'acceptEdits', 'auto', 'plan', 'bypassPermissions'],
      effortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
      models: ['haiku', 'sonnet', 'opus', 'fable'],
      authRequired: !!config.authToken,
    })
  }
  // 各档实际配置的模型名（StatusPill 透传显示；每次调用实时读盘，配置改动即见）
  if (url.pathname === '/api/claude/model-names' && req.method === 'GET') {
    return json({ models: resolveTierModelNames(url.searchParams.get('cwd') ?? undefined) })
  }
  return undefined
}
