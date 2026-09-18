// 后端能力的读取入口：权威在服务端适配器（SessionState.capabilities 随 status 下发），
// 前端按能力渲染（查询按钮/分叉入口），不再以 isCodex 硬编码推断——第三个后端接入时
// 前端组件零改动。
// FALLBACK_CAPABILITIES 只是「首包 status 到达前」的瞬时兜底（attach 前 state 里没有
// capabilities）；新增能力字段时兜底表与服务端适配器同加（各一行，漂移由 typecheck 拦截）。

import type { BackendCapabilities, SessionState } from '@anyplane/protocol'

export const FALLBACK_CAPABILITIES: Record<'claude' | 'codex', BackendCapabilities> = {
  claude: {
    fileCheckpoint: true,
    branch: true,
    tailer: true,
    aiTitle: true,
    externalGate: true,
    queries: ['get_context_usage', 'mcp_status', 'get_settings', 'mcp_reconnect', 'mcp_toggle'],
    modelCatalog: false,
  },
  codex: {
    fileCheckpoint: false,
    branch: false,
    tailer: false,
    aiTitle: false,
    externalGate: false,
    queries: ['mcp_status'],
    modelCatalog: true,
  },
}

/** 会话能力：已连接时信服务端下发，未连接时按后端身份兜底 */
export function capabilitiesOf(state: SessionState | undefined, isCodex: boolean): BackendCapabilities {
  return state?.capabilities ?? FALLBACK_CAPABILITIES[isCodex ? 'codex' : 'claude']
}

/** 查询按钮的展示名（query 名 → [长标题, 短标签]） */
export const QUERY_LABELS: Record<string, [string, string]> = {
  get_context_usage: ['context 用量', 'context'],
  mcp_status: ['MCP 状态', 'MCP'],
  get_settings: ['设置', '设置'],
}
