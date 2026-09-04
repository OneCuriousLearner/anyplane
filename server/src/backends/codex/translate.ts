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
  /** subAgentActivity：started/interacted/interrupted/completed */
  kind?: string
  /** collabAgentToolCall：任务提示文本 */
  prompt?: string
  /** collabAgentToolCall：接收方子线程 id 列表（spawn End 才有值） */
  receiverThreadIds?: string[]
  /** collabAgentToolCall End：各子代理已知状态（wait End 携带终态与报告正文） */
  agentsStates?: Record<string, { status?: string; message?: string }>
  /** subAgentActivity：子代理线程 id 与角色路径 */
  agentThreadId?: string
  agentPath?: string
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
      // collabAgentToolCall 进主线工具卡（codex 的"工具"本体就是它，不显示主线会像没调工具）；
      // Begin 时还没有子线程 id，侧栏生命周期桶在 itemCompleted 统一处理
      case 'collabAgentToolCall':
        return [
          {
            type: 'assistant',
            message: { id: `tool-${item.id}`, role: 'assistant', content: [this.toolUseBlock(item)] },
          },
        ]
      // subAgentActivity 只以 item/completed 送达，且不是工具调用，不进主线卡
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
      // 子代理生命周期 → claude task_started/task_notification 形状（前端侧栏零分叉）。
      // 桶键统一用子线程 id（agentThreadId）：collab 与 subAgentActivity 两条事件线天然归并。
      // collab 同时补主线 tool_result，与 itemStarted 的 tool_use 配成一张卡
      case 'collabAgentToolCall':
        return [...collabAgentMsgs(item), collabToolResultMsg(item)]
      case 'subAgentActivity':
        return subAgentActivityMsgs(item)
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
      case 'collabAgentToolCall':
        return { type: 'tool_use', id: item.id, name: 'Collab', input: { tool: item.tool ?? '?', prompt: item.prompt ?? '' } }
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

/** collab 子代理状态（pendingInit/running/interrupted/completed/errored/shutdown/notFound）
 *  → claude task_notification 三态；非终态返回 null 不发通知 */
function collabTerminalStatus(status?: string): 'completed' | 'failed' | 'stopped' | null {  switch (status) {
    case 'completed':
      return 'completed'
    case 'interrupted':
    case 'shutdown':
      return 'stopped'
    case 'errored':
    case 'notFound':
      return 'failed'
    default:
      return null
  }
}

function collabToolResultMsg(item: ThreadItem): CliMessage {
  const isError = item.status === 'failed' || item.status === 'interrupted'
  const parts: string[] = [`${String(item.tool ?? '?')} → ${String(item.status ?? '?')}`]
  const receivers = (item.receiverThreadIds ?? []).filter(Boolean)
  if (receivers.length > 0) parts.push(`agents: ${receivers.length}`)
  for (const [tid, st] of Object.entries(item.agentsStates ?? {})) {
    const msg = typeof st?.message === 'string' && st.message.trim() ? `: ${st.message.slice(0, 120)}` : ''
    parts.push(`${tid.slice(0, 8)} ${String(st?.status ?? '?')}${msg}`)
  }
  return toolResultMsg(item.id!, parts.join('\n'), isError)
}

/**
 * collabAgentToolCall End → 生命周期事件。
 * 只在 End 处理：Begin（inProgress）时 receiverThreadIds 为空，建了桶也无法与后续事件归并。
 * - spawnAgent 成功：task_started（桶键 = 新子线程 id，prompt 截断作描述）
 * - spawnAgent 失败/打断：无子线程 id，用 call id 建一张即终态的卡（否则失败完全不可见）
 * - 所有 End 的 agentsStates：携带各子代理终态（wait End 的报告正文在此），逐个发 task_notification；
 *   与 subAgentActivity 的终态可能重复，前端 markTerminal 幂等（仅刷新驱逐倒计时）
 */
function collabAgentMsgs(item: ThreadItem): CliMessage[] {
  const out: CliMessage[] = []
  const receivers = (item.receiverThreadIds ?? []).filter(Boolean)
  if (item.tool === 'spawnAgent') {
    if (item.status === 'completed' && receivers.length > 0) {
      out.push({
        type: 'system',
        subtype: 'task_started',
        tool_use_id: receivers[0],
        agent_thread_id: receivers[0],
        task_type: 'spawnAgent',
        description: typeof item.prompt === 'string' && item.prompt.trim() ? item.prompt.slice(0, 80) : '子代理',
      })
    } else if (item.status === 'failed' || item.status === 'interrupted') {
      out.push({
        type: 'system',
        subtype: 'task_notification',
        tool_use_id: receivers[0] ?? item.id,
        agent_thread_id: receivers[0],
        status: item.status === 'interrupted' ? 'stopped' : 'failed',
      })
    }
  }
  for (const [tid, st] of Object.entries(item.agentsStates ?? {})) {
    const mapped = collabTerminalStatus(st?.status)
    if (!mapped) continue
    out.push({
      type: 'system',
      subtype: 'task_notification',
      tool_use_id: tid,
      agent_thread_id: tid,
      status: mapped,
      summary: typeof st?.message === 'string' ? st.message.slice(0, 500) : undefined,
    })
  }
  return out
}

/**
 * subAgentActivity → 生命周期事件。只以 item/completed 送达（event_mapping.rs 实测），
 * kind=started/interacted/interrupted/completed 各占一条；interacted 无展示语义，忽略。
 */
function subAgentActivityMsgs(item: ThreadItem): CliMessage[] {
  const tid = item.agentThreadId
  if (!tid) return []
  switch (item.kind) {
    case 'started':
      return [
        {
          type: 'system',
          subtype: 'task_started',
          tool_use_id: tid,
          agent_thread_id: tid,
          task_type: 'subAgent',
          description: item.agentPath || '子代理',
        },
      ]
    case 'completed':
      return [{ type: 'system', subtype: 'task_notification', tool_use_id: tid, agent_thread_id: tid, status: 'completed' }]
    case 'interrupted':
      return [{ type: 'system', subtype: 'task_notification', tool_use_id: tid, agent_thread_id: tid, status: 'stopped' }]
    default: // interacted
      return []
  }
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

/** turn/completed → claude result 形状（usage 只取 output_tokens 并转 snake_case——
 *  前端按 claude stream-json 口径读 usage.output_tokens，camelCase 原样透传会静默丢 token 数） */
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
    usage: lastUsage?.outputTokens != null ? { output_tokens: lastUsage.outputTokens } : {},
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
    // 显式排除出 rewind 目标：item id 不是 turnId，选它做 beforeTurnId 只会让 thread/fork 失败
    // （claude 侧 readHistory 给每条消息都算好了 rewindable 布尔值，这里对齐）
    rewindable: false,
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
