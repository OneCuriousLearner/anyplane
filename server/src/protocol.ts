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

export function userMessage(text: string): UserMessageInput {
  return {
    type: 'user',
    message: { role: 'user', content: text },
    parent_tool_use_id: null,
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
