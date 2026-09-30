// 组间上浮与组内分段的规则测试（渲染不掺规则，纯函数直接验）。

import { describe, expect, test } from 'bun:test'
import type { SessionInfo } from '@anyplane/protocol'
import { normPathKey, orderGroupsForTriage, rowStatusOf, segmentRowsByCwd } from './groupTriage'

function row(p: { key: string; mtime: number; cwd?: string; worktreeOf?: string; waiting?: boolean; branch?: string }): SessionInfo {
  return {
    sessionId: p.key,
    slug: 's',
    mtime: p.mtime,
    sizeBytes: 0,
    status: p.waiting ? 'waiting' : 'idle',
    backend: 'claude',
    key: p.key,
    cwd: p.cwd,
    worktreeOf: p.worktreeOf,
    gitBranch: p.branch,
    managed: { spawned: true, busy: false, waiting: p.waiting ?? false },
  } as SessionInfo
}

describe('orderGroupsForTriage（「需要我」压过「正在输出」）', () => {
  test('有 waiting 的组整体浮前，组间再按各自 max mtime 降序', () => {
    const g1 = { list: [row({ key: 'a', mtime: 300 })] } // 最新但无 waiting
    const g2 = { list: [row({ key: 'b', mtime: 100, waiting: true })] } // 旧但在等我
    const g3 = { list: [row({ key: 'c', mtime: 200, waiting: true })] }
    const out = orderGroupsForTriage([
      ['g1', g1],
      ['g2', g2],
      ['g3', g3],
    ])
    expect(out.map(([k]) => k)).toEqual(['g3', 'g2', 'g1'])
  })

  test('无 waiting 时退化为纯 max mtime 降序', () => {
    const out = orderGroupsForTriage([
      ['x', { list: [row({ key: 'a', mtime: 10 })] }],
      ['y', { list: [row({ key: 'b', mtime: 30 })] }],
    ])
    expect(out.map(([k]) => k)).toEqual(['y', 'x'])
  })
})

describe('segmentRowsByCwd（合并组分段）', () => {
  test('主目录条目在前，各 worktree 子节按 max mtime 降序；无 worktree 行全落主段', () => {
    const rows = [
      row({ key: 'm1', mtime: 100, cwd: 'D:\\proj' }),
      row({ key: 'w1', mtime: 300, cwd: 'D:\\proj-wt1', worktreeOf: 'D:\\proj', branch: 'feat-a' }),
      row({ key: 'w2', mtime: 200, cwd: 'D:\\proj-wt2', worktreeOf: 'D:\\proj', branch: 'feat-b' }),
      row({ key: 'w3', mtime: 50, cwd: 'D:\\proj-wt1', worktreeOf: 'D:\\proj', branch: 'feat-a' }),
    ]
    const segs = segmentRowsByCwd('D:\\proj', rows)
    expect(segs.map((s) => s.cwd)).toEqual([undefined, 'D:\\proj-wt1', 'D:\\proj-wt2'])
    expect(segs[0]!.rows.map((r) => r.key)).toEqual(['m1'])
    expect(segs[1]!.rows.map((r) => r.key)).toEqual(['w1', 'w3'])
    expect(segs[1]!.branch).toBe('feat-a')
  })

  test('组内只有 worktree 行（主目录无会话）→ 无主段，仅子节', () => {
    const rows = [row({ key: 'w1', mtime: 100, cwd: 'D:\\proj-wt1', worktreeOf: 'D:\\proj' })]
    const segs = segmentRowsByCwd('D:\\proj', rows)
    expect(segs).toHaveLength(1)
    expect(segs[0]!.cwd).toBe('D:\\proj-wt1')
  })
})

describe('normPathKey（分组键归一，worktreeOf 正斜杠与 cwd 反斜杠必须同组）', () => {
  test('反斜杠归一为正斜杠、去尾斜杠；Windows 形态整体小写，POSIX 原样', () => {
    expect(normPathKey('D:\\Coder\\proj\\')).toBe('d:/coder/proj')
    expect(normPathKey('D:/Coder/proj')).toBe('d:/coder/proj')
    expect(normPathKey('/home/u/proj/')).toBe('/home/u/proj')
  })

  test('Windows 段级大小写不一不劈组（git 输出与录入差异）', () => {
    expect(normPathKey('D:\\Coder\\Proj')).toBe(normPathKey('d:/coder/proj'))
    expect(normPathKey('\\\\NAS\\Share\\proj')).toBe('//nas/share/proj')
  })

  test('分段比较同口径：组键正斜杠 + 行 cwd 反斜杠仍归入主段', () => {
    const rows = [
      row({ key: 'm1', mtime: 100, cwd: 'D:\\proj' }),
      row({ key: 'w1', mtime: 200, cwd: 'D:\\proj-wt1', worktreeOf: 'D:/proj' }),
    ]
    const segs = segmentRowsByCwd('D:/proj', rows)
    expect(segs.map((s) => s.cwd)).toEqual([undefined, 'D:\\proj-wt1'])
    expect(segs[0]!.rows.map((r) => r.key)).toEqual(['m1'])
  })
})

describe('rowStatusOf（B2：后台任务档不被主线空闲淹没）', () => {
  function statusRow(p: { waiting?: boolean; busy?: boolean; sessionState?: string; tasks?: number; spawned?: boolean; status?: string }): SessionInfo {
    return {
      sessionId: 'x',
      slug: 's',
      mtime: 1,
      sizeBytes: 0,
      status: (p.status ?? 'idle') as SessionInfo['status'],
      backend: 'claude',
      key: 'x',
      managed: {
        spawned: p.spawned ?? true,
        busy: p.busy ?? false,
        waiting: p.waiting ?? false,
        sessionState: p.sessionState ?? 'idle',
        activeTaskCount: p.tasks ?? 0,
      },
    } as SessionInfo
  }

  test('主线 idle + 后台任务（busy getter 被任务喂真）→ 「N 个后台任务」而非「工作中」', () => {
    const st = rowStatusOf(statusRow({ busy: true, sessionState: 'idle', tasks: 1 }))
    expect(st.key).toBe('tasks')
    expect(st.label).toBe('1 个后台任务')
  })

  test('主线 running + 后台任务 → 仍「工作中」（主线忙优先）', () => {
    expect(rowStatusOf(statusRow({ busy: true, sessionState: 'running', tasks: 1 })).key).toBe('busy')
  })

  test('busy+idle+零任务的合法态（组合回滚 pendingControlRequests / 旧 CLI fallbackBusy）→「工作中」不落空闲（review 轮）', () => {
    expect(rowStatusOf(statusRow({ busy: true, sessionState: 'idle', tasks: 0 })).key).toBe('busy')
  })

  test('waiting 最高优先；无任务的 idle/offline 照旧', () => {
    expect(rowStatusOf(statusRow({ waiting: true, busy: true, sessionState: 'requires_action' })).key).toBe('waiting')
    expect(rowStatusOf(statusRow({ busy: false, sessionState: 'idle', tasks: 0 })).key).toBe('idle')
    expect(rowStatusOf(statusRow({ busy: false, spawned: false, status: 'offline' })).key).toBe('offline')
  })
})
