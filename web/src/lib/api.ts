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
  managed: { spawned: boolean; busy: boolean; sessionId?: string; clients: number }
}

export interface HistoryMessage {
  uuid?: string
  role: 'user' | 'assistant' | 'system'
  text: string
  toolUses?: { name: string; id?: string }[]
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

export async function fetchHistory(slug: string, sessionId: string): Promise<HistoryMessage[]> {
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
