// Claude Code stream-json NDJSON 协议类型（精简版，依据 v2.1.88 快照
// src/entrypoints/sdk/coreSchemas.ts 与 controlSchemas.ts 重写）。
// 原则：宽松解析，未知字段/未知 type 一律透传，保证官方 CLI 升级后不崩。

// ---------- stdin（我们 → CLI） ----------

export interface UserMessageInput {
  type: 'user'
  message: { role: 'user'; content: string | unknown[] }
  parent_tool_use_id: null
  session_id?: string
  uuid?: string
  priority?: 'now' | 'next' | 'later'
}

export type ControlRequestSubtype =
  | 'interrupt'
  | 'set_permission_mode'
  | 'set_model'
  | 'set_max_thinking_tokens'
  | 'rewind_files'
  | 'mcp_status'
  | 'get_settings'
  // 进程内侧问（2.1.220 实测可用）：复用对话上下文与 prompt cache，不产生 FORK 会话
  | 'side_question'

export interface ControlRequestInput {
  type: 'control_request'
  request_id: string
  request: { subtype: ControlRequestSubtype; [k: string]: unknown }
}

export interface ControlResponseInput {
  type: 'control_response'
  response:
    | { subtype: 'success'; request_id: string; response?: Record<string, unknown> }
    | { subtype: 'error'; request_id: string; error: string }
}

export interface UpdateEnvInput {
  type: 'update_environment_variables'
  variables: Record<string, string>
}

export type StdinMessage =
  | UserMessageInput
  | ControlRequestInput
  | ControlResponseInput
  | UpdateEnvInput
  | { type: 'keep_alive' }

// ---------- stdout（CLI → 我们） ----------
// 全部宽松处理：只识别我们关心的字段，其余原样转发给浏览器。

export interface CliMessage {
  type: string
  subtype?: string
  session_id?: string
  uuid?: string
  message?: unknown
  request_id?: string
  request?: { subtype: string; [k: string]: unknown }
  response?: unknown
  [k: string]: unknown
}

// ---------- 便捷构造函数 ----------

let reqCounter = 0
export function nextRequestId(): string {
  return `ccr-${Date.now().toString(36)}-${++reqCounter}`
}

export function userMessage(
  text: string,
  priority?: 'now' | 'next' | 'later',
  images?: Array<{ mediaType: string; dataBase64: string }>,
): UserMessageInput {
  // 图片走 Anthropic API 原生 content block（media_type 必须 snake_case——stdin 路径不做 camelCase 转换）
  const content: string | unknown[] = images?.length
    ? [
        ...images.map((img) => ({
          type: 'image',
          source: { type: 'base64', media_type: img.mediaType, data: img.dataBase64 },
        })),
        ...(text.trim() ? [{ type: 'text', text }] : []),
      ]
    : text
  return {
    type: 'user',
    message: { role: 'user', content },
    parent_tool_use_id: null,
    ...(priority ? { priority } : {}),
  }
}

export function controlRequest(
  subtype: ControlRequestSubtype,
  extra: Record<string, unknown> = {},
): ControlRequestInput {
  return { type: 'control_request', request_id: nextRequestId(), request: { subtype, ...extra } }
}

export function approvalResponse(
  requestId: string,
  decision: { behavior: 'allow'; updatedInput?: unknown } | { behavior: 'deny'; message?: string },
): ControlResponseInput {
  return {
    type: 'control_response',
    response: { subtype: 'success', request_id: requestId, response: decision as Record<string, unknown> },
  }
}

// ---------- 类型守卫 ----------

/** CLI 主动发来的控制请求（最常见：can_use_tool 权限询问） */
export function isCliControlRequest(m: CliMessage): boolean {
  return m.type === 'control_request' && typeof m.request_id === 'string' && !!m.request
}

/** CLI 对我们控制请求的应答 */
export function isControlResponse(m: CliMessage): boolean {
  return m.type === 'control_response' && !!m.response
}

export function isInitMessage(m: CliMessage): boolean {
  return m.type === 'system' && m.subtype === 'init'
}

export function isResultMessage(m: CliMessage): boolean {
  return m.type === 'result'
}

export function isSessionStateChanged(m: CliMessage): boolean {
  return m.type === 'system' && m.subtype === 'session_state_changed'
}

/**
 * Claude Code 有少数内部事件以 type:user 写入 transcript/stream：最典型是
 * 后台 Agent 的 <task-notification>。它们不是浏览器用户输入，不应进入主抄本
 * 或 rewind 目标。保留真正的 tool_result，由前端与对应 tool_use 配对显示。
 */
export function isInternalUserMessage(m: CliMessage): boolean {
  if (m.type !== 'user') return false
  if (m.isMeta === true || m.isSynthetic === true) return true

  const origin = m.origin
  if (origin && typeof origin === 'object' && (origin as { kind?: unknown }).kind === 'task-notification') return true

  const content = (m.message as { content?: unknown } | undefined)?.content
  const text = typeof content === 'string' ? content : undefined
  if (!text) return false

  // 老版本/某些输出路径可能不保留 isMeta 或 origin；只在整条消息全是
  // 内部 XML 包装时兜底过滤，避免误吞用户提到这些标签的正常提问。
  const withoutInternalEnvelopes = text
    .replace(/<task-notification\b[^>]*>[\s\S]*?<\/task-notification>/gi, '')
    .replace(/<system-reminder\b[^>]*>[\s\S]*?<\/system-reminder>/gi, '')
    .trim()
  return withoutInternalEnvelopes.length === 0 && /<(?:task-notification|system-reminder)\b/i.test(text)
}
