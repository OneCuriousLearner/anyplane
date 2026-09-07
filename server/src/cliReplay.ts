// 下行 cli 事件补发：给可落盘事件打单调序号并留在环里，客户端重连时带 `fromSeq` 取回断线期间的部分。
//
// 为什么只缓冲 `cli`：它是唯一"错过就真没了"的流——status 是幂等快照、审批有
// replayApprovals、tail 有字节偏移，各自都有补偿路径，重复缓冲只会造成双份投递。
//
// 为什么不入环 `stream_event`：它是 token 级噪声，长流式十几秒就能挤爆环并误报缺口。
// 流式增量重连后跟 live 即可；助手快照 / user / result / system 才是补发与缺口判定的权威。
// 缺口时由前端重载历史（transcript 是事实源）。
//
// 模型对齐官方 bridge：SSE 的 `from_sequence_num` 高水位 + UUID 环去重双保险
//（claude-code src/bridge/replBridge.ts 的 lastTransportSequenceNum、
//  bridgeMessaging.ts 的 recentInboundUUIDs）。这里序号是权威、uuid 去重仍留在前端兜底。

export const CLI_RING_CAP = 500

export interface CliRingSlot {
  seq: number
  payload: Record<string, unknown>
}

export interface CliRingState {
  cliSeq?: number
  cliRing?: CliRingSlot[]
}

/** 可落盘的 cli 才入环、才占序号。stream_event 现场广播但不占环。 */
export function shouldRingCli(payload: Record<string, unknown>): boolean {
  if (payload.kind !== 'cli') return false
  const msg = payload.msg as { type?: string; partial?: boolean } | undefined
  if (msg?.type === 'stream_event') return false
  // codex 工具输出的部分结果（partial tool_result）：高频增量，与 stream_event 同理不占环——
  // 重连由终态 tool_result（aggregatedOutput 权威全文）兜底，环位留给可落盘事件
  if (msg?.partial === true) return false
  return true
}

export function pushCliRing(state: CliRingState, payload: Record<string, unknown>): number | undefined {
  if (!shouldRingCli(payload)) return undefined
  state.cliSeq = (state.cliSeq ?? 0) + 1
  const seq = state.cliSeq
  payload.seq = seq
  const ring = (state.cliRing ??= [])
  ring.push({ seq, payload })
  if (ring.length > CLI_RING_CAP) ring.splice(0, ring.length - CLI_RING_CAP)
  return seq
}

/** 把环里 seq > fromSeq 的 cli 事件交给 send。
 *  返回是否发生了「缺口」——请求的起点已被环挤掉，客户端需要重载历史才能补全。 */
export function replayCliSince(state: CliRingState, fromSeq: number, send: (payload: unknown) => void): boolean {
  const ring = state.cliRing ?? []
  if (ring.length === 0) return false
  const gap = ring[0].seq > fromSeq + 1
  for (const e of ring) if (e.seq > fromSeq) send({ ...e.payload, replay: true })
  return gap
}
