// worktree 归属侧车的持久化行为：record → lookup、跨实例（模拟重启）保持、损坏文件容忍、
// 主仓库根自身不写、同值不重复写（mtime 不变证明零 IO）。

import { beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { noteWorktree, resetWorktreeOwnersForTest, worktreeOwnerOf } from './worktreeOwners'

let dir = ''

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'anyplane-wto-'))
  resetWorktreeOwnersForTest(join(dir, 'owners.json'))
})

describe('worktreeOwners 侧车', () => {
  test('record → lookup；跨实例重载（模拟重启）仍命中', () => {
    noteWorktree('D:\\proj-wt1', 'D:\\proj')
    expect(worktreeOwnerOf('D:\\proj-wt1')).toBe('D:\\proj')
    expect(worktreeOwnerOf('D:\\proj')).toBeUndefined()
    // 模拟重启：清内存表重读文件
    resetWorktreeOwnersForTest(join(dir, 'owners.json'))
    expect(worktreeOwnerOf('D:\\proj-wt1')).toBe('D:\\proj')
  })

  test('主仓库根自身不写；同值重复 record 零 IO（文件 mtime 不变）', () => {
    noteWorktree('D:\\proj', 'D:\\proj')
    expect(worktreeOwnerOf('D:\\proj')).toBeUndefined()
    noteWorktree('D:\\proj-wt1', 'D:\\proj')
    const p = join(dir, 'owners.json')
    const before = statSync(p).mtimeMs
    noteWorktree('D:\\proj-wt1', 'D:\\proj')
    expect(statSync(p).mtimeMs).toBe(before)
  })

  test('文件损坏：空表起步不抛，下一次 record 重建', () => {
    writeFileSync(join(dir, 'owners.json'), '{not json')
    expect(worktreeOwnerOf('D:\\x')).toBeUndefined()
    noteWorktree('D:\\x', 'D:\\y')
    const t = JSON.parse(readFileSync(join(dir, 'owners.json'), 'utf8'))
    expect(t['D:\\x']).toBe('D:\\y')
    rmSync(dir, { recursive: true, force: true })
  })

  test('空输入与缺省查询安全返回 undefined', () => {
    expect(worktreeOwnerOf(undefined)).toBeUndefined()
    expect(worktreeOwnerOf('D:\\never-seen')).toBeUndefined()
    noteWorktree(undefined, 'D:\\proj')
    noteWorktree('D:\\x', undefined)
    expect(worktreeOwnerOf('D:\\x')).toBeUndefined()
  })
})
