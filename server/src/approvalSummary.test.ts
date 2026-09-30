// 审批摘要与 cwd 外警示（C2）的纯函数测试：
// - summarizeInput 按工具分发（本文件的用例从 util.test.ts 随迁，正本随实现迁到 approvalSummary）
// - outsideCwdPath：字面包含 / 同仓库家族豁免（真实 git 目录 + git worktree 沙盒）/ 跨仓库与系统路径报警
// 不用 mock——在临时目录真造 .git 布局（mkdir + 写 .git 指针文件，与 fsbrowse.readGitInfo 同一布局知识）。

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { outsideCwdPath, summarizeInput } from './approvalSummary'

describe('summarizeInput', () => {
  test('按工具取关键字段', () => {
    expect(summarizeInput('Bash', { command: 'ls -la', description: '列目录' })).toBe('ls -la')
    expect(summarizeInput('Glob', { pattern: 'src/**/*.ts' })).toBe('src/**/*.ts')
    expect(summarizeInput('Grep', { pattern: 'foo' })).toBe('foo')
    expect(summarizeInput('WebSearch', { query: 'bun watch' })).toBe('bun watch')
    expect(summarizeInput('WebFetch', { url: 'https://example.com' })).toBe('https://example.com')
    expect(summarizeInput('Agent', { description: '查日志', prompt: '详细指令' })).toBe('查日志')
  })

  test('通用字段 file_path / path / grantRoot；其他给 JSON', () => {
    expect(summarizeInput('Write', { file_path: '/tmp/a.txt', content: 'x' })).toBe('/tmp/a.txt')
    expect(summarizeInput('Custom', { path: '/b' })).toBe('/b')
    expect(summarizeInput('Custom', { grantRoot: '/c' })).toBe('/c')
    expect(summarizeInput('Custom', { other: 1 })).toBe('{"other":1}')
  })

  test('截断与边界输入', () => {
    expect(summarizeInput('Bash', { command: 'x'.repeat(500) })).toHaveLength(400)
    expect(summarizeInput('Custom', { v: 'y'.repeat(400) }).length).toBeLessThanOrEqual(301)
    expect(summarizeInput('Bash', undefined)).toBe('')
    expect(summarizeInput('Custom', null)).toBe('{}')
  })
})

describe('outsideCwdPath', () => {
  let root = ''

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'anyplane-outside-'))
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  /** 造 git 布局：主仓（.git 目录）+ worktree（.git 指针文件 + commondir 文件） */
  function makeRepoFamily(): { main: string; worktree: string; other: string } {
    const main = join(root, 'main')
    const worktree = join(root, 'main-wt1')
    const other = join(root, 'other')
    mkdirSync(join(main, '.git', 'worktrees', 'main-wt1'), { recursive: true })
    mkdirSync(worktree, { recursive: true })
    mkdirSync(join(other, '.git'), { recursive: true })
    writeFileSync(join(worktree, '.git'), `gitdir: ${join(main, '.git', 'worktrees', 'main-wt1')}\n`)
    writeFileSync(join(main, '.git', 'worktrees', 'main-wt1', 'commondir'), '../..\n')
    return { main, worktree, other }
  }

  test('cwd 子树内的路径不报', () => {
    const { main } = makeRepoFamily()
    expect(outsideCwdPath({ file_path: join(main, 'src', 'a.ts') }, main)).toBeUndefined()
  })

  test('同仓库家族豁免：主仓会话写 worktree 路径不报；worktree 会话写主仓也不报', () => {
    const { main, worktree } = makeRepoFamily()
    expect(outsideCwdPath({ file_path: join(worktree, 'src', 'a.ts') }, main)).toBeUndefined()
    expect(outsideCwdPath({ file_path: join(main, 'src', 'a.ts') }, worktree)).toBeUndefined()
    // 会话中途新建的、尚不存在的 worktree 目标路径也豁免（walk up 从已存在的祖先起）
    expect(outsideCwdPath({ file_path: join(worktree, 'deep', 'new', 'file.ts') }, main)).toBeUndefined()
  })

  test('异仓库路径报警（返回该路径原文）', () => {
    const { main, other } = makeRepoFamily()
    const target = join(other, 'node_modules', 'pkg')
    expect(outsideCwdPath({ file_path: target }, main)).toBe(target)
    expect(outsideCwdPath({ path: target }, main)).toBe(target)
    expect(outsideCwdPath({ grantRoot: target }, main)).toBe(target)
    expect(outsideCwdPath({ paths: [join(main, 'ok.ts'), target] }, main)).toBe(target)
  })

  test('非 git 区域的绝对路径报警；相对路径与无路径输入不报', () => {
    const plain = join(root, 'plain')
    const target = join(root, 'elsewhere', 'f.ts')
    mkdirSync(plain, { recursive: true })
    expect(outsideCwdPath({ file_path: target }, plain)).toBe(target)
    expect(outsideCwdPath({ file_path: 'src/relative.ts' }, plain)).toBeUndefined()
    expect(outsideCwdPath({ command: 'rm -rf /' }, plain)).toBeUndefined() // Bash 自由文本不解析
    expect(outsideCwdPath({}, plain)).toBeUndefined()
  })

  test('Windows 盘符大小写与分隔符归一', () => {
    const { main } = makeRepoFamily()
    const mixed = main.replace(/\//g, '\\')
    expect(outsideCwdPath({ file_path: mixed + '\\sub\\a.ts' }, main)).toBeUndefined()
    const upper = main.replace(/^([a-z]):/i, (_, d: string) => `${d.toUpperCase()}:`)
    const lower = main.replace(/^([a-z]):/i, (_, d: string) => `${d.toLowerCase()}:`)
    expect(outsideCwdPath({ file_path: `${upper}\\sub\\a.ts` }, lower)).toBeUndefined()
  })

  test('会话 cwd 未知时报平安（宁可沉默不误报）', () => {
    expect(outsideCwdPath({ file_path: '/etc/passwd' }, undefined)).toBeUndefined()
    expect(outsideCwdPath({ file_path: '/etc/passwd' }, '')).toBeUndefined()
  })

  test('input.cwd 字段也纳入检测（Bash 类工具携带的工作目录）', () => {
    const { main, other } = makeRepoFamily()
    expect(outsideCwdPath({ command: 'ls', cwd: other }, main)).toBe(other)
    expect(outsideCwdPath({ command: 'ls', cwd: join(main, 'sub') }, main)).toBeUndefined()
  })
})
