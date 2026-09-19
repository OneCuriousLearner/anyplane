import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FsBrowseError, listDirectories, readGitInfo } from './fsbrowse'

let root = ''

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'anyplane-fsbrowse-'))
})

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('readGitInfo', () => {
  test('普通仓库：.git/HEAD 的 ref 取末段分支名，非 worktree', () => {
    const repo = join(root, 'repo')
    mkdirSync(join(repo, '.git'), { recursive: true })
    writeFileSync(join(repo, '.git', 'HEAD'), 'ref: refs/heads/main\n')
    expect(readGitInfo(repo)).toEqual({ branch: 'main' })
  })

  test('detached HEAD：返回短 sha', () => {
    const repo = join(root, 'detached')
    mkdirSync(join(repo, '.git'), { recursive: true })
    writeFileSync(join(repo, '.git', 'HEAD'), '0123456789abcdef0123456789abcdef01234567\n')
    expect(readGitInfo(repo)?.branch).toBe('0123456')
  })

  test('worktree：gitdir 含 /.git/worktrees/ 段时反推主仓库根', () => {
    // 与 git worktree add 的真实布局同形：<main>/.git/worktrees/<name>
    const main = join(root, 'main-repo')
    const gitdir = join(main, '.git', 'worktrees', 'wt1')
    mkdirSync(gitdir, { recursive: true })
    writeFileSync(join(gitdir, 'HEAD'), 'ref: refs/heads/worktree-branch\n')
    const wt = join(root, 'wt-checkout')
    mkdirSync(wt, { recursive: true })
    writeFileSync(join(wt, '.git'), `gitdir: ${gitdir}\n`)
    expect(readGitInfo(wt)).toEqual({ branch: 'worktree-branch', worktreeOf: main })
  })

  test('worktree：相对 gitdir 指针先按 cwd 归一再反推', () => {
    const main = join(root, 'rel-main')
    const gitdir = join(main, '.git', 'worktrees', 'wt2')
    mkdirSync(gitdir, { recursive: true })
    writeFileSync(join(gitdir, 'HEAD'), 'ref: refs/heads/rel-branch\n')
    const wt = join(root, 'rel-checkout')
    mkdirSync(wt, { recursive: true })
    writeFileSync(join(wt, '.git'), 'gitdir: ../rel-main/.git/worktrees/wt2\n')
    expect(readGitInfo(wt)).toEqual({ branch: 'rel-branch', worktreeOf: main })
  })

  test('子模块 gitdir（/.git/modules/）不误判为 worktree，分支仍读', () => {
    const gitdir = join(root, 'super', '.git', 'modules', 'sub')
    mkdirSync(gitdir, { recursive: true })
    writeFileSync(join(gitdir, 'HEAD'), 'ref: refs/heads/sub-branch\n')
    const sub = join(root, 'super', 'sub')
    mkdirSync(sub, { recursive: true })
    writeFileSync(join(sub, '.git'), `gitdir: ${gitdir}\n`)
    expect(readGitInfo(sub)).toEqual({ branch: 'sub-branch' })
  })

  test('gitdir 指针无 worktrees 段：只读分支，不标 worktree', () => {
    const gitdir = join(root, 'real-gitdir')
    mkdirSync(gitdir, { recursive: true })
    writeFileSync(join(gitdir, 'HEAD'), 'ref: refs/heads/plain-branch\n')
    const wt = join(root, 'wt')
    mkdirSync(wt, { recursive: true })
    writeFileSync(join(wt, '.git'), `gitdir: ${gitdir}\n`)
    expect(readGitInfo(wt)).toEqual({ branch: 'plain-branch' })
  })

  test('.git 文件非 gitdir 指针 / 非仓库 / HEAD 不可读 → undefined 或缺分支', () => {
    const bogus = join(root, 'bogus')
    mkdirSync(bogus, { recursive: true })
    writeFileSync(join(bogus, '.git'), 'not a pointer')
    expect(readGitInfo(bogus)).toBeUndefined()

    const plain = join(root, 'plain')
    mkdirSync(plain, { recursive: true })
    expect(readGitInfo(plain)).toBeUndefined()

    expect(readGitInfo(join(root, 'does-not-exist'))).toBeUndefined()

    // .git 目录存在但 HEAD 不可读：信息对象在、分支缺席（与旧 readGitBranch 的 undefined 等价于列表层）
    const noHead = join(root, 'no-head')
    mkdirSync(join(noHead, '.git'), { recursive: true })
    expect(readGitInfo(noHead)).toEqual({ branch: undefined })
  })
})

describe('listDirectories', () => {
  test('空 target → 根集合视图（POSIX 为 / + home 快捷项）', () => {
    const r = listDirectories('')
    expect(r.path).toBe('')
    expect(r.parent).toBeNull()
    if (process.platform !== 'win32') {
      expect(r.entries.map((e) => e.name)).toContain('/')
    }
    expect(r.entries.map((e) => e.name)).toContain('~')
    expect(r.home).toBeTruthy()
  })

  test('只列目录不列文件，按名称排序，父目录正确', () => {
    const dir = join(root, 'listing')
    mkdirSync(join(dir, 'beta'), { recursive: true })
    mkdirSync(join(dir, 'alpha'), { recursive: true })
    writeFileSync(join(dir, 'file.txt'), 'not a dir')
    const r = listDirectories(dir)
    expect(r.entries.map((e) => e.name)).toEqual(['alpha', 'beta'])
    expect(r.parent).toBe(root)
  })

  test('符号链接指向目录也算目录（断链不算）', () => {
    const dir = join(root, 'links')
    const target = join(root, 'listing')
    mkdirSync(dir, { recursive: true })
    symlinkSync(target, join(dir, 'good-link'))
    symlinkSync(join(root, 'missing'), join(dir, 'bad-link'))
    writeFileSync(join(dir, 'file-link-target'), 'x')
    symlinkSync(join(dir, 'file-link-target'), join(dir, 'file-link'))
    const r = listDirectories(dir)
    expect(r.entries.map((e) => e.name)).toEqual(['good-link'])
  })

  test('POSIX 根目录的 parent 为 null', () => {
    if (process.platform === 'win32') return
    expect(listDirectories('/').parent).toBeNull()
  })

  test('错误映射：不存在 400 / 非目录 400，且都是 FsBrowseError', () => {
    try {
      listDirectories(join(root, 'no-such-dir'))
      expect.unreachable()
    } catch (e) {
      expect(e).toBeInstanceOf(FsBrowseError)
      expect((e as FsBrowseError).status).toBe(400)
      expect((e as FsBrowseError).message).toContain('路径不存在')
    }

    const file = join(root, 'a-file')
    writeFileSync(file, 'x')
    try {
      listDirectories(file)
      expect.unreachable()
    } catch (e) {
      expect(e).toBeInstanceOf(FsBrowseError)
      expect((e as FsBrowseError).status).toBe(400)
      expect((e as FsBrowseError).message).toContain('不是目录')
    }
  })
})
