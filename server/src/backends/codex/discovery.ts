// Codex 会话发现的读盘路径：扫 rollout 文件头 + session_index.jsonl，不起任何进程。
//
// 镜像的上游读取路径（codex-rs 源码为准，非协议正本——磁盘格式是内部实现，故有漂移跳线）：
// - thread-store/local/list_threads.rs → rollout/list.rs 的 HeadTailSummary 扫描：
//   session_meta 取 id/cwd/timestamp/source；preview 取首个 event_msg 的
//   item_completed(UserMessage)（paginated）或 user_message（legacy）；
//   ThreadGoalUpdated 的 goal.objective 作 preview 兜底。
// - app-server/filters.rs source_kind_matches：['cli','vscode','exec','appServer'] 映射为
//   source ∈ {cli, vscode, exec, mcp}——subagent/custom/internal/unknown/缺失一律排除（与 RPC 一致）。
// - thread-store/local/helpers.rs resolve_thread_names：session_index.jsonl（同名后写胜出）。
//
// 不读 state_N.sqlite：section/project/model 等 sidecar 元数据列表页用不到，
// 且版本号内嵌文件名是明确的内部格式；名字以 session_index.jsonl 为准
// （update_thread_metadata 双写 index+sqlite，index 缺失只影响 sqlite 写入失败时的改名）。

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

/** 与 RPC thread/list 行同形（backend.ts ThreadRow 的子集；updatedAt/createdAt 为秒） */
export interface DiskThreadRow {
  id: string
  preview?: string
  cwd?: string
  updatedAt: number
  createdAt?: number
  name?: string
}

/** 磁盘格式漂移信号：调用方据此回退 RPC 并告警（不允许静默返回空列表） */
export class DiskDiscoveryError extends Error {}

const SESSIONS_DIR = 'sessions'
const ARCHIVED_DIR = 'archived_sessions'
const SESSION_INDEX = 'session_index.jsonl'
const ROLLOUT_PREFIX = 'rollout-'
const ROLLOUT_SUFFIX = '.jsonl'
/** 与上游 source_kind_matches 一致：AnyPlane 的 sourceKinds ['cli','vscode','exec','appServer'] */
const INCLUDED_SOURCES = new Set(['cli', 'vscode', 'exec', 'mcp'])
const HEAD_BYTES = 256 * 1024
const HEAD_LINES = 64
const PREVIEW_MAX = 200
/** 与 RPC 路径 paginate(limitPages=3, limit=100) 等价的列表上限 */
const SCAN_LIMIT = 300

// ---------- 头部解析（纯函数，单测锚点） ----------

/** strip_user_message_prefix 同款：找 "## My request for Codex:" 标记取其后；无标记原样 trim */
function stripUserMessagePrefix(text: string): string {
  const MARKER = '## My request for Codex:'
  const idx = text.indexOf(MARKER)
  return (idx >= 0 ? text.slice(idx + MARKER.length) : text).trim()
}

interface HeadParse {
  id?: string
  cwd?: string
  createdAt?: number
  /** 字符串形态才保留；对象形态（subagent/custom/internal）与缺失统一为 undefined → 排除 */
  source?: string
  preview?: string
  sawSessionMeta: boolean
}

interface UserMessageItem {
  type?: string
  content?: Array<{ type?: string; text?: string }>
}

/** 解析 rollout 头部若干行（文本已在调用方截断）。宽容到行：坏行跳过，不连坐。 */
export function parseRolloutHead(text: string): HeadParse {
  const out: HeadParse = { sawSessionMeta: false }
  const lines = text.split('\n', HEAD_LINES)
  for (const line of lines) {
    if (!line) continue
    let msg: {
      type?: string
      payload?: Record<string, unknown>
    }
    try {
      msg = JSON.parse(line)
    } catch {
      continue
    }
    if (msg.type === 'session_meta') {
      // fork 会把父线程的 session_meta 拷进文件（上游 list.rs:1145 同款注释）——
      // 只有第一条属于本 rollout，后续的父 meta 不得覆盖 id/source
      if (out.sawSessionMeta) continue
      const p = msg.payload ?? {}
      if (typeof p.id === 'string') out.id = p.id
      if (typeof p.cwd === 'string') out.cwd = p.cwd
      const ts = typeof p.timestamp === 'string' ? Date.parse(p.timestamp) : NaN
      if (Number.isFinite(ts)) out.createdAt = ts / 1000
      if (typeof p.source === 'string') out.source = p.source
      out.sawSessionMeta = true
      continue
    }
    if (msg.type !== 'event_msg' || out.preview) continue
    const p = msg.payload ?? {}
    // paginated：item_completed(UserMessage)；legacy：user_message
    if (p.type === 'item_completed') {
      const item = p.item as UserMessageItem | undefined
      if (item?.type === 'UserMessage' && Array.isArray(item.content)) {
        const text = stripUserMessagePrefix(item.content.map((c) => c?.text ?? '').join(''))
        if (text) out.preview = text.slice(0, PREVIEW_MAX)
      }
    } else if (p.type === 'user_message' && typeof p.message === 'string') {
      const text = stripUserMessagePrefix(p.message)
      if (text) out.preview = text.slice(0, PREVIEW_MAX)
    } else if (p.type === 'thread_goal_updated') {
      const objective = (p.goal as { objective?: unknown } | undefined)?.objective
      if (typeof objective === 'string' && objective.trim()) out.preview = objective.trim().slice(0, PREVIEW_MAX)
    }
  }
  return out
}

/** session_index.jsonl：{id, thread_name} 同名后写胜出 */
export function parseSessionIndex(text: string): Map<string, string> {
  const names = new Map<string, string>()
  for (const line of text.split('\n')) {
    if (!line) continue
    try {
      const j = JSON.parse(line) as { id?: unknown; thread_name?: unknown }
      if (typeof j.id === 'string' && typeof j.thread_name === 'string') names.set(j.id, j.thread_name)
    } catch {
      continue
    }
  }
  return names
}

// ---------- 文件扫描（meta 缓存：mtime+size 不变不重读） ----------

interface CacheEntry {
  mtimeMs: number
  size: number
  /** null = 已解析但排除（subagent/无 source 等）——不为它每 5s 重读 */
  row: DiskThreadRow | null
  /** 是否成功见到 session_meta（漂移跳线用；被排除的行也算见过） */
  sawSessionMeta: boolean
}

const fileCache = new Map<string, CacheEntry>()
let indexCache: { mtimeMs: number; size: number; names: Map<string, string> } | undefined

function loadNames(home: string): Map<string, string> {
  const path = join(home, SESSION_INDEX)
  try {
    const st = statSync(path)
    if (indexCache && indexCache.mtimeMs === st.mtimeMs && indexCache.size === st.size) return indexCache.names
    const names = parseSessionIndex(readFileSync(path, 'utf8'))
    indexCache = { mtimeMs: st.mtimeMs, size: st.size, names }
    return names
  } catch {
    return new Map()
  }
}

/** 递归收集 rollout-*.jsonl（sessions/YYYY/MM/DD 四层，手写 walk 避免依赖 readdir recursive 细节） */
function collectRolloutFiles(root: string): { files: string[]; dirHasEntries: boolean } {
  const files: string[] = []
  let dirHasEntries = false
  const walk = (dir: string, depth: number): void => {
    if (depth > 4) return
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    if (entries.length > 0) dirHasEntries = true
    for (const e of entries) {
      const p = join(dir, e.name)
      if (e.isDirectory()) walk(p, depth + 1)
      else if (e.isFile() && e.name.startsWith(ROLLOUT_PREFIX) && e.name.endsWith(ROLLOUT_SUFFIX)) files.push(p)
    }
  }
  walk(root, 0)
  return { files, dirHasEntries }
}

async function rowFromFile(path: string, names: Map<string, string>): Promise<CacheEntry> {
  const st = statSync(path)
  const hit = fileCache.get(path)
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) {
    // 名字可能后改（session_index 单独演进）：命中时只刷新 name 字段
    if (hit.row) {
      const name = names.get(hit.row.id)
      if (name !== hit.row.name) hit.row = { ...hit.row, name }
    }
    return hit
  }
  let entry: CacheEntry
  try {
    // 只读头部：rollout 可达数百 MB，session_meta 与首条用户消息都在头部
    const head = await Bun.file(path).slice(0, HEAD_BYTES).text()
    const parsed = parseRolloutHead(head)
    if (!parsed.sawSessionMeta || !parsed.id || !INCLUDED_SOURCES.has(parsed.source ?? '')) {
      entry = { mtimeMs: st.mtimeMs, size: st.size, row: null, sawSessionMeta: parsed.sawSessionMeta }
    } else {
      entry = {
        mtimeMs: st.mtimeMs,
        size: st.size,
        sawSessionMeta: true,
        row: {
          id: parsed.id,
          cwd: parsed.cwd,
          createdAt: parsed.createdAt,
          updatedAt: st.mtimeMs / 1000,
          preview: parsed.preview,
          name: names.get(parsed.id),
        },
      }
    }
  } catch {
    entry = { mtimeMs: st.mtimeMs, size: st.size, row: null, sawSessionMeta: false }
  }
  fileCache.set(path, entry)
  return entry
}

/**
 * 读盘列出 codex 线程（updatedAt 降序，每个 thread id 一行，最多 limit 条）。
 * 漂移跳线：目录非空却找不到任何 rollout 文件，或找到文件但全部解析不出 session_meta，
 * 抛 DiskDiscoveryError——格式变了宁可回退 RPC 也不许静默给空列表。
 * 去重：resume 续跑会同 id 多文件（RPC thread/list 一线程一行），取最新 mtime 行，
 * preview/createdAt 从更旧的同 id 行回填。
 */
export async function listThreadsFromDisk(
  home: string,
  opts: { archived?: boolean; limit?: number } = {},
): Promise<DiskThreadRow[]> {
  const root = join(home, opts.archived ? ARCHIVED_DIR : SESSIONS_DIR)
  const { files, dirHasEntries } = collectRolloutFiles(root)
  if (files.length === 0) {
    if (dirHasEntries) {
      // 目录有内容却没有可识别文件（如上游改压缩格式 .jsonl.zst）——按漂移处理
      throw new DiskDiscoveryError(`${root} 存在内容但无 ${ROLLOUT_PREFIX}*${ROLLOUT_SUFFIX} 文件`)
    }
    return []
  }
  const names = loadNames(home)
  const rows: DiskThreadRow[] = []
  let sawAnySessionMeta = false
  for (const f of files) {
    const entry = await rowFromFile(f, names)
    if (entry.sawSessionMeta) sawAnySessionMeta = true
    if (entry.row) rows.push(entry.row)
  }
  if (!sawAnySessionMeta) {
    throw new DiskDiscoveryError(`${files.length} 个 rollout 文件无一含 session_meta（格式漂移？）`)
  }
  rows.sort((a, b) => b.updatedAt - a.updatedAt)
  // 同 id 去重：降序下首个出现即最新行；更旧的行只回填 preview/createdAt
  const byId = new Map<string, DiskThreadRow>()
  for (const r of rows) {
    const existing = byId.get(r.id)
    if (!existing) {
      byId.set(r.id, { ...r })
      continue
    }
    if (!existing.preview && r.preview) existing.preview = r.preview
    if (r.createdAt && (!existing.createdAt || r.createdAt < existing.createdAt)) existing.createdAt = r.createdAt
  }
  return [...byId.values()].slice(0, opts.limit ?? SCAN_LIMIT)
}

/** 测试用：清空文件头与索引缓存 */
export function resetDiskDiscoveryCache(): void {
  fileCache.clear()
  indexCache = undefined
}
