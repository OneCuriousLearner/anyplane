// codex 后端适配器：把 codexRuntime 的能力包装成 BackendPort。
// 方法体多为 index.ts 原 codex 分支的逐字搬迁——重构红线是零行为改动。

import { baseStatusOf, type BackendPort, type SessionHandle, type StatusContext } from '../port'
import { codexRuntime } from './runtime'

class CodexPort implements BackendPort {
  readonly name = 'codex' as const

  sessionOf(key: string): SessionHandle | undefined {
    return codexRuntime.get(key)
  }

  hasLiveSession(key: string): boolean {
    const s = codexRuntime.get(key)
    return !!s && !s.exited
  }

  // 外部门禁（control.sock 生态）是 claude-only 概念；codex 无对应物
  notifyExternalGate(_key: string): void {}

  /** 与 claude 适配器的 statusOf 同形，供列表 managed 字段与 WS status 复用 */
  statusOf(key: string, cx: StatusContext): Record<string, unknown> {
    const s = codexRuntime.get(key)
    const hub = cx.hub
    const waiting = (s?.waiting ?? false) || (hub?.pendingApprovals.size ?? 0) > 0
    return {
      ...baseStatusOf(s, hub, waiting),
      // 不下发 activeTasks/activeTaskCount：codex 服务端不维护任务表，恒空数组会被
      // hydrateTasks 误读为"权威空"而在空闲时判死 live 桶；字段缺席则前端跳过水合
      model: hub?.spawnOpts?.model,
      tailing: false,
      goal: s?.goal ?? null,
    }
  }
}

export const codexPort = new CodexPort()
