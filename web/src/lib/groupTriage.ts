// 列表分诊的纯函数核：组间「需要我」上浮 + 合并组的组内分段。
// 渲染层（SessionList/SessionGroupList）只做映射，排序与分段规则全部在这里（可测）。

import type { SessionInfo } from '@anyplane/protocol'
import { STATUS_META } from '../components/listChrome'

/** 行状态档（B2 决策）：waiting > 主线忙 > N 个后台任务 > 空闲/离线。
 *  busy 的口径：managed.busy 的 getter 把后台任务也算进去（activeTasks>0 → true），主线其实
 *  已空闲——所以任务档只在「busy 唯来自任务」（sessionState 非 running/requires_action）时
 *  顶替 busy 档；组合回滚（pendingControlRequests，CLI 不发 session_state_changed）与不发
 *  state 事件的旧 CLI（fallbackBusy）也是 busy+idle 态，必须落回「工作中」（review 轮）。
 *  codex 无 activeTaskCount，天然不命中任务档 */
export function rowStatusOf(s: SessionInfo): { key: string; cls: string; label: string } {
  if (s.managed.waiting) return { key: 'waiting', ...STATUS_META.waiting }
  const tasks = s.managed.activeTaskCount ?? 0
  if (s.managed.busy) {
    const busyIsTaskOnly = s.managed.sessionState !== 'running' && s.managed.sessionState !== 'requires_action' && tasks > 0
    if (busyIsTaskOnly) return { key: 'tasks', cls: 'bg-ok', label: `${tasks} 个后台任务` }
    return { key: 'busy', ...STATUS_META.busy }
  }
  const stKey = s.managed.spawned ? 'idle' : s.status
  const st = STATUS_META[stKey] ?? STATUS_META.offline
  return { key: stKey, ...st }
}

/** 分组键归一：worktreeOf（readGitInfo 推导，正斜杠）与 cwd（会话创建时录入，Windows 反
 *  斜杠）必须同一口径才能落进同一组——不归一会出现两个同名组（实测发现）。
 *  统一正斜杠 + 去尾斜杠；Windows 形态（盘符/UNC）再整体小写——NTFS 不区分大小写，
 *  git 输出与录入的段级大小写不一同样会劈组（与服务端 normPath 同口径）；POSIX 路径
 *  大小写敏感不动。展示层 dirBasename 两种分隔符都切，不受影响 */
export function normPathKey(path: string): string {
  const s = path.replace(/\\/g, '/').replace(/\/+$/, '')
  return /^[a-z]:\//i.test(s) || s.startsWith('//') ? s.toLowerCase() : s
}

/** 组间排序：有 waiting 行的组整体浮到列表最前（组间再按各自 max mtime 降序），其余组
 *  按 max mtime 降序——「需要我」压过「正在输出」（09-27 问题 3；Codex agents 仪表盘的
 *  Need input 优先同旨）。原地不修改输入。
 *  值形状只要求 { list }——调用方（SessionList 的分组 Map 值）直接进出，不拆包重打包 */
export function orderGroupsForTriage<K, V extends { list: SessionInfo[] }>(entries: Array<[K, V]>): Array<[K, V]> {
  const maxMtime = (v: V) => Math.max(0, ...v.list.map((s) => s.mtime))
  const hasWaiting = (v: V) => v.list.some((s) => s.managed.waiting)
  const byMtime = (a: [K, V], b: [K, V]) => maxMtime(b[1]) - maxMtime(a[1])
  const waiting = entries.filter(([, v]) => hasWaiting(v)).sort(byMtime)
  const rest = entries.filter(([, v]) => !hasWaiting(v)).sort(byMtime)
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
