// 列表分诊的纯函数核：组间「需要我」上浮 + 合并组的组内分段。
// 渲染层（SessionList/SessionGroupList）只做映射，排序与分段规则全部在这里（可测）。

import type { SessionInfo } from '@anyplane/protocol'
import { STATUS_META } from '../components/listChrome'

/** 行状态档（B2 决策）：waiting > 主线忙 > N 个后台任务 > 空闲/离线。
 *  注意 busy 的口径：managed.busy 的 getter 把后台任务也算进去（activeTasks>0 → true），
 *  主线其实已空闲——「在后台干活」因此必须用 sessionState==='running/requires_action'
 *  判定主线忙，否则后台任务档永远不出现（实测发现）。codex 无 activeTaskCount，天然不命中 */
export function rowStatusOf(s: SessionInfo): { key: string; cls: string; label: string } {
  if (s.managed.waiting) return { key: 'waiting', ...STATUS_META.waiting }
  const mainBusy = s.managed.busy && (s.managed.sessionState === 'running' || s.managed.sessionState === 'requires_action')
  if (mainBusy) return { key: 'busy', ...STATUS_META.busy }
  const tasks = s.managed.activeTaskCount ?? 0
  if (tasks > 0) return { key: 'tasks', cls: 'bg-ok', label: `${tasks} 个后台任务` }
  const stKey = s.managed.spawned ? 'idle' : s.status
  const st = STATUS_META[stKey] ?? STATUS_META.offline
  return { key: stKey, ...st }
}

/** 分组键归一：worktreeOf（readGitInfo 推导，正斜杠）与 cwd（会话创建时录入，Windows 反
 *  斜杠）必须同一口径才能落进同一组——不归一会出现两个同名组（实测发现）。
 *  统一正斜杠 + 去尾斜杠；展示层 dirBasename 两种分隔符都切，不受影响 */
export function normPathKey(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/+$/, '')
}

/** 组间排序：有 waiting 行的组整体浮到列表最前（组间再按各自 max mtime 降序），其余组
 *  按 max mtime 降序——「需要我」压过「正在输出」（09-27 问题 3；Codex agents 仪表盘的
 *  Need input 优先同旨）。原地不修改输入。 */
export function orderGroupsForTriage<K>(entries: Array<[K, SessionInfo[]]>): Array<[K, SessionInfo[]]> {
  const maxMtime = (list: SessionInfo[]) => Math.max(0, ...list.map((s) => s.mtime))
  const hasWaiting = (list: SessionInfo[]) => list.some((s) => s.managed.waiting)
  const byMtime = (a: [K, SessionInfo[]], b: [K, SessionInfo[]]) => maxMtime(b[1]) - maxMtime(a[1])
  const waiting = entries.filter(([, list]) => hasWaiting(list)).sort(byMtime)
  const rest = entries.filter(([, list]) => !hasWaiting(list)).sort(byMtime)
  return [...waiting, ...rest]
}

/** 合并组的组内分段：主目录条目 → 各 worktree 子节（子节按各自 max mtime 降序）。
 *  钉顶行（waiting/选中）由渲染层先行摘出，传入本函数的应是剩余行。
 *  子节顺序在钉顶之后渲染；主目录段恒在最前（key 对应的真实目录）。 */
export interface RowSegment {
  /** 主目录段为 undefined；worktree 子节为该 worktree 的目录路径 */
  cwd?: string
  branch?: string
  rows: SessionInfo[]
}

export function segmentRowsByCwd(groupKey: string, rows: SessionInfo[]): RowSegment[] {
  const key = normPathKey(groupKey)
  const main = rows.filter((s) => normPathKey(s.cwd ?? '') === key || !s.worktreeOf)
  const wt = new Map<string, SessionInfo[]>()
  for (const s of rows) {
    if (!s.worktreeOf || normPathKey(s.cwd ?? '') === key) continue
    const k = s.cwd ?? s.slug
    const arr = wt.get(k)
    if (arr) arr.push(s)
    else wt.set(k, [s])
  }
  const segments: RowSegment[] = main.length > 0 ? [{ rows: main }] : []
  const wtSegments: RowSegment[] = [...wt.entries()].map(([cwd, list]) => ({
    cwd,
    branch: list.find((s) => s.gitBranch)?.gitBranch,
    rows: list,
  }))
  const maxMtime = (seg: RowSegment) => Math.max(0, ...seg.rows.map((s) => s.mtime))
  wtSegments.sort((a, b) => maxMtime(b) - maxMtime(a))
  return [...segments, ...wtSegments]
}
