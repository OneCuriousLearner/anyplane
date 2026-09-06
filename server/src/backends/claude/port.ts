// claude 后端适配器：把 processManager/discovery 的能力包装成 BackendPort。
// 方法体多为 index.ts 原 claude 分支的逐字搬迁——重构红线是零行为改动。

import { hydratedContextOf, splitExistingKey } from './backend'
import { liveSessionInfo } from './discovery'
import { processManager } from './processManager'
import { baseStatusOf, type BackendPort, type SessionHandle, type StatusContext } from '../port'

class ClaudePort implements BackendPort {
  readonly name = 'claude' as const

  sessionOf(key: string): SessionHandle | undefined {
    return processManager.get(key)
  }

  hasLiveSession(key: string): boolean {
    return !!processManager.get(key)
  }

  notifyExternalGate(key: string): void {
    processManager.get(key)?.notifyExternalGate()
  }

  statusOf(key: string, cx: StatusContext): Record<string, unknown> {
    const s = processManager.get(key)
    const hub = cx.hub
    const pending = hub?.pendingApprovals.size ?? 0
    // 未被本服务 spawn 的会话：读 pid 文件，把外部 CLI 的实时状态反映到 busy/waiting
    let live: { status: string; pid: number } | undefined
    if (!s || s.exited) {
      const ek = splitExistingKey(key)
      if (ek) live = cx.liveHint === undefined ? liveSessionInfo(ek.sessionId) : (cx.liveHint ?? undefined)
    }
    const waiting = (s?.waiting ?? false) || pending > 0 || live?.status === 'waiting'
    const st = baseStatusOf(s, hub, waiting)
    if (live?.status === 'busy') st.busy = true // 审批等待与外部进程 busy 都算 busy，防止误回收
    // 离线/未 spawn 水合：直读 transcript 尾部，点开会话即有上下文环形（无需先发消息）；
    // live 值存在时恒优先（spawn 内水合与实时跟踪是同源数据的更新版）
    if (cx.hydrateContext && st.context == null) st.context = hydratedContextOf(key)
    return {
      ...st,
      activeTaskCount: s?.activeTaskCount ?? 0,
      activeTasks: s?.backgroundTasks ?? [],
      slashCommands: s?.slashCommands,
      // spawnOpts.model 是用户显式选择（未 spawn 时的待应用值）；initModel 是进程 init 报告的解析后 ID。
      // 后者让重连 attach 的页面不必等下一轮就能显示模型（StatusPill 再经 modelNames 映射成配置名）
      model: hub?.spawnOpts?.model ?? s?.initModel,
      tailing: !!hub?.tailer,
      liveStatus: live?.status,
      goal: hub?.goal ?? null,
    }
  }
}

export const claudePort = new ClaudePort()
