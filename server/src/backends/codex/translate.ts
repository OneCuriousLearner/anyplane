// Codex → Claude stream-json 形状翻译器。
// 策略：把 ThreadItem 生命周期翻译成前端 blocks.ts 已理解的 assistant/stream_event/
// tool_use/tool_result 序列，前端零改动渲染 Codex 会话。

import type { CliMessage } from '../claude/protocol'
import type { HistoryBlock, HistoryMessage } from '../types'
import { resolveUpload } from '../../uploads'
import { log } from '../../log'

// ---------- 通知 → CliMessage（live 流） ----------

type Params = Record<string, unknown>

export interface ThreadItem {
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
  /** hookPrompt：hook 注入的上下文片段 */
  fragments?: Array<{ text?: string; hookRunId?: string }>
  /** imageView：被查看图片的路径 */
  path?: string
  /** dynamicToolCall：工具命名空间与多模态输出、成功标记 */
  namespace?: string | null
  contentItems?: Array<{ type?: string; text?: string; imageUrl?: string; audioUrl?: string }> | null
  success?: boolean | null
  /** imageGeneration：修订后提示词、落盘路径、失败详情 */
  revisedPrompt?: string | null
  savedPath?: string
  failure?: unknown
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
  /** 见过 summaryTextDelta 的 reasoning item：summaryPartAdded 据此插入段落分隔
   * （供应商流式摘要分多段时，对齐 completed 项 reasoningText 的 join('\n\n') 口径；
   *  只发 textDelta（raw content）的供应商不会收到 summaryPartAdded，天然互斥） */
  private summaryDeltaItems = new Set<string>()

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
      case 'webSearch':
      // 以下三种同样是"调用 → 结果"形态，走同一张工具卡（官方 ThreadItem union 成员，
      // 此前落进 default 被静默丢弃：用了动态工具/生图的会话在抄本里凭空缺一块）
      case 'dynamicToolCall':
      case 'imageGeneration':
      case 'sleep': {
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
      case 'webSearch':
      case 'dynamicToolCall':
      case 'imageGeneration':
      case 'sleep': {
        const r = toolResultFromItem(item)
        return [toolResultMsg(item.id, r.text, r.isError)]
      }
      // hook 注入的上下文片段：不是模型产出也不是工具调用，作系统提示留痕
      //（否则用户看到模型行为突变却找不到原因）
      case 'hookPrompt': {
        const text = (item.fragments ?? [])
          .map((f) => f.text ?? '')
          .filter(Boolean)
          .join('\n')
        return text ? [systemText(`◎ hook 注入上下文\n${text.slice(0, 1000)}`)] : []
      }
      // 查看图片：路径即全部信息，不值一张工具卡
      case 'imageView':
        return [systemText(`◎ 查看图片：${item.path ?? '?'}`)]
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
      if (method === 'item/reasoning/summaryTextDelta') this.summaryDeltaItems.add(itemId)
      return [
        {
          type: 'stream_event',
          event: { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: String(params.delta ?? '') } },
          message: { id: itemId },
        },
      ]
    }
    // 摘要新段落开始：补段落分隔，对齐 completed 项 summary[] join('\n\n') 的成稿口径
    if (method === 'item/reasoning/summaryPartAdded' && this.summaryDeltaItems.has(itemId)) {
      return [
        {
          type: 'stream_event',
          event: { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: '\n\n' } },
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
      case 'dynamicToolCall':
        return {
          type: 'tool_use',
          id: item.id,
          name: item.namespace ? `${item.namespace}:${item.tool ?? '?'}` : (item.tool ?? 'DynamicTool'),
          input: item.arguments,
        }
      case 'imageGeneration':
        return { type: 'tool_use', id: item.id, name: 'ImageGeneration', input: { prompt: item.revisedPrompt ?? '' } }
      case 'sleep':
        return { type: 'tool_use', id: item.id, name: 'Sleep', input: { durationMs: item.durationMs ?? 0 } }
      default:
        // 未知 type 仍出卡（宽松解析原则：透传胜过丢弃），但留痕以便发现协议新增项
        log.warn(`[codex] 未识别的 ThreadItem 类型，按通用工具卡透传`, { itemType: item.type ?? '(缺失)' })
        return { type: 'tool_use', id: item.id, name: item.type ?? '?', input: {} }
    }
  }

  /**
   * 子线程（collab 子代理）item/completed → claude sidechain 形状（parent_tool_use_id = 子线程 id）。
   * 前端桶（useTaskBuckets.appendSidechain）与历史终态拉取共用 uuid 去重：
   * 与 itemsToHistory 同口径（文本/思考 uuid=item.id，工具结果 uuid=item.id-r；
   * 每轮首条 userMessage 以 turnId 为 uuid——history 的 rewindable 标记同键，见 opts.firstUserTurnId）。
   * 孙代理的 collab 工具卡以接收方线程 id 出块——前端嵌套血缘按各桶转录的工具块归属反推。
   * delta 不进桶：桶转录按 item 粒度实时已足够（思考/正文 item 完成即达，秒级）。
   */
  childItemMsgs(childThreadId: string, item: ThreadItem, opts?: { firstUserTurnId?: string }): CliMessage[] {
    if (!item.id || !item.type) return []
    const side = (msg: CliMessage): CliMessage => ({ parent_tool_use_id: childThreadId, ...msg })
    switch (item.type) {
      case 'userMessage': {
        const text = userInputBlocks(item.content)
          .filter((b) => b.kind === 'text')
          .map((b) => b.text ?? '')
          .join('\n')
          .trim()
        return text
          ? [
              side({
                type: 'user',
                uuid: opts?.firstUserTurnId ?? item.id,
                message: { role: 'user', content: [{ type: 'text', text }] },
              }),
            ]
          : []
      }
      case 'agentMessage':
      case 'plan': {
        const text = (item.text ?? '').trim()
        return text
          ? [side({ type: 'assistant', uuid: item.id, message: { role: 'assistant', content: [{ type: 'text', text: item.text }] } })]
          : []
      }
      case 'reasoning': {
        const text = reasoningText(item.summary, item.content)
        return text
          ? [side({ type: 'assistant', uuid: item.id, message: { role: 'assistant', content: [{ type: 'thinking', thinking: text }] } })]
          : []
      }
      case 'commandExecution':
      case 'fileChange':
      case 'mcpToolCall':
      case 'webSearch':
      case 'dynamicToolCall':
      case 'imageGeneration':
      case 'sleep': {
        const r = toolResultFromItem(item)
        return [
          side({ type: 'assistant', uuid: item.id, message: { role: 'assistant', content: [this.toolUseBlock(item)] } }),
          side({
            type: 'user',
            uuid: `${item.id}-r`,
            message: {
              role: 'user',
              content: [{ type: 'tool_result', tool_use_id: item.id, content: r.text, is_error: r.isError }],
            },
          }),
        ]
      }
      case 'collabAgentToolCall': {
        const receiver = (item.receiverThreadIds ?? []).filter(Boolean)[0]
        const blockId = receiver ?? item.id
        const toolUse = { ...this.toolUseBlock(item), id: blockId }
        const r = collabToolResultFromItem(item, blockId)
        return [
          side({ type: 'assistant', uuid: item.id, message: { role: 'assistant', content: [toolUse] } }),
          side({
            type: 'user',
            uuid: `${item.id}-r`,
            message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: blockId, content: r.text, is_error: r.isError }] },
          }),
        ]
      }
      // subAgentActivity 是生命周期事件（runtime 另行翻译为 task_*），不进桶转录
      case 'subAgentActivity':
      // hookPrompt/imageView/compact/review 等在主线是系统提示，桶转录里有意不进
      case 'hookPrompt':
      case 'imageView':
      case 'contextCompaction':
      case 'enteredReviewMode':
      case 'exitedReviewMode':
        return []
      default:
        // 未知 type 留痕后跳过（宽松解析红线：透传胜过丢弃，静默丢弃曾丢过五种类型）；
        // 主线（toolUseBlock）与历史（itemsToHistory）的 default 同样 warn
        log.warn('[codex] 子线程转录出现未识别 ThreadItem 类型，已跳过', { itemType: item.type })
        return []
    }
  }
}

function toolResultMsg(toolUseId: string, text: string, isError: boolean): CliMessage {
  return {
    type: 'user',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content: text, is_error: isError }] },
  }
}

/** 工具执行的流式部分结果（commandExecution/outputDelta、mcpToolCall/progress）：
 *  与终态 tool_result 同形 + `partial: true` 标记——前端更新卡片文本但保持运行态，
 *  服务端 cliRing 据此不占序号（高频增量，重连由终态结果兜底）。
 *  `append: true`（命令输出）：文本是本窗口的增量，前端**追加**到卡片现有部分文本上——
 *  全量重发会让 300ms 窗口 × 32KB 缓冲在长跑命令下放大约 100 倍下行流量；
 *  缺省（MCP 进度）是替换语义（进度是状态串，不是流）。 */
export function partialToolResultMsg(toolUseId: string, text: string, append?: boolean): CliMessage {
  return {
    type: 'user',
    partial: true,
    ...(append ? { append: true } : {}),
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content: text, is_error: false }] },
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
    case 'dynamicToolCall': {
      // contentItems 是多模态数组（inputText/inputImage/inputAudio）：取文本，其余标注类型
      const text = (item.contentItems ?? [])
        .map((c) =>
          c?.type === 'inputText' ? (c.text ?? '') : c?.type === 'inputImage' ? '（图片）' : c?.type === 'inputAudio' ? '（音频）' : '',
        )
        .filter(Boolean)
        .join('\n')
      return { text: text || `（${item.status ?? '完成'}）`, isError: item.status === 'failed' || item.success === false }
    }
    case 'imageGeneration': {
      const failed = item.status === 'failed' || !!item.failure
      if (failed) return { text: stringifyResult(item.failure ?? '生成失败'), isError: true }
      return { text: item.savedPath ? `已保存：${item.savedPath}` : stringifyResult(item.result ?? ''), isError: false }
    }
    case 'sleep':
      return { text: `等待 ${Math.round((item.durationMs ?? 0) / 1000)}s`, isError: false }
    default: // webSearch 等：结果即正文，失败态不由 item.status 表达
      return { text: stringifyResult(item.result ?? item.query ?? ''), isError: false }
  }
}

function systemText(text: string): CliMessage {
  return { type: 'system', subtype: 'status', text }
}

/** collab 子代理状态（pendingInit/running/interrupted/completed/errored/shutdown/notFound）
 *  → claude task_notification 三态；非终态返回 null 不发通知 */
function collabTerminalStatus(status?: string): 'completed' | 'failed' | 'stopped' | null {
  switch (status) {
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

/** collab 工具项的结果文本与失败标记（主线配对卡与子线程桶卡共用，blockId 为配对键） */
function collabToolResultFromItem(item: ThreadItem, blockId: string): { text: string; isError: boolean } {
  const isError = item.status === 'failed' || item.status === 'interrupted'
  const parts: string[] = [`${String(item.tool ?? '?')} → ${String(item.status ?? '?')}`]
  const receivers = (item.receiverThreadIds ?? []).filter(Boolean)
  if (receivers.length > 0) parts.push(`agents: ${receivers.length}`)
  for (const [tid, st] of Object.entries(item.agentsStates ?? {})) {
    const msg = typeof st?.message === 'string' && st.message.trim() ? `: ${st.message.slice(0, 120)}` : ''
    parts.push(`${tid.slice(0, 8)} ${String(st?.status ?? '?')}${msg}`)
  }
  return { text: parts.join('\n'), isError }
}

function collabToolResultMsg(item: ThreadItem): CliMessage {
  const r = collabToolResultFromItem(item, item.id!)
  return toolResultMsg(item.id!, r.text, r.isError)
}

/**
 * collabAgentToolCall End → 生命周期事件。
 * 只在 End 处理：Begin（inProgress）时 receiverThreadIds 为空，建了桶也无法与后续事件归并。
 * - spawnAgent 成功：task_started（桶键 = 新子线程 id，prompt 截断作描述）
 * - spawnAgent 失败/打断：无子线程 id，用 call id 建一张即终态的卡（否则失败完全不可见）
 * - 所有 End 的 agentsStates：携带各子代理终态（wait End 的报告正文在此），逐个发 task_notification；
 *   与 subAgentActivity 的终态可能重复，前端 markTerminal 幂等（仅刷新驱逐倒计时）
 * 导出给 runtime 孙代理生命周期复用（子线程内的 collab End 同样要建桶）。
 */
export function collabAgentMsgs(item: ThreadItem): CliMessage[] {
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
 * 导出给 runtime 孙代理生命周期复用。
 */
export function subAgentActivityMsgs(item: ThreadItem): CliMessage[] {
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
      // 与 live 侧（itemStarted/itemCompleted）保持同形：否则刷新页面这些卡会凭空消失，
      // 又变成"同一份转录经不同入口长得不一样"
      case 'dynamicToolCall':
        pushToolPair(
          out,
          uuid,
          {
            kind: 'tool_use',
            id: item.id,
            name: item.namespace ? `${item.namespace}:${item.tool ?? '?'}` : (item.tool ?? 'DynamicTool'),
            input: item.arguments,
          },
          item,
        )
        break
      case 'imageGeneration':
        pushToolPair(out, uuid, { kind: 'tool_use', id: item.id, name: 'ImageGeneration', input: { prompt: item.revisedPrompt ?? '' } }, item)
        break
      case 'sleep':
        pushToolPair(out, uuid, { kind: 'tool_use', id: item.id, name: 'Sleep', input: { durationMs: item.durationMs ?? 0 } }, item)
        break
      case 'hookPrompt': {
        const text = (item.fragments ?? [])
          .map((f) => f.text ?? '')
          .filter(Boolean)
          .join('\n')
        if (text) out.push({ uuid, role: 'system', blocks: [{ kind: 'text', text: `◎ hook 注入上下文\n${text.slice(0, 1000)}` }] })
        break
      }
      case 'imageView':
        out.push({ uuid, role: 'system', blocks: [{ kind: 'text', text: `◎ 查看图片：${item.path ?? '?'}` }] })
        break
      case 'contextCompaction':
        out.push({ uuid, role: 'system', subtype: 'compact_boundary', blocks: [] })
        break
      default:
        // collabAgentToolCall/subAgentActivity 走侧栏桶，主线不渲染（有意为之）；
        // 其余未知类型留痕，便于发现协议新增项
        if (item.type && item.type !== 'collabAgentToolCall' && item.type !== 'subAgentActivity') {
          log.warn('[codex] 历史里出现未识别的 ThreadItem 类型，已跳过', { itemType: item.type })
        }
        break
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
