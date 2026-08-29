import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FsBrowseError, listDirectories, readGitBranch } from './fsbrowse'

let root = ''

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'anyplane-fsbrowse-'))
})

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('readGitBranch', () => {
  test('普通仓库：.git/HEAD 的 ref 取末段分支名', () => {
    const repo = join(root, 'repo')
    mkdirSync(join(repo, '.git'), { recursive: true })
    writeFileSync(join(repo, '.git', 'HEAD'), 'ref: refs/heads/main\n')
    expect(readGitBranch(repo)).toBe('main')
  })

  test('detached HEAD：返回短 sha', () => {
    const repo = join(root, 'detached')
    mkdirSync(join(repo, '.git'), { recursive: true })
    writeFileSync(join(repo, '.git', 'HEAD'), '0123456789abcdef0123456789abcdef01234567\n')
    expect(readGitBranch(repo)).toBe('0123456')
  })

  test('worktree：.git 是 gitdir 指向文件，HEAD 在指向目录里', () => {
    const gitdir = join(root, 'real-gitdir')
    mkdirSync(gitdir, { recursive: true })
    writeFileSync(join(gitdir, 'HEAD'), 'ref: refs/heads/worktree-branch\n')
    const wt = join(root, 'wt')
    mkdirSync(wt, { recursive: true })
    writeFileSync(join(wt, '.git'), `gitdir: ${gitdir}\n`)
    expect(readGitBranch(wt)).toBe('worktree-branch')
  })

  test('.git 文件非 gitdir 指针 / 非仓库 / HEAD 不可读 → undefined', () => {
    const bogus = join(root, 'bogus')
    mkdirSync(bogus, { recursive: true })
    writeFileSync(join(bogus, '.git'), 'not a pointer')
    expect(readGitBranch(bogus)).toBeUndefined()

    const plain = join(root, 'plain')
    mkdirSync(plain, { recursive: true })
    expect(readGitBranch(plain)).toBeUndefined()

    expect(readGitBranch(join(root, 'does-not-exist'))).toBeUndefined()
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
