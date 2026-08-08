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

export type Block = { kind: 'text'; text: string } | { kind: 'thinking'; text: string } | ToolBlock

export interface ChatMsg {
  id: string
  role: 'user' | 'assistant' | 'system'
  blocks: Block[]
  /** system 消息的展示变体 */
  systemKind?: 'info' | 'error' | 'divider'
  /** compact_boundary 元数据 */
  compactMeta?: { preTokens?: number; postTokens?: number }
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

/** 解析 user 文本里的斜杠命令回显 / 本地命令输出 / 中断标记 */
export function parseUserText(raw: string): UserTextSegment[] {
  const segs: UserTextSegment[] = []
  let rest = raw
  // 中断标记
  if (rest.includes('[Request interrupted by user]')) {
    segs.push({ kind: 'interrupted', text: '已中断' })
    rest = rest.replace('[Request interrupted by user]', '')
  }
  const tagRe =
    /<(command-name|command-args|local-command-stdout|local-command-stderr)>([\s\S]*?)<\/\1>/g
  let last = 0
  let m: RegExpExecArray | null
  const pushText = (t: string) => {
    const clean = t.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim()
    if (clean) segs.push({ kind: 'text', text: clean })
  }
  while ((m = tagRe.exec(rest))) {
    pushText(rest.slice(last, m.index))
    const [, tag, body] = m
    if (tag === 'command-name') segs.push({ kind: 'command', text: body.trim() })
    else if (tag === 'command-args') {
      const lastCmd = [...segs].reverse().find((s) => s.kind === 'command')
      if (lastCmd) lastCmd.args = body.trim()
      else if (body.trim()) segs.push({ kind: 'text', text: body.trim() })
    } else if (tag === 'local-command-stdout') segs.push({ kind: 'local-out', text: stripAnsi(body).trim() })
    else segs.push({ kind: 'local-err', text: stripAnsi(body).trim() })
    last = m.index + m[0].length
  }
  pushText(rest.slice(last))
  return segs
}

/** token 数简写：231952 → 232k */
export function shortTokens(n?: number): string {
  if (n == null) return '?'
  if (n >= 1000) return `${Math.round(n / 1000)}k`
  return String(n)
}
