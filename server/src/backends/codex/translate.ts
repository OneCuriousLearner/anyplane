// Codex → Claude stream-json 形状翻译器。
// 策略：把 ThreadItem 生命周期翻译成前端 blocks.ts 已理解的 assistant/stream_event/
// tool_use/tool_result 序列，前端零改动渲染 Codex 会话。

import type { CliMessage } from '../claude/protocol'
import type { HistoryBlock, HistoryMessage } from '../types'
import { resolveUpload } from '../../uploads'

// ---------- 通知 → CliMessage（live 流） ----------

type Params = Record<string, unknown>

interface ThreadItem {
  type?: string
  id?: string
  text?: string
  summary?: string[]
  content?: unknown
  command?: string
  cwd?: string
  status?: string
  exitCode?: number
  aggregatedOutput?: string
  changes?: Array<{ path?: string; kind?: unknown; diff?: string }>
  server?: string
  tool?: string
  arguments?: unknown
  result?: unknown
  error?: unknown
  query?: string
  durationMs?: number
  /** enteredReviewMode/exitedReviewMode 的审查说明 */
  review?: string
}

/** message_start + content_block_start 开头流（agentMessage 文本 / reasoning 思考共用） */
function streamStart(id: string, block: Record<string, unknown>): CliMessage[] {
  return [
    { type: 'stream_event', event: { type: 'message_start', message: { id, role: 'assistant', content: [] } } },
    { type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: block } },
  ]
}

/** assistant 快照 + block/message stop（对齐 claude 真实序：快照合并草稿、stop 提交） */
function assistantFinal(id: string, block: Record<string, unknown>): CliMessage[] {
  return [
    { type: 'assistant', message: { id, role: 'assistant', content: [block] } },
    { type: 'stream_event', event: { type: 'content_block_stop', index: 0 } },
    { type: 'stream_event', event: { type: 'message_stop' } },
  ]
}

/** 每个线程一个：维护 itemId → 合成 message id / 块序号的流式状态 */
export class ThreadTranslator {
  /** item/started：agentMessage 开头流（message_start + block_start）；工具项发 tool_use */
  itemStarted(item: ThreadItem): CliMessage[] {
    if (!item.id || !item.type) return []
    switch (item.type) {
      case 'agentMessage':
        return streamStart(item.id, { type: 'text', text: '' })
      case 'reasoning':
        return streamStart(item.id, { type: 'thinking', thinking: '' })
      case 'commandExecution':
      case 'fileChange':
      case 'mcpToolCall':
      case 'webSearch': {
        const toolUse = this.toolUseBlock(item)
        return [
          {
            type: 'assistant',
            message: { id: `tool-${item.id}`, role: 'assistant', content: [toolUse] },
          },
        ]
      }
      default:
        return []
    }
  }

  /** item/completed：assistant 快照必须在 message_stop 之前（对齐 claude 真实序：快照合并草稿、stop 提交） */
  itemCompleted(item: ThreadItem): CliMessage[] {
    if (!item.id || !item.type) return []
    switch (item.type) {
      case 'agentMessage':
        return assistantFinal(item.id, { type: 'text', text: item.text ?? '' })
      case 'reasoning':
        return assistantFinal(item.id, { type: 'thinking', thinking: reasoningText(item.summary, item.content) })
      case 'commandExecution':
      case 'fileChange':
      case 'mcpToolCall':
      case 'webSearch': {
        const r = toolResultFromItem(item)
        return [toolResultMsg(item.id, r.text, r.isError)]
      }
      case 'plan':
        return [
          {
            type: 'assistant',
            message: { id: item.id, role: 'assistant', content: [{ type: 'text', text: item.text ?? '' }] },
          },
        ]
      case 'contextCompaction':
        return [{ type: 'system', subtype: 'compact_boundary' }]
      case 'enteredReviewMode':
        return [systemText(`进入代码审查：${item.review ?? ''}`)]
      case 'exitedReviewMode':
        return [systemText(`审查完成\n${item.review ?? ''}`)]
      default:
        return []
    }
  }

  /** item 级 delta → stream_event delta */
  itemDelta(method: string, params: Params): CliMessage[] {
    const itemId = String(params.itemId ?? '')
    if (!itemId) return []
    if (method === 'item/agentMessage/delta') {
      return [
        {
          type: 'stream_event',
          event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: String(params.delta ?? '') } },
          message: { id: itemId },
        },
      ]
    }
    if (method === 'item/reasoning/textDelta' || method === 'item/reasoning/summaryTextDelta') {
      return [
        {
          type: 'stream_event',
          event: { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: String(params.delta ?? '') } },
          message: { id: itemId },
        },
      ]
    }
    return []
  }

  private toolUseBlock(item: ThreadItem): Record<string, unknown> {
    switch (item.type) {
      case 'commandExecution':
        return { type: 'tool_use', id: item.id, name: 'Bash', input: { command: item.command ?? '', description: item.cwd ? `cwd: ${item.cwd}` : undefined } }
      case 'fileChange': {
        const paths = (item.changes ?? []).map((c) => c.path).filter(Boolean)
        return { type: 'tool_use', id: item.id, name: 'Edit', input: { file_path: paths[0] ?? '', paths } }
      }
      case 'mcpToolCall':
        return { type: 'tool_use', id: item.id, name: `${item.server ?? 'mcp'}:${item.tool ?? '?'}`, input: item.arguments }
      case 'webSearch':
        return { type: 'tool_use', id: item.id, name: 'WebSearch', input: { query: item.query ?? '' } }
      default:
        return { type: 'tool_use', id: item.id, name: item.type ?? '?', input: {} }
    }
  }
}

function toolResultMsg(toolUseId: string, text: string, isError: boolean): CliMessage {
  return {
    type: 'user',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content: text, is_error: isError }] },
  }
}

/** 工具项（commandExecution/fileChange/mcpToolCall/webSearch）的结果文本与失败标记：
 *  live（item/completed）与历史（itemsToHistory）共用同一计算，避免两侧漂移。 */
function toolResultFromItem(item: ThreadItem): { text: string; isError: boolean } {
  switch (item.type) {
    case 'commandExecution': {
      const isError =
        item.status === 'failed' ||
        item.status === 'declined' ||
        (typeof item.exitCode === 'number' && item.exitCode !== 0)
      const out = item.aggregatedOutput ?? (item.status === 'declined' ? '（用户拒绝）' : '')
      return { text: out || `（exit ${item.exitCode ?? '?'}）`, isError }
    }
    case 'fileChange': {
      const diff = (item.changes ?? [])
        .map((c) => `--- ${c.path ?? '?'}\n${c.diff ?? ''}`.trim())
        .join('\n\n')
      return { text: diff || '（无 diff）', isError: item.status === 'failed' || item.status === 'declined' }
    }
    case 'mcpToolCall': {
      const isError = item.status === 'failed' || !!item.error
      return { text: item.error ? JSON.stringify(item.error) : stringifyResult(item.result), isError }
    }
    default: // webSearch 等：结果即正文，失败态不由 item.status 表达
      return { text: stringifyResult(item.result ?? item.query ?? ''), isError: false }
  }
}

function systemText(text: string): CliMessage {
  return { type: 'system', subtype: 'status', text }
}

/** reasoning 的 summary 与 content 可能互为镜像（部分供应商），重复时只取一份 */
export function reasoningText(summary?: string[], content?: unknown): string {
  const s = (summary ?? []).filter(Boolean)
  const c = (Array.isArray(content) ? (content as string[]) : []).filter(Boolean)
  if (s.length > 0 && s.join('\n') === c.join('\n')) return s.join('\n\n')
  return [...s, ...c].join('\n\n')
}

function stringifyResult(r: unknown): string {
  if (r == null) return ''
  if (typeof r === 'string') return r
  try {
    return JSON.stringify(r, null, 2).slice(0, 4000)
  } catch {
    return String(r)
  }
}

/** thread 状态 → claude session_state_changed 三态 */
export function mapThreadStatus(status: { type?: string } | undefined): 'idle' | 'running' | 'requires_action' {
  if (!status) return 'idle'
  if (status.type === 'active') return 'running'
  return 'idle'
}

/** turn/completed → claude result 形状（usage 只取 token，费用字段恒 0 且不展示） */
export function turnCompletedMsg(threadId: string, turn: Params, lastUsage?: Record<string, number>): CliMessage {
  const failed = turn.status === 'failed'
  const err = turn.error as { message?: string } | null | undefined
  return {
    type: 'result',
    subtype: failed ? 'error' : 'success',
    is_error: failed,
    result: failed ? (err?.message ?? 'turn failed') : '',
    session_id: threadId,
    total_cost_usd: 0,
    usage: lastUsage ?? {},
  }
}

// ---------- 历史（thread.turns）→ HistoryMessage ----------

/** 工具项历史对：tool_use + tool_result 两条消息（live 侧分两次发，历史落一起由前端归并） */
function pushToolPair(
  out: HistoryMessage[],
  uuid: string | undefined,
  toolUse: HistoryBlock,
  item: ThreadItem,
): void {
  out.push({ uuid, role: 'assistant', blocks: [toolUse] })
  const r = toolResultFromItem(item)
  out.push({
    uuid: `${item.id}-r`,
    role: 'user',
    blocks: [{ kind: 'tool_result', id: item.id, text: r.text, isError: r.isError }],
  })
}

/** turn.items[] → 历史消息序列（tool_use/tool_result 跨消息配对由前端归并）。
 *  turnId 存在时：该轮首条 userMessage 以 turnId 为 uuid 且 rewindable——
 *  供 /rewind 分叉回滚定位（thread/fork 的 beforeTurnId 目标）。 */
export function itemsToHistory(items: ThreadItem[], turnId?: string): HistoryMessage[] {
  const out: HistoryMessage[] = []
  let firstUserMarked = false
  for (const item of items) {
    const uuid = item.id
    switch (item.type) {
      case 'userMessage': {
        const blocks = userInputBlocks(item.content)
        if (blocks.length === 0) break
        const markable = !!turnId && !firstUserMarked
        if (markable) firstUserMarked = true
        out.push({
          uuid: markable ? turnId : uuid,
          role: 'user',
          blocks,
          rewindable: markable,
        })
        break
      }
      case 'agentMessage':
        out.push({ uuid, role: 'assistant', blocks: [{ kind: 'text', text: item.text ?? '' }] })
        break
      case 'reasoning': {
        const text = reasoningText(item.summary, item.content)
        if (text) out.push({ uuid, role: 'assistant', blocks: [{ kind: 'thinking', text }] })
        break
      }
      case 'plan':
        out.push({ uuid, role: 'assistant', blocks: [{ kind: 'text', text: item.text ?? '' }] })
        break
      case 'commandExecution':
        // tool_use 有意不用 live 的 toolUseBlock：历史卡摘要应显示命令本身，
        // live 侧的 description(cwd) 会抢占 toolSummary 的首选字段
        pushToolPair(out, uuid, { kind: 'tool_use', id: item.id, name: 'Bash', input: { command: item.command ?? '' } }, item)
        break
      case 'fileChange': {
        const paths = (item.changes ?? []).map((c) => c.path).filter(Boolean)
        pushToolPair(out, uuid, { kind: 'tool_use', id: item.id, name: 'Edit', input: { file_path: paths[0] ?? '', paths } }, item)
        break
      }
      case 'mcpToolCall':
        pushToolPair(out, uuid, { kind: 'tool_use', id: item.id, name: `${item.server ?? 'mcp'}:${item.tool ?? '?'}`, input: item.arguments }, item)
        break
      case 'webSearch':
        pushToolPair(out, uuid, { kind: 'tool_use', id: item.id, name: 'WebSearch', input: { query: item.query ?? '' } }, item)
        break
      case 'contextCompaction':
        out.push({ uuid, role: 'system', subtype: 'compact_boundary', blocks: [] })
        break
      default:
        break // collabToolCall/imageGeneration/imageView/sleep/dynamicToolCall 等暂不渲染
    }
  }
  return out
}

/** userMessage content → 历史块；localImage 在 uploads 目录内时给可展示 URL，其余降级占位 */
function userInputBlocks(content: unknown): HistoryBlock[] {
  if (!Array.isArray(content)) return []
  const texts: string[] = []
  const images: HistoryBlock[] = []
  for (const c of content as Array<Record<string, unknown>>) {
    if (!c) continue
    if (c.type === 'text' && typeof c.text === 'string') {
      texts.push(c.text)
    } else if (c.type === 'image' || c.type === 'localImage') {
      const base = typeof c.path === 'string' ? (c.path.split('/').pop() ?? '') : ''
      if (base && resolveUpload(base)) images.push({ kind: 'image', src: `/api/uploads/${base}` })
      else texts.push('[图片]')
    } else if (c.type === 'audio' || c.type === 'localAudio') {
      texts.push('[音频]')
    } else if (c.type === 'skill') {
      texts.push(`[skill: ${(c as { name?: string }).name ?? '?'}]`)
    } else if (c.type === 'mention') {
      texts.push(`[${(c as { name?: string }).name ?? 'mention'}]`)
    }
  }
  const blocks: HistoryBlock[] = []
  if (texts.join('\n').trim()) blocks.push({ kind: 'text', text: texts.join('\n') })
  return [...blocks, ...images]
}

export type { HistoryMessage }
