// Codex 会话发现的读盘路径：扫 rollout 文件头 + session_index.jsonl，不起任何进程。
//
// 镜像的上游读取路径（codex-rs 源码为准，非协议正本——磁盘格式是内部实现，故有漂移跳线）：
// - thread-store/local/list_threads.rs → rollout/list.rs 的 HeadTailSummary 扫描：
//   只认第一条 session_meta（list.rs:1145，fork 会拷入父线程 meta）；
//   preview 取首个 event_msg 的 item_completed(UserMessage)（paginated）/ user_message（legacy）
//   / thread_goal_updated 兜底（event_msg_preview，list.rs:1286）；
//   入列硬性要求 saw_session_meta && preview.is_some()（list.rs:819-820）；
//   用户事件扫描预算 210 行（USER_EVENT_SCAN_LIMIT，list.rs:136）。
// - app-server/filters.rs source_kind_matches：['cli','vscode','exec','appServer'] 映射为
//   source ∈ {cli, vscode, exec, mcp}——subagent/custom/internal/unknown/缺失一律排除（与 RPC 一致）。
// - thread-store/local/helpers.rs resolve_thread_names：session_index.jsonl（同名后写胜出，
//   空名跳过——session_index.rs:146-150）。
//
// 不读 state_N.sqlite：section/project/model 等 sidecar 元数据列表页用不到，
// 且版本号内嵌文件名是明确的内部格式；名字以 session_index.jsonl 为准
// （update_thread_metadata 双写 index+sqlite，index 缺失只影响 sqlite 写入失败时的改名）。

import { readFileSync, readdirSync, statSync, type Dirent, type Stats } from 'node:fs'
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
/** 用户事件扫描预算与上游 USER_EVENT_SCAN_LIMIT 一致（list.rs:136） */
const HEAD_LINES = 210
/** 字节保险丝：单行 environment_context 可达数十 KB，行预算优先、字节兜底截断 */
const HEAD_BYTES = 1024 * 1024
const PREVIEW_MAX = 200
/** 与 RPC 路径 paginate(limitPages=3, limit=100) 等价的列表上限 */
const SCAN_LIMIT = 300
/** 冷启动并行读头并发数 */
const READ_CONCURRENCY = 8

// ---------- 头部解析（纯函数，单测锚点） ----------

/** strip_user_message_prefix 同款：找 "## My request for Codex:" 标记取其后；无标记原样 trim */
function stripUserMessagePrefix(text: string): string {
  const MARKER = '## My request for Codex:'
  const idx = text.indexOf(MARKER)
  return (idx >= 0 ? text.slice(MARKER.length + idx) : text).trim()
}

interface HeadParse {
  id?: string
  cwd?: string
  createdAt?: number
  /** 字符串形态才保留；对象形态（subagent/custom/internal）与缺失统一为 undefined → 排除 */
  source?: string
  preview?: string
  /** 见过带字符串 id 的 session_meta（上游把 id 改名时跳线才有效，见 listThreadsFromDisk） */
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
      if (typeof p.id === 'string') {
        out.id = p.id
        // 只在拿到 id 时才算"见过 meta"：上游把 id 改名时全部文件都解析不出 id，
        // 漂移跳线必须能触发（否则静默空列表）
        out.sawSessionMeta = true
      }
      if (typeof p.cwd === 'string') out.cwd = p.cwd
      const ts = typeof p.timestamp === 'string' ? Date.parse(p.timestamp) : NaN
      if (Number.isFinite(ts)) out.createdAt = ts / 1000
      if (typeof p.source === 'string') out.source = p.source
      continue
    }
    if (msg.type !== 'event_msg' || out.preview) continue
    const p = msg.payload ?? {}
    // paginated：item_completed(UserMessage)；legacy：user_message（变体集与上游 event_msg_preview 对齐）
    if (p.type === 'item_completed') {
      const item = p.item as UserMessageItem | undefined
      if (item?.type === 'UserMessage' && Array.isArray(item.content)) {
        const text = stripUserMessagePrefix(item.content.map((c) => c?.text ?? '').join(''))
        if (text) out.preview = text.slice(0, PREVIEW_MAX)
        else if (item.content.some((c) => c && c.type !== 'text')) out.preview = '[Image]'
      }
    } else if (p.type === 'user_message') {
      const text = typeof p.message === 'string' ? stripUserMessagePrefix(p.message) : ''
      // 上游 user_message_preview 的占位兜底（protocol.rs:2563-2576）
      if (text) out.preview = text.slice(0, PREVIEW_MAX)
      else if (Array.isArray(p.images) && p.images.length > 0) out.preview = '[Image]'
      else if (Array.isArray(p.audio) && p.audio.length > 0) out.preview = '[Audio]'
    } else if (p.type === 'thread_goal_updated') {
      const objective = (p.goal as { objective?: unknown } | undefined)?.objective
      if (typeof objective === 'string' && objective.trim()) out.preview = objective.trim().slice(0, PREVIEW_MAX)
    }
  }
  return out
}

/** session_index.jsonl：{id, thread_name} 同名后写胜出；空名跳过（上游 session_index.rs:146-150 同款） */
export function parseSessionIndex(text: string): Map<string, string> {
  const names = new Map<string, string>()
  for (const line of text.split('\n')) {
    if (!line) continue
    try {
      const j = JSON.parse(line) as { id?: unknown; thread_name?: unknown }
      if (typeof j.id === 'string' && typeof j.thread_name === 'string' && j.thread_name.trim()) {
        names.set(j.id, j.thread_name)
      }
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
  /** null = 已解析但排除（subagent/无 preview 等）——不为它每 5s 重读 */
  row: DiskThreadRow | null
  /** 是否解析出带 id 的 session_meta（漂移跳线用；被排除的行也算见过） */
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

interface CollectResult {
  /** 可识别的 rollout-*.jsonl（含绝对路径与 mtime，已按 mtime 降序） */
  files: Array<{ path: string; mtimeMs: number }>
  /** rollout-* 前缀但后缀不可识别（如 .jsonl.zst 压缩形态）——漂移信号 */
  unrecognizedRolloutFiles: number
}

/** 递归收集 rollout 文件并预取 mtime（早停排序用）。
 *  readdir 错误码区分：任何 ENOENT（新装/扫描竞态）按空处理；已存在目录的 EACCES/EIO 等
 *  抛 DiskDiscoveryError（NFS 抖动/权限故障必须走 RPC 兜底，不能静默空列表）。 */
function collectRolloutFiles(root: string): CollectResult {
  const files: Array<{ path: string; mtimeMs: number }> = []
  let unrecognizedRolloutFiles = 0
  const walk = (dir: string, depth: number): void => {
    if (depth > 4) return
    let entries: Dirent[] | undefined
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code
      if (code === 'ENOENT') return // 根目录不存在（新装）或扫描瞬间被删（竞态）：按空
      throw new DiskDiscoveryError(`无法读取目录 ${dir}: ${code ?? e}`)
    }
    for (const e of entries) {
      const p = join(dir, e.name)
      if (e.isDirectory()) {
        walk(p, depth + 1)
      } else if (e.isFile() && e.name.startsWith(ROLLOUT_PREFIX)) {
        if (!e.name.endsWith(ROLLOUT_SUFFIX)) {
          unrecognizedRolloutFiles++
          continue
        }
        try {
          files.push({ path: p, mtimeMs: statSync(p).mtimeMs })
        } catch {
          // readdir→stat 之间被删/移动（归档移动、压缩切换）：跳过该文件即可，不连坐全表
        }
      }
      // 其余文件（.DS_Store 等垃圾）一律忽略，不构成"目录非空"
    }
  }
  walk(root, 0)
  files.sort((a, b) => b.mtimeMs - a.mtimeMs)
  return { files, unrecognizedRolloutFiles }
}

/** rowFromFile 的三种结局：ok=已解析（含排除项，已缓存）；transient=瞬时读错误（不缓存）；
 *  gone=readdir→stat 竞态文件消失（跳过）。调用方靠它把"读不动"与"不是本格式"分开计数。 */
type RowResult =
  | { kind: 'ok'; entry: CacheEntry }
  | { kind: 'transient' }
  | { kind: 'gone' }

async function rowFromFile(path: string, names: Map<string, string>): Promise<RowResult> {
  const hit = fileCache.get(path)
  let st: Stats | undefined
  try {
    st = statSync(path)
  } catch {
    // 归档移动/压缩删除的竞态：丢缓存并跳过，不中止整轮扫描
    fileCache.delete(path)
    return { kind: 'gone' }
  }
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) {
    // 名字可能后改（session_index 单独演进）：命中时只刷新 name 字段
    if (hit.row) {
      const name = names.get(hit.row.id)
      if (name !== hit.row.name) hit.row = { ...hit.row, name }
    }
    return { kind: 'ok', entry: hit }
  }
  let entry: CacheEntry
  try {
    // 只读头部：rollout 可达数百 MB，session_meta 与首条用户消息都在头部；
    // 按最后一个完整换行截断，防止 UTF-8 多字节落在字节边界被静默吞掉半行
    const raw = await Bun.file(path).slice(0, HEAD_BYTES).text()
    const lastNl = raw.lastIndexOf('\n')
    const parsed = parseRolloutHead(lastNl > 0 ? raw.slice(0, lastNl) : raw)
    // 上游入列硬要求（list.rs:819-820）：saw_session_meta && preview.is_some()
    if (!parsed.sawSessionMeta || !parsed.id || !parsed.preview || !INCLUDED_SOURCES.has(parsed.source ?? '')) {
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
    // 瞬时 IO 错误（EMFILE/EBUSY/杀软锁文件）：不写缓存——
    // 写缓存会把一次抖动固化成"该线程长期消失"
    return { kind: 'transient' }
  }
  fileCache.set(path, entry)
  return { kind: 'ok', entry }
}

/**
 * 读盘列出 codex 线程（updatedAt 降序，每个 thread id 一行，最多 limit 条）。
 * 漂移跳线（抛 DiskDiscoveryError，调用方回退 RPC，绝不静默空列表）：
 *   ① 目录存在且有 rollout-* 文件但后缀全部不可识别（如上游默认开压缩 .jsonl.zst）
 *   ② 找到可识别文件但全部解析不出带 id 的 session_meta
 * 读取瞬时错误与格式漂移分开计数：全部文件都读不动时抛的是"IO 故障"而非"格式漂移"。
 * 去重：resume 续跑会同 id 多文件（RPC thread/list 一线程一行），取最新 mtime 行，
 * preview/createdAt 从更旧的同 id 行回填。
 * 早停：文件已按 mtime 降序，凑满 limit 个唯一 id 即停止读头（上游同策略，list.rs:604-608）。
 */
export async function listThreadsFromDisk(
  home: string,
  opts: { archived?: boolean; limit?: number } = {},
): Promise<DiskThreadRow[]> {
  const limit = opts.limit ?? SCAN_LIMIT
  const root = join(home, opts.archived ? ARCHIVED_DIR : SESSIONS_DIR)
  const { files, unrecognizedRolloutFiles } = collectRolloutFiles(root)
  if (files.length === 0) {
    if (unrecognizedRolloutFiles > 0) {
      throw new DiskDiscoveryError(
        `${root} 有 ${unrecognizedRolloutFiles} 个 ${ROLLOUT_PREFIX}* 文件但无 ${ROLLOUT_SUFFIX} 后缀（压缩格式漂移？）`,
      )
    }
    // 根目录不存在（新装）或目录空空如也（骨架/垃圾文件）：都是合法空列表
    return []
  }
  const names = loadNames(home)
  const byId = new Map<string, DiskThreadRow>()
  let sawAnySessionMeta = false
  let transientErrors = 0
  let parsedFiles = 0
  // 分块并行读头：冷启动 N 个文件串行 await 会把事件循环拖垮
  for (let i = 0; i < files.length; i += READ_CONCURRENCY) {
    const chunk = files.slice(i, i + READ_CONCURRENCY)
    const results = await Promise.all(chunk.map((f) => rowFromFile(f.path, names)))
    for (const res of results) {
      if (res.kind === 'gone') continue
      if (res.kind === 'transient') {
        transientErrors++
        continue
      }
      const { entry } = res
      parsedFiles++
      if (entry.sawSessionMeta) sawAnySessionMeta = true
      if (!entry.row) continue
      const existing = byId.get(entry.row.id)
      if (!existing) {
        byId.set(entry.row.id, { ...entry.row })
      } else {
        if (!existing.preview && entry.row.preview) existing.preview = entry.row.preview
        if (entry.row.createdAt && (!existing.createdAt || entry.row.createdAt < existing.createdAt))
          existing.createdAt = entry.row.createdAt
      }
    }
    // 早停：更旧的文件只可能用于回填，凑满即收
    if (byId.size >= limit) break
  }
  if (!sawAnySessionMeta) {
    if (parsedFiles === 0 && transientErrors > 0) {
      throw new DiskDiscoveryError(`${files.length} 个 rollout 文件全部读取失败（瞬时 IO 故障？）`)
    }
    throw new DiskDiscoveryError(`${files.length} 个 rollout 文件无一含 session_meta（格式漂移？）`)
  }
  return [...byId.values()].slice(0, limit)
}

/** 测试用：清空文件头与索引缓存 */
export function resetDiskDiscoveryCache(): void {
  fileCache.clear()
  indexCache = undefined
}
