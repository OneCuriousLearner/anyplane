// 接力（handoff）跨后端编排：源会话自摘要 → 目标会话播种 → 血缘落盘。
// 领域函数（简报生成/播种文案/血缘 IO）在 ../handoff.ts；这里只做编排与进度事件推源 Hub。

import { keyFor, keyForNew } from '../backends/claude/backend'
import { sanitizePath } from '../backends/claude/discovery'
import { keyForNew as codexKeyForNew } from '../backends/codex/backend'
import { portFor } from '../backends/port'
import { appendLineage, seedMessage, type HandoffDetail } from '../handoff'
import { errorMessage } from '../util'
import { broadcast } from './broadcast'
import { getHub, hubs } from './registry'

/**
 * POST /api/handoff { fromKey, toBackend, detail } → 立即应答；进度事件推到 fromKey 所在 Hub：
 * handoff_pending → handoff_done { targetKey, brief } / handoff_error { message }。
 * 目标会话由服务端直接创建并播种首条消息（无需浏览器在场）。
 */
export function runHandoff(fromKey: string, toBackend: 'claude' | 'codex', detail: HandoffDetail): string | undefined {
  const sourceHub = hubs.get(fromKey)
  const fromPort = portFor(fromKey)
  const fromBackend = fromPort.name
  if (fromBackend === toBackend) return '接力目标必须与源会话是不同后端'

  // 源解析：cwd + 会话 id（codex 的 x| key 不含 cwd，需在异步路径里惰性解析）
  const src = fromPort.handoffSource(fromKey)
  if (fromBackend === 'claude' && !src.cwd) return '无法确定源会话目录'
  if (!src.sourceId) return '源会话还没有任何消息，无法接力'

  const sid = src.sourceId
  void (async () => {
    try {
      // codex x| key：cwd 需要 thread/read 惰性解析
      const sourceCwd = src.cwd ?? (await fromPort.handoffCwdOf(fromKey, sid))
      if (!sourceCwd) throw new Error('无法确定源会话目录（thread/read 未返回 cwd）')
      if (sourceHub) broadcast(sourceHub, { kind: 'handoff_pending', toBackend })
      // 1. 源会话 fork 自摘要
      //    claude 源在线时走 side_question 控制通道（进程内 fork，零冷启动、不留 FORK 会话）；
      //    离线才 spawn 一次性 --fork-session --bare 进程
      const { text: brief, usage } = await fromPort.forkBriefForHandoff(fromKey, sourceCwd, sid, detail)
      if (sourceHub) broadcast(sourceHub, { kind: 'handoff_brief', brief })

      // 2. 目标会话播种（服务端直接发送首条消息；启动失败抛错）
      const targetKey = toBackend === 'codex' ? codexKeyForNew(sourceCwd) : keyForNew(sourceCwd)
      const targetHub = getHub(targetKey)
      const seed = seedMessage(sourceCwd, fromBackend, brief)
      const targetSessionId = await portFor(targetKey).seedHandoffTarget(targetHub, seed)
      const toResolvedKey =
        toBackend === 'codex'
          ? targetSessionId
            ? `x|${targetSessionId}`
            : undefined
          : targetSessionId
            ? keyFor(sanitizePath(sourceCwd), targetSessionId)
            : undefined
      const fromResolvedKey = (() => {
        if (fromBackend === 'claude') {
          if (fromKey.startsWith('s|')) return fromKey
          const sidNow = fromPort.sessionOf(fromKey)?.sessionId
          return sidNow ? keyFor(sanitizePath(sourceCwd), sidNow) : undefined
        }
        if (fromKey.startsWith('x|')) return fromKey
        const tidNow = fromPort.sessionOf(fromKey)?.sessionId
        return tidNow ? `x|${tidNow}` : undefined
      })()

      // 3. 血缘
      appendLineage({
        id: `ho-${Date.now().toString(36)}`,
        at: new Date().toISOString(),
        fromKey,
        toKey: targetKey,
        fromResolvedKey,
        toResolvedKey,
        fromBackend,
        toBackend,
        cwd: sourceCwd,
        detail,
        brief,
        briefUsage: usage,
      })
      if (sourceHub)
        broadcast(sourceHub, {
          kind: 'handoff_done',
          targetKey: toResolvedKey ?? targetKey,
          targetSessionId,
          toBackend,
          brief,
        })
    } catch (e) {
      const message = errorMessage(e)
      if (sourceHub) broadcast(sourceHub, { kind: 'handoff_error', message })
    }
  })()
  return undefined
}
