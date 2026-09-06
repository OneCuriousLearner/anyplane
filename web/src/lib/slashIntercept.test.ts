import { describe, expect, test } from 'bun:test'
import { interceptSlash } from './slashIntercept'

const claude = { isCodex: false }
const codex = { isCodex: true }

describe('interceptSlash 双后端通杀（无后端门）', () => {
  test('/rewind 及官方别名', () => {
    for (const t of ['/rewind', '/checkpoint', '/undo']) {
      expect(interceptSlash(t, claude)).toEqual({ type: 'openRewind' })
      expect(interceptSlash(t, codex)).toEqual({ type: 'openRewind' })
    }
    expect(interceptSlash('/rewind now', claude)).toBeNull() // 带参不命中（透传给 CLI）
  })
  test('/btw 参数提取（含空参）', () => {
    expect(interceptSlash('/btw 你好吗', claude)).toEqual({ type: 'btw', question: '你好吗' })
    expect(interceptSlash('/btw', claude)).toEqual({ type: 'btw', question: '' })
    expect(interceptSlash('/btx', claude)).toBeNull() // 词边界：(\s|$)
  })
  test('/branch|/fork 全形拦截（含参数），名字提取', () => {
    expect(interceptSlash('/branch', claude)).toEqual({ type: 'branch', name: undefined })
    expect(interceptSlash('/branch 实验分支', claude)).toEqual({ type: 'branch', name: '实验分支' })
    expect(interceptSlash('/fork x', codex)).toEqual({ type: 'branch', name: 'x' }) // codex 也命中（执行器给引导提示）
  })
  test('/exit /quit', () => {
    expect(interceptSlash('/exit', claude)).toEqual({ type: 'exitHint' })
    expect(interceptSlash('/quit', codex)).toEqual({ type: 'exitHint' })
    expect(interceptSlash('/exit now', claude)).toBeNull()
  })
})

describe('interceptSlash codex 专属（claude 透传）', () => {
  test('/compact 仅 codex', () => {
    expect(interceptSlash('/compact', codex)).toEqual({ type: 'compact' })
    expect(interceptSlash('/compact', claude)).toBeNull()
  })
  test('/context 仅 codex', () => {
    expect(interceptSlash('/context', codex)).toEqual({ type: 'context' })
    expect(interceptSlash('/context', claude)).toBeNull()
  })
  test('/goal 三态：查询 / 清除 / 设定', () => {
    expect(interceptSlash('/goal', codex)).toEqual({ type: 'goal' })
    expect(interceptSlash('/goal 通过全部测试', codex)).toEqual({ type: 'goal', condition: '通过全部测试' })
    for (const w of ['clear', 'stop', 'off', 'reset', 'none', 'cancel', 'CLEAR']) {
      expect(interceptSlash(`/goal ${w}`, codex)).toEqual({ type: 'goal', clear: true })
    }
    expect(interceptSlash('/goal clear ok', codex)).toEqual({ type: 'goal', condition: 'clear ok' }) // 整词匹配
    expect(interceptSlash('/goal x', claude)).toBeNull()
  })
  test('/review 参数提取', () => {
    expect(interceptSlash('/review', codex)).toEqual({ type: 'review', instructions: undefined })
    expect(interceptSlash('/review 只看安全性', codex)).toEqual({ type: 'review', instructions: '只看安全性' })
    expect(interceptSlash('/review', claude)).toBeNull()
  })
  test('/rename 参数提取', () => {
    expect(interceptSlash('/rename 新名字', codex)).toEqual({ type: 'rename', name: '新名字' })
    expect(interceptSlash('/rename', codex)).toEqual({ type: 'rename', name: undefined })
    expect(interceptSlash('/rename x', claude)).toBeNull()
  })
  test('/new /clear 仅 codex', () => {
    expect(interceptSlash('/new', codex)).toEqual({ type: 'newThread' })
    expect(interceptSlash('/clear', codex)).toEqual({ type: 'newThread' })
    expect(interceptSlash('/new', claude)).toBeNull()
    expect(interceptSlash('/clear', claude)).toBeNull() // claude /clear 透传（CLI 换 sessionId 续跑正是想要的语义）
  })
})

describe('interceptSlash 非命令与优先级', () => {
  test('普通文本/未知命令不拦截', () => {
    expect(interceptSlash('hello', claude)).toBeNull()
    expect(interceptSlash('/unknown', codex)).toBeNull()
    expect(interceptSlash('', codex)).toBeNull()
  })
  test('表序即优先级：/btw 不被 /branch 族抢匹配', () => {
    // 两族正则无交集，此测试钉住"逐字保序"的意图（防后续重排）
    expect(interceptSlash('/btw /branch', claude)).toEqual({ type: 'btw', question: '/branch' })
  })
})
