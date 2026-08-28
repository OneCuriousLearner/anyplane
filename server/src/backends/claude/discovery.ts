// 会话发现：扫描 ~/.claude/projects/<slug>/<sessionId>.jsonl
// 合并 ~/.claude/sessions/<pid>.json 的活跃状态

import { closeSync, existsSync, fstatSync, openSync, readdirSync, readFileSync, readSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'
import { saveUpload } from '../../uploads'
import { config } from '../../config'
import { backgroundAlive, daemonAgents } from './agents'
import { isInternalUserMessage, type CliMessage } from './protocol'

/** 与快照 sanitizePath 一致：非字母数字 → '-'（截断/hash 情形极罕见，此处不实现） */
export function sanitizePath(p: string): string {
  return p.replace(/[^a-zA-Z0-9]/g, '-')
}

export type SessionStatus = 'busy' | 'idle' | 'waiting' | 'offline'

const KNOWN_STATUS: readonly SessionStatus[] = ['busy', 'idle', 'waiting', 'offline']

/**
 * 归一化 pid 文件里的 status。官方 CLI 会写入本项目未建模的状态（例如 `shell`），
 * 直接 `as SessionStatus` 断言会把未知值透传给前端并击穿其状态查找表。
 * 遵循宽松解析原则：未知状态一律降级为 idle，而不是让下游崩溃。
 */
function normalizeStatus(raw: string | undefined): SessionStatus {
  return raw && (KNOWN_STATUS as readonly string[]).includes(raw) ? (raw as SessionStatus) : 'idle'
}

export interface SessionInfo {
  sessionId: string
  /** 项目原始路径（从 jsonl 首行 cwd 字段还原；读不到则为 undefined） */
  cwd?: string
  /** projects 下的目录名（sanitize 后的 slug） */
  slug: string
  title?: string
  lastPrompt?: string
  mtime: number
  sizeBytes: number
  status: SessionStatus
  /** 活跃进程信息（若存在） */
  live?: { pid: number; startedAt?: string; kind?: string }
}

interface PidFile {
  pid: number
  sessionId: string
  cwd?: string
  status?: string
  startedAt?: string
  updatedAt?: string
  kind?: string
  name?: string
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (e: unknown) {
    // EPERM 说明进程存在但无权信号
    return (e as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** 外部运行中会话的实时状态（来自 ~/.claude/sessions/<pid>.json）；tailer 用它反映非 spawn 会话的 busy/idle */
export function liveSessionInfo(sessionId: string): { status: SessionStatus; pid: number } | undefined {
  const p = readPidFiles().get(sessionId)
  return p ? { status: normalizeStatus(p.status), pid: p.pid } : undefined
}

function readPidFiles(): Map<string, PidFile> {
  const dir = join(config.claudeConfigDir, 'sessions')
  const map = new Map<string, PidFile>()
  if (!existsSync(dir)) return map
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.json')) continue
    try {
      const data = JSON.parse(readFileSync(join(dir, f), 'utf8')) as PidFile
      if (data.sessionId && isProcessRunning(data.pid)) map.set(data.sessionId, data)
    } catch {}
  }
  return map
}

/** message.content（string 或块数组）→ 纯文本（只取 text 块，sep 连接） */
function textOfContent(content: unknown, sep: string): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .filter((c): c is { type: string; text?: string } => c?.type === 'text')
      .map((c) => c.text ?? '')
      .join(sep)
  }
  return ''
}

/** 从 jsonl 提取标题/首条提示/cwd。只读前 64KB + 末 64KB，避免大文件全量解析 */
function extractMeta(path: string): { title?: string; lastPrompt?: string; cwd?: string } {
  let head: string
  let tail = ''
  try {
    const fd = openSync(path, 'r')
    const size = fstatSync(fd).size
    const CHUNK = 64 * 1024
    const headBuf = Buffer.alloc(Math.min(CHUNK, size))
    readSync(fd, headBuf, 0, headBuf.length, 0)
    head = headBuf.toString('utf8')
    if (size > CHUNK) {
      const tailBuf = Buffer.alloc(CHUNK)
      readSync(fd, tailBuf, 0, CHUNK, size - CHUNK)
      tail = tailBuf.toString('utf8')
    }
    closeSync(fd)
  } catch {
    return {}
  }

  let title: string | undefined
  let cwd: string | undefined
  let firstPrompt: string | undefined
  let lastPrompt: string | undefined

  const scan = (text: string, isTail: boolean) => {
    for (const line of text.split('\n')) {
      const t = line.trim()
      if (!t || !t.startsWith('{')) continue
      let obj: Record<string, unknown>
      try {
        obj = JSON.parse(t)
      } catch {
        continue // 截断的行
      }
      if (!cwd && typeof obj.cwd === 'string') cwd = obj.cwd
      const type = obj.type as string
      if (type === 'custom-title' && typeof obj.customTitle === 'string') {
        title = obj.customTitle // 后者优先（重命名会追加新条目）
      } else if (!title && type === 'ai-title' && typeof obj.aiTitle === 'string') {
        title = obj.aiTitle
      } else if (!title && type === 'summary' && typeof obj.summary === 'string') {
        title = obj.summary
      } else if (type === 'user') {
        const content = (obj.message as { content?: unknown } | undefined)?.content
        const clean = textOfContent(content, ' ').trim()
        // 跳过 tool_result / isMeta / 斜杠命令回显等系统注入消息
        if (clean && !obj.isMeta && !clean.startsWith('<local-command') && !clean.startsWith('<command-name')) {
          if (!firstPrompt && !isTail) firstPrompt = clean.slice(0, 120)
          if (isTail) lastPrompt = clean.slice(0, 120)
        }
      }
    }
  }
  scan(head, false)
  scan(tail, true)

  return { title: title ?? firstPrompt, lastPrompt, cwd }
}

export function listSessions(): SessionInfo[] {
  const projectsDir = join(config.claudeConfigDir, 'projects')
  const live = readPidFiles()
  // daemon 视图（agents --json --all，SWR 缓存）：pid 文件优先，daemon 兜底；
  // background agent 无 pid 文件，其"活着"状态只有这里能拿到
  const agents = daemonAgents()
  /** pid 文件未覆盖时，用 daemon 信息合成 live（background 活着=busy，interactive 按其 status） */
  const daemonLiveOf = (sessionId: string): SessionInfo['live'] & { status?: SessionStatus } | undefined => {
    if (live.has(sessionId)) return undefined
    const a = agents.get(sessionId)
    if (!a) return undefined
    if (a.kind === 'background') {
      return backgroundAlive(a.state) ? { pid: a.pid ?? 0, kind: 'background', status: 'busy' } : undefined
    }
    // interactive：daemon 还在跟踪即视为活着（pid 文件刚被清理的竞态兜底）
    if (a.pid || a.status) {
      return { pid: a.pid ?? 0, startedAt: a.startedAt ? new Date(a.startedAt).toISOString() : undefined, kind: a.kind, status: normalizeStatus(a.status) }
    }
    return undefined
  }
  const out: SessionInfo[] = []
  if (!existsSync(projectsDir)) return out

  for (const slug of readdirSync(projectsDir)) {
    const dir = join(projectsDir, slug)
    let st
    try {
      st = statSync(dir)
    } catch {
      continue
    }
    if (!st.isDirectory()) continue
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.jsonl')) continue
      const sessionId = f.slice(0, -'.jsonl'.length)
      const full = join(dir, f)
      try {
        const fst = statSync(full)
        const meta = extractMeta(full)
        const pid = live.get(sessionId)
        const dl = pid ? undefined : daemonLiveOf(sessionId)
        out.push({
          sessionId,
          cwd: meta.cwd ?? pid?.cwd,
          slug,
          title: meta.title,
          lastPrompt: meta.lastPrompt,
          mtime: fst.mtimeMs,
          sizeBytes: fst.size,
          status: pid ? normalizeStatus(pid.status) : dl ? (dl.status ?? 'idle') : 'offline',
          live: pid ? { pid: pid.pid, startedAt: pid.startedAt, kind: pid.kind } : dl ? { pid: dl.pid, startedAt: dl.startedAt, kind: dl.kind } : undefined,
        })
      } catch {}
    }
  }
  // 活跃的 PID 会话若尚无 jsonl（刚开始），也列出来
  const seen = new Set(out.map((s) => s.sessionId))
  for (const [sessionId, pid] of live) {
    if (!seen.has(sessionId)) {
      out.push({
        sessionId,
        cwd: pid.cwd,
        slug: pid.cwd ? sanitizePath(pid.cwd) : '',
        title: pid.name,
        mtime: pid.updatedAt ? Date.parse(pid.updatedAt) : Date.now(),
        sizeBytes: 0,
        status: normalizeStatus(pid.status),
        live: { pid: pid.pid, startedAt: pid.startedAt, kind: pid.kind },
      })
      seen.add(sessionId)
    }
  }
  // daemon 跟踪着的会话（如运行中的 background agent）尚无 jsonl 时同样列出
  for (const [sessionId, a] of agents) {
    if (seen.has(sessionId)) continue
    const dl = daemonLiveOf(sessionId)
    if (!dl) continue
    out.push({
      sessionId,
      cwd: a.cwd,
      slug: a.cwd ? sanitizePath(a.cwd) : '',
      title: a.name,
      mtime: a.startedAt ?? Date.now(),
      sizeBytes: 0,
      status: dl.status ?? 'idle',
      live: { pid: dl.pid, startedAt: dl.startedAt, kind: dl.kind },
    })
  }
  out.sort((a, b) => b.mtime - a.mtime)
  return out
}

// ---------- 历史消息（供 UI 首次加载） ----------

// 共享类型正本在 ../types（后端无关抽象层）；此处 import 自用 + re-export 兼容既有 import 路径
import type { HistoryBlock, HistoryMessage } from '../types'
export type { HistoryMessage } from '../types'

/** 提取 tool_result 的纯文本内容（content 可能是 string 或 text 块数组） */
function toolResultText(rc: unknown): string {
  return textOfContent(rc, '')
}

/**
 * 对齐官方 TUI 的 selectableUserMessagesFilter（MessageSelector.tsx）：
 * 只有真实用户文本消息才会建文件 checkpoint、可作为 rewind 目标。
 * tool_result、isMeta/isSynthetic、系统注入标签消息一律排除——
 * 对它们调用 rewind_files 只会得到 "No file checkpoint found for this message"。
 * 斜杠命令回显（<command-name>）不过滤：官方也不过滤，且 checkpoint 照常建立。
 */
const INTERNAL_TEXT_TAGS = [
  '<local-command-stdout>',
  '<local-command-stderr>',
  '<bash-stdout>',
  '<bash-stderr>',
  '<task-notification>',
  '<tick>',
  '<teammate-message>',
]

export function isSelectableRewindTarget(obj: Record<string, unknown>): boolean {
  if (obj.isMeta === true || obj.isSynthetic === true) return false
  const content = (obj.message as { content?: unknown } | undefined)?.content
  if (Array.isArray(content)) {
    if ((content[0] as { type?: unknown } | undefined)?.type === 'tool_result') return false
  }
  const text = textOfContent(content, ' ')
  return !INTERNAL_TEXT_TAGS.some((tag) => text.includes(tag))
}

/**
 * 把一条 transcript JSONL 记录转为 HistoryMessage；返回 null 表示不进主抄本。
 * readHistory 与 transcript tailer 共用同一套解析，保证历史与实时追加渲染一致。
 * 不含 rewindable 计算（依赖全文件行序上下文），由调用方补。
 */
export function entryToHistoryMessage(obj: Record<string, unknown>): HistoryMessage | null {
  const type = obj.type as string
  if (type === 'system' && obj.subtype === 'compact_boundary') {
    const meta = (obj.compactMetadata ?? obj.compact_metadata ?? {}) as Record<string, unknown>
    return {
      uuid: obj.uuid as string | undefined,
      role: 'system',
      subtype: 'compact_boundary',
      blocks: [],
      compactMeta: {
        trigger: meta.trigger as string | undefined,
        preTokens: (meta.preTokens ?? meta.pre_tokens) as number | undefined,
        postTokens: (meta.postTokens ?? meta.post_tokens) as number | undefined,
      },
      timestamp: obj.timestamp as string | undefined,
    }
  }
  if (type !== 'user' && type !== 'assistant') return null
  if (isInternalUserMessage(obj as CliMessage)) return null
  // 子代理内部消息不进主对话抄本
  if (obj.isSidechain) return null
  const message = obj.message as { content?: unknown } | undefined
  const content = message?.content
  const blocks: HistoryBlock[] = []
  if (typeof content === 'string') {
    if (content.trim()) blocks.push({ kind: 'text', text: content })
  } else if (Array.isArray(content)) {
    for (const c of content) {
      if (c?.type === 'text' && c.text?.trim()) blocks.push({ kind: 'text', text: c.text })
      else if (c?.type === 'thinking' && c.thinking?.trim()) blocks.push({ kind: 'thinking', text: c.thinking })
      else if (c?.type === 'tool_use') blocks.push({ kind: 'tool_use', name: c.name, id: c.id, input: c.input })
      else if (c?.type === 'image' && c.source?.type === 'base64' && typeof c.source.data === 'string') {
        // 历史中的 base64 原图：hash 命名落盘去重，前端经 /api/uploads 展示
        try {
          const path = saveUpload({
            name: 'history',
            mediaType: String(c.source.media_type ?? 'image/png'),
            dataBase64: c.source.data,
          })
          blocks.push({ kind: 'image', src: `/api/uploads/${basename(path)}` })
        } catch {
          blocks.push({ kind: 'text', text: '[图片]' })
        }
      } else if (c?.type === 'tool_result') {
        const rt = toolResultText(c.content)
        blocks.push({ kind: 'tool_result', id: c.tool_use_id, text: rt, isError: c.is_error === true })
      }
    }
  }
  if (blocks.length === 0) return null
  return {
    uuid: obj.uuid as string | undefined,
    role: type,
    blocks,
    timestamp: obj.timestamp as string | undefined,
    isMeta: obj.isMeta as boolean | undefined,
  }
}

export function readHistory(
  slug: string,
  sessionId: string,
  limit = 300,
): { messages: HistoryMessage[]; fileBytes: number } {
  const path = join(config.claudeConfigDir, 'projects', slug, `${sessionId}.jsonl`)
  if (!existsSync(path)) return { messages: [], fileBytes: 0 }
  // 读 Buffer 而非 utf8 文本：fileBytes 必须与本次实际解析的字节精确一致，
  // tailer 从该偏移续读才不会有缝（statSync 与 read 之间文件可能增长）。
  const raw = readFileSync(path)
  const lines = raw.toString('utf8').split('\n')
  const msgs: HistoryMessage[] = []
  const msgLineIdx: number[] = []
  const selectable: boolean[] = []
  let lastBoundaryLine = -1
  for (let li = 0; li < lines.length; li++) {
    const t = lines[li].trim()
    if (!t.startsWith('{')) continue
    let obj: Record<string, unknown>
    try {
      obj = JSON.parse(t)
    } catch {
      continue
    }
    if (obj.type === 'system' && obj.subtype === 'compact_boundary') lastBoundaryLine = li
    const msg = entryToHistoryMessage(obj)
    if (!msg) continue
    msgs.push(msg)
    msgLineIdx.push(li)
    selectable.push(msg.role !== 'user' || isSelectableRewindTarget(obj))
  }
  // 只有最后一个 compact 边界之后的消息才是逻辑上存在、可回滚的；
  // user 消息还需通过官方同款的目标过滤（无 checkpoint 的消息不可作为 rewind 目标）
  for (let i = 0; i < msgs.length; i++) {
    msgs[i].rewindable = msgLineIdx[i] > lastBoundaryLine && selectable[i]
  }
  return { messages: msgs.slice(-limit), fileBytes: raw.length }
}
