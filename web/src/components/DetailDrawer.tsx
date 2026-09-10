// 会话详情抽屉：tab 头（context 用量 / MCP 状态 / 设置）+ 结构化面板 + 原始 JSON 兜底。
// F2 从 pages/Chat.tsx 逐字切出——纯展示组件；查询由 onRunQuery 回调发回组合层
//（query_result 应答在 Chat 的 WS 分发里落到 detailContent/mcpServers/contextData/settingsData）。

import { resolveModel, type TierModelName } from '../lib/api'
import { fmtTokens } from '../lib/blocks'

/** claude mcp_status 应答里的单个服务器（buildMcpServerStatuses 形状） */
export interface McpServerInfo {
  name: string
  /** connected / failed / disabled / pending / needs-auth 等（CLI 的 connection.type 直出） */
  status: string
  error?: string
  config?: { type?: string; command?: string; args?: string[]; url?: string }
  scope?: string
  tools?: { name: string }[]
}

/** claude get_context_usage 应答的取用子集（analyzeContext 的 ContextData 里我们渲染的部分） */
export interface ContextDataLite {
  categories: { name: string; tokens: number; isDeferred?: boolean }[]
  totalTokens: number
  maxTokens: number
  percentage: number
  model?: string
}

/** claude get_settings 应答的取用子集（settings 全量不枚举——applied + sources 概览 + 原始 JSON 折叠） */
export interface SettingsDataLite {
  applied?: { model?: string; effort?: string | null }
  sources?: { source: string; settings: Record<string, unknown> }[]
}

export function DetailDrawer(props: {
  detailTitle: string
  detailContent: string
  isCodex: boolean
  mcpServers: McpServerInfo[] | null
  mcpBusy: string | null
  onMcpAction: (serverName: string, action: 'mcp_reconnect' | 'mcp_toggle', enabled?: boolean) => void
  contextData: ContextDataLite | null
  settingsData: SettingsDataLite | null
  modelNames: Record<string, TierModelName> | null
  onRunQuery: (query: string, title: string) => void
  onClose: () => void
}) {
  const {
    detailTitle,
    detailContent,
    isCodex,
    mcpServers,
    mcpBusy,
    onMcpAction,
    contextData,
    settingsData,
    modelNames,
    onRunQuery,
    onClose,
  } = props
  return (
    <div className="px-3 py-2">
      <div className="mb-1.5 flex items-center gap-2 font-mono text-[11px]">
        <span className="text-muted">{detailTitle}</span>
        {/* codex 只有 mcp_status 有对应物（mcpServerStatus/list）；context/设置是 claude 控制请求 */}
        {(isCodex ? (['mcp_status'] as const) : (['get_context_usage', 'mcp_status', 'get_settings'] as const)).map((q) => (
          <button
            key={q}
            className="rounded-full bg-surface px-2.5 py-1 text-[10px] text-faint hover:text-ink"
            onClick={() =>
              onRunQuery(q, q === 'get_context_usage' ? 'context 用量' : q === 'mcp_status' ? 'MCP 状态' : '设置')
            }
          >
            {q === 'get_context_usage' ? 'context' : q === 'mcp_status' ? 'MCP' : '设置'}
          </button>
        ))}
        <button className="ml-auto text-faint hover:text-muted" onClick={onClose}>
          ✕
        </button>
      </div>
      {detailTitle === 'MCP 状态' && !isCodex && mcpServers ? (
        /* claude MCP 管理面板：状态 + 重连/启停（toggle 持久化到 settings，与 TUI 同语义） */
        <div className="max-h-56 overflow-auto rounded-[14px] bg-surface p-2.5">
          {mcpServers.length === 0 && (
            <div className="py-1 font-mono text-[10px] text-faint">无 MCP 服务器（在 claude 配置里添加后出现）</div>
          )}
          {mcpServers.map((srv) => {
            const meta =
              srv.status === 'connected'
                ? { dot: 'bg-ok', label: '已连接' }
                : srv.status === 'failed'
                  ? { dot: 'bg-danger', label: '失败' }
                  : srv.status === 'disabled'
                    ? { dot: 'bg-faint', label: '已禁用' }
                    : { dot: 'bg-wait', label: srv.status }
            const configLine = srv.config?.url
              ? srv.config.url
              : srv.config?.command
                ? `${srv.config.command} ${(srv.config.args ?? []).join(' ')}`.trim()
                : (srv.config?.type ?? '')
            const reconnecting = mcpBusy === `${srv.name}:mcp_reconnect`
            const toggling = mcpBusy === `${srv.name}:mcp_toggle`
            return (
              <div key={srv.name} className="flex items-center gap-2 py-1">
                <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${meta.dot}`} />
                <div className="min-w-0 flex-1">
                  <div className="font-mono text-[11px] text-ink">
                    {srv.name}
                    <span className="text-faint">
                      {' '}
                      {meta.label}
                      {srv.status === 'connected' && srv.tools ? ` · ${srv.tools.length} 工具` : ''}
                      {srv.scope ? ` · ${srv.scope}` : ''}
                    </span>
                  </div>
                  {configLine && <div className="truncate font-mono text-[10px] text-faint">{configLine}</div>}
                  {srv.error && <div className="truncate font-mono text-[10px] text-danger">{srv.error}</div>}
                </div>
                <button
                  className="shrink-0 rounded-full bg-surface2 px-2.5 py-1 font-mono text-[10px] text-faint hover:text-ink disabled:opacity-40"
                  disabled={!!mcpBusy || srv.status === 'disabled'}
                  title="重新连接（mcp_reconnect）"
                  onClick={() => onMcpAction(srv.name, 'mcp_reconnect')}
                >
                  {reconnecting ? '…' : '重连'}
                </button>
                <button
                  className="shrink-0 rounded-full bg-surface2 px-2.5 py-1 font-mono text-[10px] text-faint hover:text-ink disabled:opacity-40"
                  disabled={!!mcpBusy}
                  title={srv.status === 'disabled' ? '启用并连接（写入 settings）' : '禁用并断开（写入 settings）'}
                  onClick={() => onMcpAction(srv.name, 'mcp_toggle', srv.status === 'disabled')}
                >
                  {toggling ? '…' : srv.status === 'disabled' ? '启用' : '禁用'}
                </button>
              </div>
            )
          })}
        </div>
      ) : detailTitle === 'context 用量' && !isCodex && contextData ? (
        /* claude context 结构化：总量条 + 分类占比（deferred 类别淡显） */
        <div className="max-h-56 overflow-auto rounded-[14px] bg-surface p-2.5">
          <div className="mb-1.5 flex items-baseline justify-between font-mono text-[11px] text-ink">
            <span>
              {fmtTokens(contextData.totalTokens)} / {fmtTokens(contextData.maxTokens)} tok ·{' '}
              {contextData.percentage.toFixed(1)}%
            </span>
            {contextData.model && (
              <span className="text-[10px] text-faint">
                {resolveModel(modelNames, contextData.model).label}
              </span>
            )}
          </div>
          <div className="mb-2 h-1 overflow-hidden rounded-full bg-surface2">
            <div
              className="h-full bg-ink/60"
              style={{ width: `${Math.min(100, contextData.percentage)}%` }}
            />
          </div>
          {contextData.categories.map((c) => (
            <div key={c.name} className={`flex items-center gap-2 py-0.5 ${c.isDeferred ? 'opacity-50' : ''}`}>
              <span className="w-28 shrink-0 truncate font-mono text-[10px] text-muted" title={c.name}>
                {c.name}
              </span>
              <div className="h-1 flex-1 overflow-hidden rounded-full bg-surface2">
                <div
                  className={`h-full ${c.isDeferred ? 'bg-faint' : 'bg-muted'}`}
                  style={{
                    width: `${Math.min(100, (c.tokens / Math.max(1, contextData.maxTokens)) * 100)}%`,
                  }}
                />
              </div>
              <span className="w-12 shrink-0 text-right font-mono text-[10px] text-faint">
                {fmtTokens(c.tokens)}
              </span>
            </div>
          ))}
        </div>
      ) : detailTitle === '设置' && !isCodex && settingsData ? (
        /* claude 设置轻结构：生效值 + 来源概览；全量设置不枚举，原始 JSON 折叠兜底 */
        <div className="max-h-56 overflow-auto rounded-[14px] bg-surface p-2.5">
          {settingsData.applied && (
            <div className="mb-1.5 font-mono text-[11px] text-ink">
              当前生效：
              <span className="text-muted">
                {settingsData.applied.model == null ? 'default' : resolveModel(modelNames, settingsData.applied.model).label}
              </span>
              <span className="text-faint"> · effort {settingsData.applied.effort ?? '默认'}</span>
            </div>
          )}
          {(settingsData.sources ?? []).map((s) => (
            <div key={s.source} className="flex items-center gap-2 py-0.5 font-mono text-[10px]">
              <span className="text-muted">{s.source}</span>
              <span className="text-faint">{Object.keys(s.settings ?? {}).length} 项</span>
            </div>
          ))}
          <details className="mt-1.5">
            <summary className="cursor-pointer font-mono text-[10px] text-faint hover:text-muted">
              原始 JSON
            </summary>
            <pre className="mt-1 max-h-40 overflow-auto rounded-[10px] bg-bg/60 p-2 font-mono text-[10px] whitespace-pre-wrap text-muted">
              {detailContent}
            </pre>
          </details>
        </div>
      ) : (
        <pre className="max-h-56 overflow-auto rounded-[14px] bg-surface p-2.5 font-mono text-[10px] whitespace-pre-wrap text-muted">
          {detailContent}
        </pre>
      )}
    </div>
  )
}
