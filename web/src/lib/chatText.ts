// Chat 页的纯文本/纯数据工具：状态文案、剪贴板、sidechain 消息形状转换。
// 从 pages/Chat.tsx 下沉（F1）——无组件状态、无 React 依赖，bun:test 直接钉住。

import type { HistoryMessage } from './api'
import { toolResultText } from './blocks'
import type { SessionState } from './ws'

/** 复制到剪贴板：clipboard API 仅在安全上下文可用，http 局域网访问走 textarea 回退 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    // 权限拒绝等 → 走回退
  }
  try {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.style.position = 'fixed'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.select()
    const ok = document.execCommand('copy')
    ta.remove()
    return ok
  } catch {
    return false
  }
}

export const PHASE_LABEL: Record<string, string> = {
  requesting: '请求中',
  compacting: '压缩上下文',
}

/** 输入行上方的会话状态文案：早退链，优先级即源码顺序。
 *  spawned 为真时不再看 exited/tailing（保持原嵌套三元的求值顺序）。 */
export function statusLineOf(
  state: SessionState,
  opts: { connected: boolean; phase?: string; waiting: boolean },
): string {
  if (!opts.connected) return '连接中…'
  if (opts.phase) return `${PHASE_LABEL[opts.phase] ?? opts.phase}…`
  if (opts.waiting) return state.tailing ? '外部会话等待操作' : '等待审批'
  const activeTaskCount = state.activeTaskCount ?? 0
  if (activeTaskCount > 0) return `${activeTaskCount} 个后台任务运行中`
  if (state.busy) return state.tailing ? '外部会话工作中' : '工作中'
  if (state.spawned) return state.sessionState === 'idle' ? 'CLI 空闲' : 'CLI 运行中'
  if (state.exited) return '进程已退出'
  if (state.tailing) return '外部会话 · 实时跟踪中'
  const hasPendingStartConfig = Boolean(state.model || state.permissionMode || state.effort)
  return hasPendingStartConfig ? '配置已保存（发送消息时启动 CLI）' : '浏览中（发送消息时启动 CLI）'
}

/**
 * 把一条实时 sidechain CLI 消息（带 parent_tool_use_id 的完整 assistant/user）转成
 * HistoryMessage 形状，使其可以复用 appendHistoryMsg 落进后台任务桶。
 * 与 discovery.entryToHistoryMessage 的块映射保持一致（text/thinking/tool_use/tool_result）。
 */
export function cliSidechainToHistory(rec: Record<string, unknown>): HistoryMessage | null {
  const type = rec.type
  if (type !== 'assistant' && type !== 'user') return null
  const content = (rec.message as { content?: unknown } | undefined)?.content
  const blocks: { kind: 'text' | 'thinking' | 'tool_use' | 'tool_result'; text?: string; name?: string; id?: string; input?: unknown; isError?: boolean }[] = []
  if (typeof content === 'string') {
    if (content.trim()) blocks.push({ kind: 'text', text: content })
  } else if (Array.isArray(content)) {
    for (const c of content as Record<string, unknown>[]) {
      if (c?.type === 'text' && typeof c.text === 'string' && c.text.trim()) blocks.push({ kind: 'text', text: c.text })
      else if (c?.type === 'thinking' && typeof c.thinking === 'string' && c.thinking.trim())
        blocks.push({ kind: 'thinking', text: c.thinking })
      else if (c?.type === 'tool_use') blocks.push({ kind: 'tool_use', name: c.name as string, id: c.id as string, input: c.input })
      else if (c?.type === 'tool_result')
        blocks.push({ kind: 'tool_result', id: c.tool_use_id as string, text: toolResultText(c.content), isError: c.is_error === true })
    }
  }
  if (blocks.length === 0) return null
  return { uuid: rec.uuid as string | undefined, role: type, blocks, timestamp: rec.timestamp as string | undefined }
}
