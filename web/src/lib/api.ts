// API fetch 封装与下游辅助函数。
// 契约类型（SessionInfo/HistoryResponse/BackendsStatus/LineageResponse 等）的
// 单一正本在 @anyplane/protocol——本文件只放运行时函数，不再声明契约形状。

import type {
  ArchivedEntry,
  BackendsStatus,
  CodexModelInfo,
  CreateSessionResponse,
  DirListResult,
  HistoryResponse,
  LineageResponse,
  ServerConfigInfo,
  SessionInfo,
  TierModelName,
} from '@anyplane/protocol'
import { authHeaders, notifyAuthRequired } from './auth'

/** 401 时抛出；App 层会显示令牌输入页，调用方静默忽略即可 */
export class AuthRequiredError extends Error {}

/** 带认证头的 fetch：自动拼 authHeaders()，401 时通知 App 层弹令牌页并抛 AuthRequiredError */
export async function apiFetch(input: string, init?: RequestInit): Promise<Response> {
  const r = await fetch(input, {
    ...init,
    headers: { ...authHeaders(), ...(init?.headers ?? {}) },
  })
  if (r.status === 401) {
    notifyAuthRequired()
    throw new AuthRequiredError('unauthorized')
  }
  return r
}

/** 非 2xx 应答 → Error：优先服务端的 {error} 字段（空串视同缺失），兜底 HTTP 状态码 */
export async function apiError(r: Response): Promise<Error> {
  const body = (await r.json().catch(() => null)) as { error?: string } | null
  return new Error(body?.error || `HTTP ${r.status}`)
}

/** POST JSON 小封装：统一 method/headers/序列化（错误检查由调用方按需补） */
export async function postJson(path: string, body: unknown): Promise<Response> {
  return apiFetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

/** unknown 错误 → 单行文案（catch 后展示用；与服务端 util.errorMessage 同规则） */
export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/**
 * 构造本地导航用的会话条目（fork / handoff / moved / 新建共用缺省值）。
 * 刚导航过去的会话尚无权威状态，占位字段随后由 WS status 覆盖。
 */
export function makeSessionInfo(
  p: Pick<SessionInfo, 'key' | 'slug' | 'sessionId' | 'backend'> & Partial<SessionInfo>,
): SessionInfo {
  return {
    mtime: Date.now(),
    sizeBytes: 0,
    status: 'idle',
    managed: { spawned: false, busy: false, clients: 0 },
    ...p,
  }
}

export async function fetchSessions(): Promise<SessionInfo[]> {
  const r = await apiFetch('/api/sessions')
  return r.json()
}

export async function fetchHistory(
  slug: string,
  sessionId: string,
  opts?: { before?: number; limit?: number },
): Promise<HistoryResponse> {
  const q = new URLSearchParams()
  if (opts?.before != null) q.set('before', String(opts.before))
  if (opts?.limit != null) q.set('limit', String(opts.limit))
  const qs = q.size > 0 ? `?${q}` : ''
  const r = await apiFetch(`/api/history/${slug}/${sessionId}${qs}`)
  return r.json()
}

/** codex 线程历史（thread/read includeTurns）；fileBytes 恒 0（无 tailer） */
export async function fetchCodexHistory(threadId: string): Promise<HistoryResponse> {
  const r = await apiFetch(`/api/codex/history/${threadId}`)
  return r.json()
}

export async function createSession(
  cwd: string,
  backend?: 'claude' | 'codex',
): Promise<CreateSessionResponse> {
  const r = await postJson('/api/sessions', { cwd, backend })
  return r.json()
}

/** codex model/list 目录 */
export async function fetchCodexModels(): Promise<{ models: CodexModelInfo[] }> {
  const r = await apiFetch('/api/codex/models')
  return r.json()
}

export async function fetchLineage(key: string): Promise<LineageResponse> {
  const r = await apiFetch(`/api/lineage?key=${encodeURIComponent(key)}`)
  return r.json()
}

/** 改名：claude 离线会话追加 custom-title；codex 走 thread/name/set */
export async function renameSession(key: string, title: string): Promise<void> {
  const r = await postJson('/api/sessions/rename', { key, title })
  if (!r.ok) throw await apiError(r)
}

/** 归档（回收站语义，无物理删除）：claude 移入 ~/.anyplane/trash；codex 走官方 thread/archive */
export async function archiveSession(key: string): Promise<void> {
  const r = await postJson('/api/sessions/archive', { key })
  if (!r.ok) throw await apiError(r)
}

export async function restoreSession(key: string): Promise<void> {
  const r = await postJson('/api/sessions/restore', { key })
  if (!r.ok) throw await apiError(r)
}

export async function fetchArchived(): Promise<{ entries: ArchivedEntry[] }> {
  const r = await apiFetch('/api/sessions/archived')
  return r.json()
}

export async function fetchConfig(): Promise<ServerConfigInfo> {
  const r = await apiFetch('/api/config')
  return r.json()
}

/** 双后端登录状态（30s 服务端缓存；探测失败整体 500，单侧失败落在该侧 state=unknown） */
export async function fetchBackendsStatus(): Promise<BackendsStatus> {
  const r = await apiFetch('/api/backends/status')
  if (!r.ok) throw await apiError(r)
  return r.json()
}

/** 模型值 → {显示名, tooltip}：tier 直查（haiku/sonnet/…）→ 按模型 ID 反查（init 报的是解析后 ID，
 *  如 k3[1m]——大小写不敏感，设置里的 ID 写法可能不同）→ 未配置原样显示（降级）。
 *  只需显示名的场景取 .label；StatusPill/DetailDrawer/Composer 共用同一口径，避免同模型多处显示不一致。 */
export function resolveModel(
  modelNames: Record<string, TierModelName> | null | undefined,
  v: string,
): { label: string; title?: string } {
  const names = modelNames ?? {}
  const direct = names[v]
  if (direct) return { label: direct.name, title: direct.id && direct.id !== direct.name ? direct.id : undefined }
  const rev = Object.values(names).find((t) => t.id && t.id.toLowerCase() === v.toLowerCase())
  if (rev) return { label: rev.name, title: v }
  return { label: v }
}

/** 各档实际配置的模型名（haiku/sonnet/opus/fable → 网关真实名）；未配置的档缺席，前端降级 tier 名 */
export async function fetchClaudeModelNames(cwd?: string): Promise<Record<string, TierModelName>> {
  const r = await apiFetch(`/api/claude/model-names${cwd ? `?cwd=${encodeURIComponent(cwd)}` : ''}`)
  return ((await r.json()) as { models?: Record<string, TierModelName> }).models ?? {}
}

/** 发起接力：进度经源会话 WS 推送（handoff_pending/done/error） */
export async function startHandoff(
  fromKey: string,
  toBackend: 'claude' | 'codex',
  detail: 'brief' | 'standard' | 'detailed' = 'standard',
): Promise<void> {
  const r = await postJson('/api/handoff', { fromKey, toBackend, detail })
  if (!r.ok) throw await apiError(r)
}

export async function fetchDirList(path: string): Promise<DirListResult> {
  const r = await apiFetch(`/api/fs/list?path=${encodeURIComponent(path)}`)
  if (!r.ok) throw await apiError(r)
  return r.json()
}
