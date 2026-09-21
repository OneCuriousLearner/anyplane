// 接力（handoff）跨后端编排：源会话自摘要 → 目标会话播种 → 血缘落盘。
// 领域函数（播种文案/血缘 IO）在 ../lineage.ts；各后端 fork 简报在对应 port。这里只做编排与进度事件推源 Hub。

import type { BackendName } from '@anyplane/protocol'
import { backendPort, portFor, resolvedSessionKey } from '../backends/port'
import { appendLineage, seedMessage, type HandoffDetail } from '../lineage'
import { errorMessage, sanitizePath } from '../util'
import { broadcast } from './broadcast'
import { getHub, hubs } from './registry'

/** 同一 cwd+backend 的接力播种在途集合：并发 POST 复用同一 n|/xn| key，两个播种流程
 *  会进同一会话（keyForNew 是 cwd 的纯函数）。在途期间直接拒绝，避免两份简报互注 */
const sowing = new Set<string>()

/**
 * POST /api/handoff { fromKey, toBackend, detail } → 立即应答；进度事件推到 fromKey 所在 Hub：
 * handoff_pending → handoff_done { targetKey, brief } / handoff_error { message }。
 * 目标会话由服务端直接创建并播种首条消息（无需浏览器在场）。
 */
export function runHandoff(fromKey: string, toBackend: BackendName, detail: HandoffDetail): string | undefined {
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
    let targetKey: string | undefined
    try {
      // codex x| key：cwd 需要 thread/read 惰性解析——targetKey 依赖真实 cwd，
      // 必须在解析之后生成（提前用空 cwd 会得到 xn| 形状的废 key）
      const sourceCwd = src.cwd ?? (await fromPort.handoffCwdOf(fromKey, sid))
      if (!sourceCwd) throw new Error('无法确定源会话目录（thread/read 未返回 cwd）')
      const toPort = backendPort(toBackend)
      targetKey = toPort.keyForNew(sourceCwd)
      // keyForNew 是 cwd 的纯函数：目标 Hub 可能与「用户在该目录开的新会话标签页」或
      // 「上一次播种超时未重键的残留」共享——播种会复用其 spawnOpts/sessionId，简报被注进
      // 无关会话。判定「进行中」必须看存活（sessionId 存在但进程已死且无客户端的 Hub
      // 是回收前的死残留，拒绝它等于永久假阳性——没有任何用户动作能清掉它）；
      // 死残留清掉会话身份后再复用该 Hub
      const existingTarget = hubs.get(targetKey)
      if (existingTarget) {
        const alive = portFor(targetKey).hasLiveSession(targetKey)
        if (existingTarget.clients.size > 0 || (existingTarget.sessionId && alive)) {
          throw new Error('目标目录已有进行中的新会话：先关闭该标签页或等其完成首轮对话后再接力')
        }
        existingTarget.sessionId = undefined // 死残留身份清掉：否则播种续跑旧会话
        existingTarget.spawnOpts = undefined // spawnOpts 里可能带着旧 resumeSessionId
      }
      const sowKey = `${toBackend}|${targetKey}`
      if (sowing.has(sowKey)) throw new Error('同一目录已有接力在进行中，请稍候')
      sowing.add(sowKey)
      const targetHub = getHub(targetKey)
      try {
        if (sourceHub) broadcast(sourceHub, { kind: 'handoff_pending', toBackend })
        // 1. 源会话 fork 自摘要
        //    claude 源在线时走 side_question 控制通道（进程内 fork，零冷启动、不留 FORK 会话）；
        //    离线才 spawn 一次性 --fork-session --bare 进程
        const { text: brief, usage } = await fromPort.forkBriefForHandoff(fromKey, sourceCwd, sid, detail)
        if (sourceHub) broadcast(sourceHub, { kind: 'handoff_brief', brief })

        // 播种前复查：简报生成期间用户可能恰好打开了同目录新会话页——窗口虽小，
        // 复查成本一行，守住「简报不注进无关会话」的底线（存活口径同上：死残留不拦）
        const raced = hubs.get(targetKey)
        if (raced) {
          const racedAlive = portFor(targetKey).hasLiveSession(targetKey)
          if (raced.clients.size > 0 || (raced.sessionId && racedAlive)) {
            throw new Error('目标目录已有进行中的新会话：接力取消，请稍后重试')
          }
          raced.sessionId = undefined
          raced.spawnOpts = undefined
        }

        // 2. 目标会话播种（服务端直接发送首条消息；启动失败抛错）
        const seed = seedMessage(sourceCwd, fromBackend, brief)
        const targetSessionId = await toPort.seedHandoffTarget(targetHub, seed)
        const toResolvedKey = targetSessionId ? toPort.keyForExisting(targetSessionId, sourceCwd) : undefined
        const fromResolvedKey = resolvedSessionKey(
          fromPort,
          fromKey,
          fromPort.sessionOf(fromKey)?.sessionId,
          sourceCwd,
        )

        // 播种进程/线程落在 n|/xn| key 上，而 handoff_done 导航走 resolved key：立即三层重键
        // （Hub / 进程 map / 存活 WS data.key，镜像 callbacks.ts 的 /clear 重键）。不重键的话
        // 目标页查不到播种进程——live 事件进无客户端的旧 Hub，首条用户消息还会再 spawn
        // 一个进程与播种进程同写一份 transcript。
        if (toResolvedKey && targetSessionId && toResolvedKey !== targetKey) {
          hubs.delete(targetKey)
          targetHub.key = toResolvedKey
          hubs.set(toResolvedKey, targetHub)
          portFor(toResolvedKey).rekeySession(targetHub, targetKey, toResolvedKey, targetSessionId)
          for (const ws of targetHub.clients) {
            if (!ws.data.inbox) ws.data.key = toResolvedKey
          }
        }

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
            // 目标 slug/cwd 以下发为准：源会话是 codex 时 session.slug 恒为 'codex'，
            // 前端若沿用源 slug 会把 claude 目标的历史请求打到 projects/codex/（空白）
            targetSlug: toBackend === 'codex' ? 'codex' : sanitizePath(sourceCwd),
            targetCwd: sourceCwd,
            toBackend,
            brief,
          })
      } finally {
        sowing.delete(sowKey)
      }
    } catch (e) {
      const message = errorMessage(e)
      if (sourceHub) broadcast(sourceHub, { kind: 'handoff_error', message })
      // 残留清理与 wsClose 同口径：无客户端且无存活会话句柄才摘——存活期间删 Hub
      // 会让进程回调广播进已摘出注册表的 Hub（消息黑洞）；sowing 守卫拒绝时 leftover
      // 可能是另一在途接力刚建的空 Hub，同样只在无存活时清理
      if (targetKey) {
        const leftover = hubs.get(targetKey)
        if (leftover && leftover !== sourceHub && leftover.clients.size === 0 && !portFor(targetKey).hasLiveSession(targetKey)) {
          hubs.delete(targetKey)
        }
      }
    }
  })()
  return undefined
}
