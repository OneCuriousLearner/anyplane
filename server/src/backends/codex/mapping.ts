// Codex wire → 统一形状的纯映射（无 I/O、无状态）。

import type { ApprovalDecision } from '../types'

/** claude permissionMode 或 codex 预设 → codex {approvalPolicy, sandbox}（近似映射）
 *  codex 预设（UI 原生展示）：
 *    readOnly      = read-only + on-request（只读·询问）
 *    workspace     = workspace-write + on-request（工作区·询问）
 *    workspaceAuto = workspace-write + never（工作区·免审，类比 --full-auto）
 *    fullAccess    = danger-full-access + never（完全访问）
 *  注意：sandbox 值用于 thread/start 的 kebab-case `sandbox` 字段；
 *  turn/start·settings/update 的 `sandboxPolicy` 对象是另一套 camelCase 枚举，用 sandboxPolicyOf 转换。 */
export function mapPermissionMode(mode?: string): { approvalPolicy?: string; sandbox?: string } {
  switch (mode) {
    case 'readOnly':
    case 'plan': // claude 名称的近似映射（spawnOpts 缓存/接力默认值可能带过来）
      return { approvalPolicy: 'on-request', sandbox: 'read-only' }
    case 'workspaceAuto':
    case 'acceptEdits':
    case 'auto':
      return { approvalPolicy: 'never', sandbox: 'workspace-write' }
    case 'fullAccess':
    case 'bypassPermissions':
      return { approvalPolicy: 'never', sandbox: 'danger-full-access' }
    case 'workspace':
    case 'default':
    default:
      return { approvalPolicy: 'on-request', sandbox: 'workspace-write' }
  }
}

/** kebab-case sandbox（thread/start 用）→ camelCase sandboxPolicy 对象（turn/start、settings/update 用） */
export function sandboxPolicyOf(kebab: string): Record<string, unknown> | undefined {
  const map: Record<string, string> = {
    'read-only': 'readOnly',
    'workspace-write': 'workspaceWrite',
    'danger-full-access': 'dangerFullAccess',
  }
  const type = map[kebab]
  return type ? { type } : undefined
}

/** rollout 尾部回扫出的 token 用量（与 thread/tokenUsage/updated wire 同形的 camelCase 记录，
 *  水合后直接进 CodexSession 的 lastUsage/totalUsage/modelContextWindow，getter 无需分支） */
export interface RolloutTokenCount {
  last: Record<string, number>
  total: Record<string, number>
  modelContextWindow?: number
}

/** 从 rollout 文本尾部倒序找最后一条 event_msg/token_count 记录。
 *  codex rollout 会把每次补全的 TokenUsageInfo 持久化为 token_count 事件（snake_case），
 *  而 thread/resume 不补发 tokenUsage 通知（实测）——resume 水合的唯一数据源。 */
export function extractTokenCountFromRolloutTail(text: string): RolloutTokenCount | undefined {
  const mapUsage = (u: unknown): Record<string, number> | undefined => {
    if (!u || typeof u !== 'object') return undefined
    const r = u as Record<string, unknown>
    return {
      totalTokens: Number(r.total_tokens ?? 0) || 0,
      inputTokens: Number(r.input_tokens ?? 0) || 0,
      cachedInputTokens: Number(r.cached_input_tokens ?? 0) || 0,
      cacheWriteInputTokens: Number(r.cache_write_input_tokens ?? 0) || 0,
      outputTokens: Number(r.output_tokens ?? 0) || 0,
      reasoningOutputTokens: Number(r.reasoning_output_tokens ?? 0) || 0,
    }
  }
  const lines = text.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim()
    if (!line || !line.includes('token_count')) continue
    let rec: { payload?: { type?: string; info?: Record<string, unknown> } }
    try {
      rec = JSON.parse(line) as typeof rec
    } catch {
      continue // 尾块首行可能被截断，跳过
    }
    const info = rec.payload?.type === 'token_count' ? rec.payload.info : undefined
    if (!info) continue
    const last = mapUsage(info.last_token_usage)
    if (!last) continue
    const w = Number(info.model_context_window ?? 0) || 0
    return {
      last,
      total: mapUsage(info.total_token_usage) ?? last,
      ...(w > 0 ? { modelContextWindow: w } : {}),
    }
  }
  return undefined
}

/** 侧车回插消息的 uuid：itemId（0.148+ 落盘）优先——与 live 流 committed 思考块同 id，
 *  前端 seen 去重后重连补发/终态拉取不叠加；旧数据回退 rs-<ts>-<i> 合成 id */
export function reasoningSidecarUuid(entry: { ts: number; itemId?: string }, index: number): string {
  return entry.itemId ?? `rs-${entry.ts}-${index}`
}

/** app-server 的 camelCase usage 记录 → 统一形状（缺失/非数归 0；tokenUsage 与 contextUsage 共用） */
export function mapTokenUsage(u: Record<string, number> | undefined) {
  const n = (v: unknown) => Number(v ?? 0) || 0
  return {
    inputTokens: n(u?.inputTokens),
    outputTokens: n(u?.outputTokens),
    cacheReadTokens: n(u?.cachedInputTokens),
    cacheWriteTokens: n(u?.cacheWriteInputTokens),
    reasoningTokens: n(u?.reasoningOutputTokens),
  }
}

export function mapApprovalDecision(d: ApprovalDecision): string {
  if (d.behavior === 'allow') {
    // updatedPermissions（"总是允许"）→ 会话级记住（类型上宽松透传，运行期探测）
    return (d as { updatedPermissions?: unknown }).updatedPermissions ? 'acceptForSession' : 'accept'
  }
  return 'decline'
}
