// API 类型与 fetch 封装

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
  kind: 'text' | 'thinking' | 'tool_use' | 'tool_result'
  text?: string
  name?: string
  id?: string
  input?: unknown
  isError?: boolean
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
  const r = await fetch('/api/sessions')
  return r.json()
}

export interface HistoryResponse {
  messages: HistoryMessage[]
  /** 服务端本次实际读取的 transcript 字节数，作为 tail_subscribe 的起始偏移 */
  fileBytes: number
}

export async function fetchHistory(slug: string, sessionId: string): Promise<HistoryResponse> {
  const r = await fetch(`/api/history/${slug}/${sessionId}`)
  return r.json()
}

export async function createSession(cwd: string): Promise<{ key: string; slug: string }> {
  const r = await fetch('/api/sessions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ cwd }),
  })
  return r.json()
}

export async function fetchConfig(): Promise<ServerConfigInfo> {
  const r = await fetch('/api/config')
  return r.json()
}
