// 会话发现：扫描 ~/.claude/projects/<slug>/<sessionId>.jsonl
// 合并 ~/.claude/sessions/<pid>.json 的活跃状态

import { closeSync, existsSync, fstatSync, openSync, readdirSync, readFileSync, readSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { config } from './config'

/** 与快照 sanitizePath 一致：非字母数字 → '-'（截断/hash 情形极罕见，此处不实现） */
export function sanitizePath(p: string): string {
  return p.replace(/[^a-zA-Z0-9]/g, '-')
}

export type SessionStatus = 'busy' | 'idle' | 'waiting' | 'offline'

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
        const text =
          typeof content === 'string'
            ? content
            : Array.isArray(content)
              ? content
                  .filter((c): c is { type: string; text?: string } => c?.type === 'text')
                  .map((c) => c.text ?? '')
                  .join(' ')
              : ''
        const clean = text.trim()
        // 跳过 tool_result / isMeta / 斜杠命令回显等系统注入消息
        if (clean && !obj.isMeta && !clean.startsWith('<local-command') && !clean.startsWith('<command-name')) {
          if (!firstPrompt && !isTail) firstPrompt = clean.slice(0, 120)
          if (isTail) lastPrompt = clean.slice(0, 120)
          else lastPrompt = lastPrompt ?? undefined
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
        out.push({
          sessionId,
          cwd: meta.cwd ?? pid?.cwd,
          slug,
          title: meta.title,
          lastPrompt: meta.lastPrompt,
          mtime: fst.mtimeMs,
          sizeBytes: fst.size,
          status: pid ? ((pid.status as SessionStatus) ?? 'idle') : 'offline',
          live: pid ? { pid: pid.pid, startedAt: pid.startedAt, kind: pid.kind } : undefined,
        })
      } catch {}
    }
  }
  // 活跃的 PID 会话若尚无 jsonl（刚开始），也列出来
  for (const [sessionId, pid] of live) {
    if (!out.some((s) => s.sessionId === sessionId)) {
      out.push({
        sessionId,
        cwd: pid.cwd,
        slug: pid.cwd ? sanitizePath(pid.cwd) : '',
        title: pid.name,
        mtime: pid.updatedAt ? Date.parse(pid.updatedAt) : Date.now(),
        sizeBytes: 0,
        status: (pid.status as SessionStatus) ?? 'idle',
        live: { pid: pid.pid, startedAt: pid.startedAt, kind: pid.kind },
      })
    }
  }
  out.sort((a, b) => b.mtime - a.mtime)
  return out
}

// ---------- 历史消息（供 UI 首次加载） ----------

/** 结构化内容块：前端按块渲染（markdown 文本 / 思考 / 工具调用 / 工具结果） */
export interface HistoryBlock {
  kind: 'text' | 'thinking' | 'tool_use' | 'tool_result'
  text?: string
  /** tool_use：工具名；tool_result：无 */
  name?: string
  /** tool_use 的 id / tool_result 的 tool_use_id（用于配对） */
  id?: string
  /** tool_use 的参数 */
  input?: unknown
  /** tool_result 是否失败 */
  isError?: boolean
}

export interface HistoryMessage {
  uuid?: string
  role: 'user' | 'assistant' | 'system'
  /** system 消息的子类型（如 compact_boundary） */
  subtype?: string
  blocks: HistoryBlock[]
  /** compact_boundary 的元数据 */
  compactMeta?: { trigger?: string; preTokens?: number; postTokens?: number }
  timestamp?: string
  isMeta?: boolean
  /** 是否可作为 rewind 目标（compact 边界之前的消息在逻辑上已不存在，无法回滚到） */
  rewindable?: boolean
}

/** 提取 tool_result 的纯文本内容（content 可能是 string 或 text 块数组） */
function toolResultText(rc: unknown): string {
  if (typeof rc === 'string') return rc
  if (Array.isArray(rc)) return rc.map((x) => (x?.type === 'text' ? (x.text ?? '') : '')).join('')
  return ''
}

export function readHistory(slug: string, sessionId: string, limit = 300): HistoryMessage[] {
  const path = join(config.claudeConfigDir, 'projects', slug, `${sessionId}.jsonl`)
  if (!existsSync(path)) return []
  const lines = readFileSync(path, 'utf8').split('\n')
  const msgs: HistoryMessage[] = []
  const msgLineIdx: number[] = []
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
    const type = obj.type as string
    if (type === 'system' && obj.subtype === 'compact_boundary') {
      lastBoundaryLine = li
      const meta = (obj.compactMetadata ?? obj.compact_metadata ?? {}) as Record<string, unknown>
      msgs.push({
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
      })
      msgLineIdx.push(li)
      continue
    }
    if (type !== 'user' && type !== 'assistant') continue
    // 子代理内部消息不进主对话抄本
    if (obj.isSidechain) continue
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
        else if (c?.type === 'tool_result') {
          const rt = toolResultText(c.content)
          blocks.push({ kind: 'tool_result', id: c.tool_use_id, text: rt, isError: c.is_error === true })
        }
      }
    }
    if (blocks.length === 0) continue
    msgs.push({
      uuid: obj.uuid as string | undefined,
      role: type,
      blocks,
      timestamp: obj.timestamp as string | undefined,
      isMeta: obj.isMeta as boolean | undefined,
    })
    msgLineIdx.push(li)
  }
  // 只有最后一个 compact 边界之后的消息才是逻辑上存在、可回滚的
  for (let i = 0; i < msgs.length; i++) {
    msgs[i].rewindable = msgLineIdx[i] > lastBoundaryLine
  }
  return msgs.slice(-limit)
}
