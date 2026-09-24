// sessionKey 形状判断与最小 SessionInfo 构造。
// isCodexKey 与服务端 backends/port.ts 正本逐字同形（前缀判定、不预解码）；
// 编码规则与服务端 backends/claude/backend.ts、backends/codex/backend.ts 一一对应：
//   s|<slug>|<sessionId>  已存在 claude 会话
//   n|<encodeURIComponent(cwd)>  新 claude 会话
//   b|<encodeURIComponent(cwd)>|<sourceSessionId>  懒分叉（首条消息才 --fork-session）
//   x|<threadId>  已存在 codex 线程；xn|<encodeURIComponent(cwd)>  新线程

import type { SessionInfo } from '@anyplane/protocol'

export function isCodexKey(key: string): boolean {
  return key.startsWith('x|') || key.startsWith('xn|')
}

/** 已存在会话（有 transcript/线程历史可读）：s|、x|、b| */
export function isExistingKey(key: string): boolean {
  return key.startsWith('s|') || key.startsWith('x|') || key.startsWith('b|')
}

/** 与服务端 util.sanitizePath 一致：非字母数字 → '-' */
export function slugOf(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-')
}

/** key 不在会话列表时（b| 分支 / 刚归档 / 深链直达）按 key 自身编码构造最小 SessionInfo。
 *  n|/xn|（懒启动）也要兜底：懒启动窗口内刷新页面，列表里还查不到这条 key——
 *  返回 null 会被 restoreFromHash 清掉 hash 丢回列表页。
 *  编码段损坏（非法 % 转义）时返回 null，不让深链解析炸掉整个导航 */
export function sessionFromKey(key: string): SessionInfo | null {
  try {
    const managed = { spawned: false, busy: false, clients: 0 }
    const parts = key.split('|')
    if (parts[0] === 's' && parts.length === 3) {
      return { key, slug: parts[1], sessionId: parts[2], mtime: Date.now(), sizeBytes: 0, status: 'offline', backend: 'claude', managed }
    }
    if (parts[0] === 'x' && parts.length === 2) {
      return { key, slug: 'codex', sessionId: parts[1], mtime: Date.now(), sizeBytes: 0, status: 'offline', backend: 'codex', managed }
    }
    if (parts[0] === 'b' && parts.length === 3) {
      const cwd = decodeURIComponent(parts[1])
      return { key, slug: slugOf(cwd), sessionId: parts[2], cwd, mtime: Date.now(), sizeBytes: 0, status: 'offline', backend: 'claude', managed }
    }
    // 懒启动占位：sessionId 尚无（'new' 哨兵与 startNew/handoff_done 同口径）；
    // spawn 后服务端广播 moved 升键，本兜底只为刷新/深链不断链
    if (parts[0] === 'n' && parts.length === 2) {
      const cwd = decodeURIComponent(parts[1])
      if (!cwd) return null // 空 cwd 是损坏形状，还原出来也 spawn 不了
      return { key, slug: slugOf(cwd), sessionId: 'new', cwd, mtime: Date.now(), sizeBytes: 0, status: 'offline', backend: 'claude', managed }
    }
    if (parts[0] === 'xn' && parts.length === 2) {
      const cwd = decodeURIComponent(parts[1])
      if (!cwd) return null
      return { key, slug: 'codex', sessionId: 'new', cwd, mtime: Date.now(), sizeBytes: 0, status: 'offline', backend: 'codex', managed }
    }
    return null
  } catch {
    return null
  }
}
