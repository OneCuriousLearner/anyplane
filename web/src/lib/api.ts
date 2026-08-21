// API 类型与 fetch 封装

import { authHeaders, notifyAuthRequired } from './auth'

/** 401 时抛出；App 层会显示令牌输入页，调用方静默忽略即可 */
export class AuthRequiredError extends Error {}

async function apiFetch(input: string, init?: RequestInit): Promise<Response> {
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

export interface SessionInfo {
  sessionId: string
  cwd?: string
  slug: string
  title?: string
  lastPrompt?: string
  mtime: number
  sizeBytes: number
  status: 'busy' | 'idle' | 'waiting' | 'offline'
  live?: { pid: number; startedAt?: string | number; kind?: string }
  /** 会话后端：claude（stream-json 子进程）| codex（app-server） */
  backend?: 'claude' | 'codex'
  /** 项目目录的 git 分支（非仓库为空） */
  gitBranch?: string
  key: string
  managed: {
    spawned: boolean
    busy: boolean
    waiting?: boolean
    sessionState?: 'idle' | 'running' | 'requires_action'
    sessionId?: string
    clients: number
    model?: string
    permissionMode?: string
    effort?: string
  }
}

export interface HistoryBlock {
  kind: 'text' | 'thinking' | 'tool_use' | 'tool_result' | 'image'
  text?: string
  name?: string
  id?: string
  input?: unknown
  isError?: boolean
  /** image 块：/api/uploads/<hash>.<ext> */
  src?: string
}

export interface HistoryMessage {
  uuid?: string
  role: 'user' | 'assistant' | 'system'
  subtype?: string
  blocks: HistoryBlock[]
  compactMeta?: { trigger?: string; preTokens?: number; postTokens?: number }
  timestamp?: string
  isMeta?: boolean
  rewindable?: boolean
}

export interface ServerConfigInfo {
  permissionPolicy: 'ask' | 'bypass'
  permissionModes: string[]
  effortLevels: string[]
  models: string[]
}

export async function fetchSessions(): Promise<SessionInfo[]> {
  const r = await apiFetch('/api/sessions')
  return r.json()
}

export interface HistoryResponse {
  messages: HistoryMessage[]
  /** 服务端本次实际读取的 transcript 字节数，作为 tail_subscribe 的起始偏移 */
  fileBytes: number
}

export async function fetchHistory(slug: string, sessionId: string): Promise<HistoryResponse> {
  const r = await apiFetch(`/api/history/${slug}/${sessionId}`)
  return r.json()
}

/** codex 线程历史（thread/read includeTurns）；fileBytes 恒 0（无 tailer） */
export async function fetchCodexHistory(threadId: string): Promise<HistoryResponse> {
  const r = await apiFetch(`/api/codex/history/${threadId}`)
  return r.json()
}

export async function createSession(cwd: string, backend?: 'claude' | 'codex'): Promise<{ key: string; slug: string }> {
  const r = await apiFetch('/api/sessions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ cwd, backend }),
  })
  return r.json()
}

export interface CodexModelInfo {
  id: string
  label: string
  description: string
  efforts: Array<{ value: string; description: string }>
  defaultEffort?: string
  isDefault: boolean
}

/** codex model/list 目录 */
export async function fetchCodexModels(): Promise<{ models: CodexModelInfo[] }> {
  const r = await apiFetch('/api/codex/models')
  return r.json()
}

/** 接力血缘记录 */
export interface LineageRecord {
  id: string
  at: string
  fromKey: string
  toKey: string
  fromResolvedKey?: string
  toResolvedKey?: string
  fromBackend: 'claude' | 'codex'
  toBackend: 'claude' | 'codex'
  cwd: string
  detail: 'brief' | 'standard' | 'detailed'
  brief: string
  briefUsage?: Record<string, number>
}

export interface LineageResponse {
  records: LineageRecord[]
  nodes: Record<string, SessionInfo>
}

export async function fetchLineage(key: string): Promise<LineageResponse> {
  const r = await apiFetch(`/api/lineage?key=${encodeURIComponent(key)}`)
  return r.json()
}

/** 改名：claude 离线会话追加 custom-title；codex 走 thread/name/set */
export async function renameSession(key: string, title: string): Promise<void> {
  const r = await apiFetch('/api/sessions/rename', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ key, title }),
  })
  if (!r.ok) {
    const body = (await r.json().catch(() => null)) as { error?: string } | null
    throw new Error(body?.error ?? `HTTP ${r.status}`)
  }
}

/** 归档（回收站语义，无物理删除）：claude 移入 ~/.cc-remote/trash；codex 走官方 thread/archive */
export async function archiveSession(key: string): Promise<void> {
  const r = await apiFetch('/api/sessions/archive', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ key }),
  })
  if (!r.ok) {
    const body = (await r.json().catch(() => null)) as { error?: string } | null
    throw new Error(body?.error ?? `HTTP ${r.status}`)
  }
}

export async function restoreSession(key: string): Promise<void> {
  const r = await apiFetch('/api/sessions/restore', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ key }),
  })
  if (!r.ok) {
    const body = (await r.json().catch(() => null)) as { error?: string } | null
    throw new Error(body?.error ?? `HTTP ${r.status}`)
  }
}

export interface ArchivedEntry {
  key: string
  sessionId: string
  slug: string
  backend: 'claude' | 'codex'
  title?: string
  lastPrompt?: string
  cwd?: string
  mtime?: number
  trashedAt?: string
  sizeBytes?: number
}

export async function fetchArchived(): Promise<{ entries: ArchivedEntry[] }> {
  const r = await apiFetch('/api/sessions/archived')
  return r.json()
}

export async function fetchConfig(): Promise<ServerConfigInfo> {
  const r = await apiFetch('/api/config')
  return r.json()
}

/** 发起接力：进度经源会话 WS 推送（handoff_pending/done/error） */
export async function startHandoff(
  fromKey: string,
  toBackend: 'claude' | 'codex',
  detail: 'brief' | 'standard' | 'detailed' = 'standard',
): Promise<void> {
  const r = await apiFetch('/api/handoff', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ fromKey, toBackend, detail }),
  })
  if (!r.ok) {
    const body = (await r.json().catch(() => null)) as { error?: string } | null
    throw new Error(body?.error ?? `HTTP ${r.status}`)
  }
}

export interface DirEntry {
  name: string
  path: string
}

export interface DirListResult {
  /** 当前目录；根集合视图为 '' */
  path: string
  parent: string | null
  entries: DirEntry[]
  home: string
}

export async function fetchDirList(path: string): Promise<DirListResult> {
  const r = await apiFetch(`/api/fs/list?path=${encodeURIComponent(path)}`)
  if (!r.ok) {
    const body = (await r.json().catch(() => null)) as { error?: string } | null
    throw new Error(body?.error ?? `HTTP ${r.status}`)
  }
  return r.json()
}
