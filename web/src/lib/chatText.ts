// Chat 页的纯文本/纯数据工具：状态文案、剪贴板、sidechain 消息形状转换。
// 从 pages/Chat.tsx 下沉（F1）——无组件状态、无 React 依赖，bun:test 直接钉住。

import type { HistoryMessage } from '@anyplane/protocol'
import { cliContentToHistoryBlocks } from './contentBlocks'
import type { SessionState } from '@anyplane/protocol'

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

const PHASE_LABEL: Record<string, string> = {
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
 * 块映射正本在 contentBlocks.ts（与服务端 discovery 同形）。
 * onImage 承接桶转录里的图片（codex 子线程 userMessage 的 image/localImage 已被
 * 服务端翻译成 {type:'image', url:/api/uploads/...} wire 块）——此前无承接方，图片被静默丢弃。
 */
export function cliSidechainToHistory(rec: Record<string, unknown>): HistoryMessage | null {
  const type = rec.type
  if (type !== 'assistant' && type !== 'user') return null
  const content = (rec.message as { content?: unknown } | undefined)?.content
  const blocks = cliContentToHistoryBlocks(content, {
    onImage: (c) => {
      const url = typeof c.url === 'string' ? c.url : undefined
      // 只放行本站 uploads 路径（服务端已把 localImage 解析为 /api/uploads/<hash> URL）
      return url && /^\/api\/uploads\/[0-9a-f]{16}\.(jpg|png|gif|webp)$/.test(url)
        ? { kind: 'image', src: url }
        : undefined
    },
  })
  if (blocks.length === 0) return null
  return { uuid: rec.uuid as string | undefined, role: type, blocks, timestamp: rec.timestamp as string | undefined }
}
