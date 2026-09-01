// 消息块模型与格式化助手（live 流与历史加载共用）

export interface ToolBlock {
  kind: 'tool'
  id: string
  name: string
  input?: unknown
  resultText?: string
  resultError?: boolean
  /** 已发出调用、尚未收到结果 */
  pending?: boolean
}

export type Block =
  | { kind: 'text'; text: string }
  | { kind: 'thinking'; text: string }
  | { kind: 'image'; src: string }
  | ToolBlock

export type CollapsibleBlock = Extract<Block, { kind: 'thinking' | 'tool' }>

export function isCollapsibleBlock(b: Block): b is CollapsibleBlock {
  return b.kind === 'thinking' || b.kind === 'tool'
}

export type BlockRun =
  | { kind: 'collapsible'; blocks: CollapsibleBlock[] }
  | { kind: 'content'; block: Block }

/** 一条消息内：相邻思考/工具收成一段，正文与图片打断分组。 */
export function groupCollapsibleRuns(blocks: readonly Block[]): BlockRun[] {
  const runs: BlockRun[] = []
  for (const b of blocks) {
    if (isCollapsibleBlock(b)) {
      const last = runs[runs.length - 1]
      if (last?.kind === 'collapsible') last.blocks.push(b)
      else runs.push({ kind: 'collapsible', blocks: [b] })
    } else {
      runs.push({ kind: 'content', block: b })
    }
  }
  return runs
}

/** 流式草稿块（Chat DraftBlock 的可序列化子集） */
export interface DraftBlockLike {
  idx: number
  kind: 'text' | 'thinking' | 'tool'
  text: string
  name?: string
  toolId?: string
  jsonBuf?: string
}

export function draftBlockToBlock(b: DraftBlockLike): Block {
  if (b.kind === 'tool') {
    let input: unknown
    try {
      input = b.jsonBuf ? JSON.parse(b.jsonBuf) : undefined
    } catch {
      /* 流式 JSON 尚未闭合，参数留空 */
    }
    return {
      kind: 'tool',
      id: b.toolId ?? `draft-${b.idx}`,
      name: b.name ?? '…',
      input,
      pending: true,
    }
  }
  if (b.kind === 'thinking') return { kind: 'thinking', text: b.text }
  return { kind: 'text', text: b.text }
}

export interface ActivityItem {
  key: string
  block: CollapsibleBlock
  streaming?: boolean
}

export type TranscriptRow =
  | { type: 'message'; msg: ChatMsg; compact: boolean }
  | { type: 'activity'; items: ActivityItem[]; compact: boolean }
  | { type: 'content'; blocks: { key: string; block: Block; streaming?: boolean }[]; compact: boolean }

/**
 * 把消息列表 + 可选流式草稿摊成渲染行。
 * 相邻 assistant 消息之间的思考/工具会跨消息并进同一 activity 组；
 * 用户/系统/侧问卡片、以及正文/图片会打断分组。
 */
export function buildTranscriptRows(
  messages: readonly ChatMsg[],
  draft?: { blocks: readonly DraftBlockLike[] } | null,
): TranscriptRow[] {
  const rows: TranscriptRow[] = []
  let activity: ActivityItem[] | null = null
  let activityCompact = false

  const prevRole = (): ChatMsg['role'] | undefined => {
    if (activity) return 'assistant'
    const last = rows[rows.length - 1]
    if (!last) return undefined
    if (last.type === 'message') return last.msg.role
    return 'assistant'
  }

  const compactFor = (role: ChatMsg['role']) => role !== 'system' && prevRole() === role

  const endActivity = () => {
    if (activity && activity.length > 0) {
      rows.push({ type: 'activity', items: activity, compact: activityCompact })
    }
    activity = null
  }

  const pushActivityItem = (item: ActivityItem) => {
    if (!activity) {
      activityCompact = compactFor('assistant')
      activity = []
    }
    activity.push(item)
  }

  const pushContent = (piece: { key: string; block: Block; streaming?: boolean }) => {
    const compact = compactFor('assistant')
    endActivity()
    const last = rows[rows.length - 1]
    if (last?.type === 'content') last.blocks.push(piece)
    else rows.push({ type: 'content', blocks: [piece], compact })
  }

  for (const msg of messages) {
    if (msg.btw != null || msg.role !== 'assistant') {
      const compact = compactFor(msg.role)
      endActivity()
      rows.push({ type: 'message', msg, compact })
      continue
    }
    msg.blocks.forEach((b, i) => {
      if (isCollapsibleBlock(b)) {
        pushActivityItem({
          key: b.kind === 'tool' ? `tool:${b.id}` : `${msg.id}:thinking:${i}`,
          block: b,
        })
      } else {
        pushContent({ key: `${msg.id}:${i}`, block: b })
      }
    })
  }

  if (draft) {
    for (const b of draft.blocks) {
      const block = draftBlockToBlock(b)
      if (isCollapsibleBlock(block)) {
        pushActivityItem({
          key: `draft:${b.idx}`,
          block,
          streaming: block.kind === 'thinking',
        })
      } else {
        pushContent({ key: `draft:${b.idx}`, block, streaming: block.kind === 'text' })
      }
    }
  }

  endActivity()
  return rows
}

export interface ChatMsg {
  id: string
  role: 'user' | 'assistant' | 'system'
  blocks: Block[]
  /** 历史 JSONL 的时间；实时消息未必带此字段。 */
  timestamp?: string
  /** system 消息的展示变体 */
  systemKind?: 'info' | 'error' | 'divider'
  /** compact_boundary 元数据 */
  compactMeta?: { preTokens?: number; postTokens?: number }
  /** 侧问卡片：问题文本；存在即按侧问样式渲染 */
  btw?: string
  /** 侧问回答进行中（未收到 btw_result） */
  btwPending?: boolean
  rewindable?: boolean
}

let seq = 0
export const nextId = () => `m${++seq}`

/** 剥离 ANSI 转义码（local-command 输出常带颜色码） */
export function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '')
}

/** tool_result 的 content 可能是 string 或 text 块数组 */
export function toolResultText(rc: unknown): string {
  if (typeof rc === 'string') return rc
  if (Array.isArray(rc)) return rc.map((x) => (x?.type === 'text' ? String(x.text ?? '') : '')).join('')
  return ''
}

/** 工具卡片的一行摘要（参照官方 userFacingName/getToolUseSummary 的取舍） */
export function toolSummary(name: string, input: unknown): string {
  const i = (input ?? {}) as Record<string, unknown>
  const s = (v: unknown, n = 120) => (typeof v === 'string' ? (v.length > n ? v.slice(0, n) + '…' : v) : '')
  switch (name) {
    case 'Bash':
      return s(i.description) || s(i.command)
    case 'Read':
    case 'Edit':
    case 'Write':
    case 'NotebookEdit':
      return s(i.file_path)
    case 'Glob':
    case 'Grep':
      return s(i.pattern)
    case 'WebSearch':
      return s(i.query)
    case 'WebFetch':
      return s(i.url)
    case 'Agent':
      return s(i.description)
    default: {
      const j = JSON.stringify(input ?? {})
      return j.length > 120 ? j.slice(0, 120) + '…' : j
    }
  }
}

/** 工具详情区展示的内容（默认折叠）：按工具挑最有价值的字段 */
export function toolDetail(name: string, input: unknown): string {
  const i = (input ?? {}) as Record<string, unknown>
  switch (name) {
    case 'Bash':
      return String(i.command ?? JSON.stringify(input, null, 2))
    case 'Edit':
      return [
        i.file_path ? `# ${String(i.file_path)}` : '',
        i.old_string ? `--- 旧\n${String(i.old_string)}` : '',
        i.new_string ? `+++ 新\n${String(i.new_string)}` : '',
      ]
        .filter(Boolean)
        .join('\n\n')
    case 'Write':
      return [i.file_path ? `# ${String(i.file_path)}` : '', String(i.content ?? '')].filter(Boolean).join('\n\n')
    case 'Agent':
      return String(i.prompt ?? JSON.stringify(input, null, 2))
    default:
      return JSON.stringify(input, null, 2) ?? ''
  }
}

export interface UserTextSegment {
  kind: 'text' | 'command' | 'local-out' | 'local-err' | 'interrupted'
  text: string
  /** command 段：命令参数 */
  args?: string
}

export interface RewindPreview {
  /** 适合列表快速识别的单行摘要。 */
  summary: string
  /** 清理内部标签后的完整可读内容，供用户展开确认。 */
  detail: string
}

function normalizeCommandName(raw: string): string {
  const name = raw.trim()
  if (!name) return ''
  return name.startsWith('/') ? name : `/${name}`
}

/** 解析 user 文本里的斜杠命令回显 / 本地命令输出 / 中断标记 */
export function parseUserText(raw: string): UserTextSegment[] {
  const segs: UserTextSegment[] = []
  let rest = raw
  // 中断标记
  if (rest.includes('[Request interrupted by user]')) {
    segs.push({ kind: 'interrupted', text: '已中断' })
    rest = rest.replace('[Request interrupted by user]', '')
  }
  // command-message 常与 command-name 成对出现（如 compact → /compact）；优先保留 command-name
  const tagRe =
    /<(command-name|command-message|command-args|local-command-stdout|local-command-stderr)>([\s\S]*?)<\/\1>/g
  let last = 0
  let m: RegExpExecArray | null
  const pushText = (t: string) => {
    const clean = t
      .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
      .replace(/<\/?(?:command-message|command-name|command-args)[^>]*>/g, '')
      .trim()
    if (clean) segs.push({ kind: 'text', text: clean })
  }
  const lastCommand = () => {
    for (let i = segs.length - 1; i >= 0; i--) if (segs[i]!.kind === 'command') return segs[i]!
    return undefined
  }
  while ((m = tagRe.exec(rest))) {
    pushText(rest.slice(last, m.index))
    const [, tag, body] = m
    if (tag === 'command-name' || tag === 'command-message') {
      const name = normalizeCommandName(body)
      if (name) {
        const prev = lastCommand()
        if (prev) {
          if (tag === 'command-name') prev.text = name
        } else {
          segs.push({ kind: 'command', text: name })
        }
      }
    } else if (tag === 'command-args') {
      const prev = lastCommand()
      const args = body.trim()
      if (prev) prev.args = args
      else if (args) segs.push({ kind: 'text', text: args })
    } else if (tag === 'local-command-stdout') {
      const text = stripAnsi(body).trim()
      if (text) segs.push({ kind: 'local-out', text })
    } else {
      const text = stripAnsi(body).trim()
      if (text) segs.push({ kind: 'local-err', text })
    }
    last = m.index + m[0].length
  }
  pushText(rest.slice(last))
  return segs
}

/**
 * 把一条用户消息转为 rewind 选择器可读的摘要。
 * 本地命令输出是命令回显的结果，通常既冗长又不代表用户意图，故不纳入目标摘要；
 * 斜杠命令仍保留，以避免 /compact、/context 等目标显示为空。
 */
export function rewindPreview(raw: string, maxSummaryLength = 160): RewindPreview {
  const parts = parseUserText(raw)
    .filter((segment) => segment.kind !== 'local-out' && segment.kind !== 'local-err')
    .map((segment) => {
      if (segment.kind === 'command') return `${segment.text}${segment.args ? ` ${segment.args}` : ''}`
      return segment.text
    })
    .map((text) => text.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
  const detail = parts.join('\n\n')
  return {
    detail,
    summary: detail.length > maxSummaryLength ? `${detail.slice(0, maxSummaryLength).trimEnd()}…` : detail,
  }
}

/** token 数简写：231952 → 232k */
export function shortTokens(n?: number): string {
  if (n == null) return '?'
  if (n >= 1000) return `${Math.round(n / 1000)}k`
  return String(n)
}
