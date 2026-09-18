// 后端能力的读取入口：唯一权威是服务端适配器的 capabilities 声明（随 status 首帧下发，
// WS open 即发），前端按能力渲染（查询按钮/分叉入口），不以 isCodex 硬编码推断。
// **不设前端兜底表**：首包到达前 capabilities 为 undefined（未知），门控 UI 隐藏——
// 兜底表按后端名键控会随服务端声明漂移（值漂移 typecheck 拦不住），且给第三个后端
// 留一个前端改动点，正是本机制要消灭的耦合。

import type { BackendCapabilities, SessionState } from '@anyplane/protocol'

/** 会话能力：undefined = 首包未到（未知），调用侧按「未知即隐藏」处理 */
export function capabilitiesOf(state: SessionState | undefined): BackendCapabilities | undefined {
  return state?.capabilities
}

/** 查询按钮的展示名（query 名 → [长标题, 短标签]）。
 *  只有出现在本表里的只读查询才渲染成详情抽屉按钮——capabilities.queries 白名单里
 *  还可能含管理动作（mcp_reconnect/mcp_toggle，供 hub 层把关放行），动作不是按钮。 */
export const QUERY_LABELS: Record<string, [string, string]> = {
  get_context_usage: ['context 用量', 'context'],
  mcp_status: ['MCP 状态', 'MCP'],
  get_settings: ['设置', '设置'],
}
