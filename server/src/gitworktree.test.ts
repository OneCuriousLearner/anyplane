// worktree 生命周期的真实 git 沙盒测试（不用 mock——add/remove/dirty 两步走都是真 git 行为）。
// 与 AGENTS.md 同律：真实 CLI 行为不进单测的例外——本模块本身就是 git 调用的边界，
// 它的「链路验证」就是用真 git 在临时目录跑。

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { addWorktree, countDirty, parseStatusPorcelain, removeWorktree, statusSummaryOf } from './gitworktree'

let root = ''
let main = ''

function git(args: string[], cwd: string): void {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', shell: process.platform === 'win32' })
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`)
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'anyplane-gwt-'))
  main = join(root, 'repo')
  mkdirSync(main, { recursive: true })
  git(['init', '-q', '-b', 'main'], main)
  git(['config', 'user.email', 't@t.t'], main)
  git(['config', 'user.name', 't'], main)
  writeFileSync(join(main, 'seed.txt'), 'x\n')
  git(['add', '-A'], main)
  git(['commit', '-qm', 'seed'], main)
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('addWorktree', () => {
  test('落盘主仓同级 <repo>-<名>、分支 worktree-<名>', () => {
    const r = addWorktree(main, 'feat1')
    expect(r.ok).toBe(true)
    expect(r.path).toBe(join(root, 'repo-feat1'))
    expect(r.branch).toBe('worktree-feat1')
    expect(existsSync(join(r.path!, 'seed.txt'))).toBe(true)
    // 分支真的建了（git branch --list 对当前 checkout 的分支前缀 "+ "）
    const branches = spawnSync('git', ['branch', '--list', 'worktree-feat1', '--format=%(refname:short)'], { cwd: main, encoding: 'utf8', shell: process.platform === 'win32' })
    expect(branches.stdout.trim()).toBe('worktree-feat1')
  })

  test('非法名（含路径分隔/空格）被字符闸拒', () => {
    expect(addWorktree(main, '../evil').ok).toBe(false)
    expect(addWorktree(main, 'a b').ok).toBe(false)
    expect(addWorktree(main, 'a/b').ok).toBe(false)
  })

  test('同名分支已存在 → git 报错原文上抛（用户要能看到「分支已存在」）', () => {
    expect(addWorktree(main, 'feat1').ok).toBe(true)
    const again = addWorktree(main, 'feat1')
    expect(again.ok).toBe(false)
    expect(again.error).toBeTruthy()
  })
})

describe('removeWorktree', () => {
  test('干净树一次移除成功', () => {
    const r = addWorktree(main, 'clean')
    expect(r.ok).toBe(true)
    const rm = removeWorktree(main, r.path!, false)
    expect(rm.ok).toBe(true)
    expect(existsSync(r.path!)).toBe(false)
  })

  test('dirty 两步走：先被拒（附脏区统计），force 第二步成功（绝不静默 --force）', () => {
    const r = addWorktree(main, 'dirty1')
    writeFileSync(join(r.path!, 'seed.txt'), 'changed\n') // 已修改
    writeFileSync(join(r.path!, 'new.txt'), 'untracked\n') // 未跟踪

    const first = removeWorktree(main, r.path!, false)
    expect(first.ok).toBe(false)
    expect(first.dirty).toEqual({ modified: 1, untracked: 1 })
    expect(existsSync(r.path!)).toBe(true) // 没删掉

    const second = removeWorktree(main, r.path!, true)
    expect(second.ok).toBe(true)
    expect(existsSync(r.path!)).toBe(false)
  })

  test('countDirty 分类：?? 未跟踪、其余为已修改（含暂存）', () => {
    expect(countDirty('')).toEqual({ modified: 0, untracked: 0 })
    expect(countDirty(' M a.txt\n?? b.txt\nA  c.txt\nMM d.txt\n')).toEqual({ modified: 3, untracked: 1 })
  })
})

describe('statusSummaryOf（E2 改动摘要）', () => {
  test('parseStatusPorcelain 分组与 rename 取新路径', () => {
    expect(parseStatusPorcelain(' M a.txt\n?? b.txt\nA  c.txt\n D d.txt\nR  old.txt -> new.txt\n')).toEqual([
      { path: 'a.txt', xy: ' M', kind: 'modified' },
      { path: 'b.txt', xy: '??', kind: 'untracked' },
      { path: 'c.txt', xy: 'A ', kind: 'added' },
      { path: 'd.txt', xy: ' D', kind: 'deleted' },
      { path: 'new.txt', xy: 'R ', kind: 'modified' },
    ])
  })

  test('干净仓库返回空清单 + 分支名（porcelain --branch 单次调用解析）', () => {
    const s = statusSummaryOf(main)
    expect(s).toBeDefined()
    expect(s!.branch).toBe('main')
    expect(s!.files).toEqual([])
    expect(s!.counts).toEqual({ modified: 0, untracked: 0, deleted: 0 })
  })

  test('detached HEAD 时 branch 为 undefined（前端显示 detached）', () => {
    const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: main, encoding: 'utf8', shell: process.platform === 'win32' }).stdout.trim()
    git(['checkout', '-q', head], main)
    const s = statusSummaryOf(main)!
    expect(s.branch).toBeUndefined()
    git(['checkout', '-q', 'main'], main)
  })

  test('混合改动按组计数（untracked/deleted 各归各）', () => {
    writeFileSync(join(main, 'new.txt'), 'new\n') // untracked
    git(['rm', '-q', 'seed.txt'], main) // deleted

    const s = statusSummaryOf(main)!
    expect(s.branch).toBe('main')
    const kinds = Object.fromEntries(s.files.map((f) => [f.path, f.kind]))
    expect(kinds['new.txt']).toBe('untracked')
    expect(kinds['seed.txt']).toBe('deleted')
    expect(s.counts.deleted).toBe(1)
    expect(s.counts.untracked).toBe(1)
  })

  test('非 git 目录返回 undefined（前端隐藏入口）', () => {
    const plain = join(root, 'plain')
    mkdirSync(plain, { recursive: true })
    expect(statusSummaryOf(plain)).toBeUndefined()
  })
})

describe('含空格路径（review 轮 finding 1：shell:true 曾把未引用路径拆成多参数）', () => {
  let spaceRoot = ''
  let spaceMain = ''

  beforeEach(() => {
    spaceRoot = mkdtempSync(join(tmpdir(), 'anyplane gwt space-'))
    spaceMain = join(spaceRoot, 'repo')
    mkdirSync(spaceMain, { recursive: true })
    git(['init', '-q', '-b', 'main'], spaceMain)
    git(['config', 'user.email', 't@t.t'], spaceMain)
    git(['config', 'user.name', 't'], spaceMain)
    writeFileSync(join(spaceMain, 'seed.txt'), 'x\n')
    git(['add', '-A'], spaceMain)
    git(['commit', '-qm', 'seed'], spaceMain)
  })

  afterEach(() => {
    rmSync(spaceRoot, { recursive: true, force: true })
  })

  test('add + dirty 检测 + remove 在含空格仓库路径下全程不断', () => {
    const r = addWorktree(spaceMain, 'sp1')
    expect(r.ok).toBe(true)
    expect(r.path).toBe(join(spaceRoot, 'repo-sp1'))
    expect(existsSync(join(r.path!, 'seed.txt'))).toBe(true)

    writeFileSync(join(r.path!, 'new.txt'), 'untracked\n')
    const first = removeWorktree(spaceMain, r.path!, false)
    expect(first.ok).toBe(false)
    expect(first.dirty).toEqual({ modified: 0, untracked: 1 })

    const second = removeWorktree(spaceMain, r.path!, true)
    expect(second.ok).toBe(true)
    expect(existsSync(r.path!)).toBe(false)
  })
})
