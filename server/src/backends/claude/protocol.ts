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

/**
 * **官方 SDK 类型里没有、只存在于 CLI headless（print.ts）实现里的 subtype。**
 *
 * 两条都实测可用且是核心功能的依赖（接力简报 / AI 会话标题），但它们不在
 * `@anthropic-ai/claude-agent-sdk` 的 `sdk.d.ts` 中——由 protocol.conformance.test.ts
 * 对账时发现并在此固化。
 *
 * 风险口径：**协议漂移检测覆盖不到这两项**。官方清单里既然没有它们，上游改名或
 * 移除时 check-claude-protocol.ts 不会报任何异常，只会表现为运行时功能静默失效。
 * 因此它们的回归防线只有 e2e（`e2e-handoff.ts` 走 side_question，AI 标题走 `e2e-slash.ts`），
 * 升级 CLI 后务必跑一次。
 *
 * 若哪天官方把它们收进 SDK 类型，conformance 测试会提示把该项移出本清单。
 */
export const PRINT_ONLY_SUBTYPES = [
  // 进程内侧问（2.1.220 实测可用）：复用对话上下文与 prompt cache，不产生 FORK 会话
  'side_question',
  // AI 会话标题（Haiku）：{description, persist} → {title|null}，persist 时 CLI 自写 ai-title 进 transcript
  'generate_session_title',
] as const

/** 我们会发出的 control_request subtype 全集。
 *  **写成运行时数组而非纯类型**：protocol.conformance.test.ts 要拿它与官方清单
 *  （@anthropic-ai/claude-agent-sdk 提取的 protocol-baseline.claude.json）对账——
 *  纯 type 在运行时被擦除，测不了。手抄清单最大的风险就是抄了个上游没有的名字，
 *  或上游改名后这里还留着旧的，静默失效。 */
export const CONTROL_REQUEST_SUBTYPES = [
  'interrupt',
  'set_permission_mode',
  'set_model',
  'set_max_thinking_tokens',
  'rewind_files',
  'mcp_status',
  'get_settings',
  'get_context_usage',
  // MCP 管理动作：{serverName} / {serverName, enabled}（toggle 会持久化启用态到 settings）
  'mcp_reconnect',
  'mcp_toggle',
  ...PRINT_ONLY_SUBTYPES,
] as const

export type ControlRequestSubtype = (typeof CONTROL_REQUEST_SUBTYPES)[number]

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
  // subtype 在后：extra 是参数包，绝不允许覆盖调度字段（防 extra.subtype 注入绕过服务端守卫）
  return { type: 'control_request', request_id: nextRequestId(), request: { ...extra, subtype } }
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
