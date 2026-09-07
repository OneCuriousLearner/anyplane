// Hub 模型与 WS 数据面的共享类型：纯类型模块，零运行时依赖。
// （原本定义在 index.ts；S2 拆出后这里是唯一正本，backends/port.ts 也 type-import 这里。）

import type { ServerWebSocket } from 'bun'
import type { TranscriptTailer } from '../backends/claude/tailer'
import type { SpawnOptions } from '../backends/types'

export interface PendingApproval {
  requestId: string
  toolName: string
  input: unknown
}

export interface WSDataSession {
  key: string
  inbox?: never
  /** 下行保活定时器（见 hub/socket.ts 注释） */
  keepalive?: ReturnType<typeof setInterval>
}

export interface WSDataInbox {
  inbox: true
  key?: never
  keepalive?: ReturnType<typeof setInterval>
}

export type WSData = WSDataSession | WSDataInbox

export interface Hub {
  key: string
  clients: Set<ServerWebSocket<WSData>>
  pendingApprovals: Map<string, PendingApproval>
  /** 下行 cli 事件的单调序号（重连补发用，见 cliReplay.ts） */
  cliSeq?: number
  /** 最近 CLI_RING_CAP 条可落盘 cli 事件的环形缓冲（不含 stream_event） */
  cliRing?: Array<{ seq: number; payload: Record<string, unknown> }>
  /** 未 spawn 时缓存启动偏好；已 spawn 时记录当前选择，供 UI 重连恢复 */
  spawnOpts?: Partial<SpawnOptions>
  /** 除 effort 外、需要在进程启动后按顺序写入 stdin 的环境变量 */
  pendingEnv?: Record<string, string>
  /** 组合回滚正在等待 rewind_files 的 CLI 确认，期间禁止再切断当前会话。 */
  rewindPending?: boolean
  /** 未 spawn 时对 transcript JSONL 的实时跟踪（外部运行中的会话） */
  tailer?: TranscriptTailer
  /** tail 状态推送的节流时间戳 */
  tailStatusAt?: number
  /** 当前目标（claude /goal 由出站消息解析跟踪；codex 由 thread/goal/* 通知驱动） */
  goal?: { condition: string; since: number }
  /** /clear 触发的对话重置：conversation_reset 到达后置位，紧随的 init 完成 Hub 重键 */
  pendingRekey?: boolean
  /** 当前会话的 sessionId（每次 system/init 更新；/clear 重键后是新值） */
  sessionId?: string
  /** 已为哪个 sessionId 生成过 AI 标题（按会话去重，/clear 后的新会话自然再触发一次） */
  titleGeneratedFor?: string
  /** 首条 user 消息原文（标题素材）：init 未到时先记账，maybeGenerateTitle 两路触发 */
  pendingTitleText?: string
  /** sessionNameOf 的 s|/x| key cwd 缓存：反查（listSessions / CodexSession.cwd）至多一次（'' = 已查过、未知） */
  nameCwd?: string
}

/** 全局收件箱（/ws/inbox）的事件种类：跨会话审批/完成/错误汇总 */
export type InboxEvent =
  | { type: 'approval'; key: string; requestId: string; toolName: string; input: unknown }
  | { type: 'approval_resolved'; key: string; requestId: string }
  | { type: 'done'; key: string; ok: boolean }
  | { type: 'error'; key: string; message: string }
