// Hub 模型与 WS 数据面的共享类型：纯类型模块，零运行时依赖。
// （原本定义在 index.ts；S2 拆出后这里是唯一正本，backends/port.ts 也 type-import 这里。）
// InboxEvent 是前后端共享契约，正本在 @anyplane/protocol（含 snapshot 变体——
// 历史上本模块只声明 4 种而 push/inbox.ts 运行时发第 5 种，漂移即由此类双正本产生）。

import type { ServerWebSocket } from 'bun'
import type { TranscriptTailer } from '../backends/claude/tailer'
import type { SpawnOptions } from '../backends/types'
import type { CliRingSlot } from '../cliReplay'

export interface PendingApproval {
  requestId: string
  toolName: string
  input: unknown
}

interface WSDataSession {
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

  // ---------- 补发基础设施（懒初始化，非状态位） ----------
  /** 下行 cli 事件的单调序号（重连补发用，见 cliReplay.ts） */
  cliSeq?: number
  /** 最近 CLI_RING_CAP 条可落盘 cli 事件的环形缓冲（不含 stream_event） */
  cliRing?: CliRingSlot[]

  // ---------- 启动偏好（attach/控制消息缓存；spawn 后保留为当前选择的记录） ----------
  /** 未 spawn 时缓存启动偏好；已 spawn 时记录当前选择，供 UI 重连恢复 */
  spawnOpts?: Partial<SpawnOptions>
  /** 除 effort 外、需要在进程启动后按顺序写入 stdin 的环境变量 */
  pendingEnv?: Record<string, string>

  // ---------- 过渡守卫（互斥，判别联合） ----------
  /** 会话级过渡操作，任一时刻至多一个——rewind 与 rekey 同真是非法组合
   * （ rewinding 期间 user 消息被 rewindBusy 拒，/clear 无从触发；本类型让非法组合
   *  不可表达，取代此前 rewindPending/pendingRekey 两个独立布尔）。
   *  rewind：回滚进行中（拒新 user 消息与 rewind_files 竞争；SessionState.rewindPending 镜像它）；
   *  rekey：/clear 的 conversation_reset 已到，等紧随的 init 完成 Hub 三层重键。 */
  transition?: { kind: 'rewind' } | { kind: 'rekey' }

  // ---------- tail 外部会话（与 spawn 互斥由 startTailer 守卫） ----------
  /** 未 spawn 时对 transcript JSONL 的实时跟踪（外部运行中的会话） */
  tailer?: TranscriptTailer
  /** tail 状态推送的节流时间戳 */
  tailStatusAt?: number

  // ---------- 会话身份与标题（init 驱动） ----------
  /** 当前目标（claude /goal 由出站消息解析跟踪；codex 由 thread/goal/* 通知驱动） */
  goal?: { condition: string; since: number }
  /** 当前会话的 sessionId（每次 system/init 更新；/clear 重键后是新值） */
  sessionId?: string
  /** 已为哪个 sessionId 生成过 AI 标题（按会话去重，/clear 后的新会话自然再触发一次） */
  titleGeneratedFor?: string
  /** 首条 user 消息原文（标题素材）：init 未到时先记账，maybeGenerateTitle 两路触发 */
  pendingTitleText?: string

  // ---------- 显示缓存 ----------
  /** sessionNameOf 的 s|/x| key cwd 缓存：反查（listSessions / CodexSession.cwd）至多一次（'' = 已查过、未知） */
  nameCwd?: string
}
