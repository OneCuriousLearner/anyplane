// REST 管理面契约：/api/* 端点的请求/响应形状（WS 数据面见 events.ts / inbox.ts / state.ts）。

import type { SessionState } from './state'
import type { BackendName } from './types'

/** GET /api/sessions 的聚合行（claude discovery 与 codex thread/list 归一后的列表项） */
export interface SessionInfo {
  /** sessionId / threadId */
  sessionId: string
  cwd?: string
  slug: string
  title?: string
  lastPrompt?: string
  mtime: number
  sizeBytes: number
  status: 'busy' | 'idle' | 'waiting' | 'offline'
  live?: { pid: number; startedAt?: string | number; kind?: string }
  backend: BackendName
  /** 项目目录的 git 分支（非仓库为空） */
  gitBranch?: string
  key: string
  /** 会话实时状态（statusOf 全集；离线会话为派生缺省值） */
  managed: SessionState
}

/** POST /api/sessions 响应 */
export interface CreateSessionResponse {
  key: string
  slug: string
  backend: BackendName
}

/** GET /api/config 响应 */
export interface ServerConfigInfo {
  permissionPolicy: 'ask' | 'bypass'
  permissionModes: string[]
  effortLevels: string[]
  models: string[]
  /** 服务端配置了 authToken（前端据此走令牌页而非静默 401 循环） */
  authRequired?: boolean
}

/** 宏观登录态：列表页按此渲染徽标与指引 */
export type BackendLoginState =
  | 'subscription' // claude.ai 订阅 / codex ChatGPT
  | 'api-key' // 显式 API key
  | 'token' // OAuth token（env / setup-token，auth status 不再细分来源）
  | 'third-party' // Bedrock / Vertex / Foundry
  | 'custom-provider' // codex 自定义 model_provider（API-key 组织用户的典型形态）
  | 'not-logged-in'
  | 'not-installed'
  | 'unknown' // 探测失败（超时/输出不可解析），不等于未登录

export interface BackendStatus {
  state: BackendLoginState
  /** 补充信息：codex ChatGPT 的 email/planType、third-party 的 provider 名 */
  detail?: string
  /** 探测失败时的错误摘要（state=unknown） */
  error?: string
}

/** GET /api/backends/status 响应（30s 服务端缓存；探测失败整体 500，单侧失败落在该侧 state=unknown） */
export interface BackendsStatus {
  checkedAt: number
  claude: BackendStatus
  codex: BackendStatus
}

// ---------- 接力血缘（/api/lineage） ----------

/** 接力血缘记录（持久化于 ~/.anyplane/lineage.json） */
export interface LineageRecord {
  id: string
  at: string
  fromKey: string
  toKey: string
  /** 解析后的真实会话 key（s|slug|sid / x|threadId）；目标 sessionId 就绪后回填 */
  fromResolvedKey?: string
  toResolvedKey?: string
  fromBackend: BackendName
  toBackend: BackendName
  cwd: string
  detail: 'brief' | 'standard' | 'detailed'
  brief: string
  briefUsage?: Record<string, number>
}

/** 接力链导航节点：渲染链上每个 key 所需的最小会话身份（导航到后再由 WS status 补全实时态）。
 *  不是完整 SessionInfo——服务端只按 key 形状派生，不保证该会话在列表里 */
export interface LineageNode {
  key: string
  backend: BackendName
  slug: string
  sessionId: string
  cwd?: string
}

/** GET /api/lineage 响应 */
export interface LineageResponse {
  records: LineageRecord[]
  nodes: Record<string, LineageNode>
}

/** codex model/list 目录项 */
export interface CodexModelInfo {
  id: string
  label: string
  description: string
  efforts: Array<{ value: string; description: string }>
  defaultEffort?: string
  isDefault: boolean
}

/** 各档实际配置的模型名（haiku/sonnet/opus/fable → 网关真实名）；未配置的档缺席，前端降级 tier 名 */
export interface TierModelName {
  /** 显示名（_MODEL_NAME 优先，缺省回退模型 ID） */
  name: string
  /** 模型 ID（仅当与显示名不同才携带，供 tooltip） */
  id?: string
}

/** 归档/回收站列表行（/api/sessions/archived）：claude=trash（trashedAt/sizeBytes），
 *  codex=archived threads（title/lastPrompt/cwd/mtime）——两后端字段并集，缺省即不渲染 */
export interface ArchivedEntry {
  key: string
  sessionId: string
  slug: string
  backend: BackendName
  title?: string
  lastPrompt?: string
  cwd?: string
  mtime?: number
  trashedAt?: string
  sizeBytes?: number
}

/** GET /api/fs/list 响应（新会话目录选择器） */
export interface DirEntry {
  name: string
  path: string
}

export interface DirListResult {
  /** 当前目录；根集合视图为 '' */
  path: string
  /** 父目录；根集合/盘符根/POSIX `/` 时为 null */
  parent: string | null
  entries: DirEntry[]
  /** 用户主目录，作为快捷入口始终返回 */
  home: string
}
