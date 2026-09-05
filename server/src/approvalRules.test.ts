// 审批规则引擎单测：解析校验（fail fast）、glob/域名匹配器、按序首中、决策形状。
// 设计依据：docs/PLAN-drift-guard-and-approval-engine.md 第二节。

import { describe, expect, test } from 'bun:test'
import {
  decisionOfRule,
  domainMatch,
  globMatch,
  matchApprovalRule,
  parseApprovalRules,
  type ApprovalRule,
} from './approvalRules'

describe('parseApprovalRules：配置校验（fail fast）', () => {
  test('缺省 / null → 空数组', () => {
    expect(parseApprovalRules(undefined)).toEqual([])
    expect(parseApprovalRules(null)).toEqual([])
  })

  test('非数组 → 抛错', () => {
    expect(() => parseApprovalRules({ match: {} })).toThrow('必须是数组')
  })

  test('非法 action → 抛错并带数组下标', () => {
    expect(() => parseApprovalRules([{ match: { tool: 'Bash' }, action: 'yolo' }])).toThrow('approvalRules[0].action')
  })

  test('坏正则 → 启动即报错（含规则下标，能定位行）', () => {
    expect(() => parseApprovalRules([{ match: { command: '^(unclosed' }, action: 'allow' }])).toThrow(
      'approvalRules[0].match.command 正则无效',
    )
  })

  test('空 match → 抛错（至少一个匹配字段）', () => {
    expect(() => parseApprovalRules([{ match: {}, action: 'allow' }])).toThrow('至少要有一个匹配字段')
  })

  test('合法规则原样通过', () => {
    const rules = [{ match: { tool: 'Bash', command: '^git status$' }, action: 'allow' as const, note: '只读 git' }]
    expect(parseApprovalRules(rules)).toEqual(rules)
  })
})

describe('globMatch：路径匹配（锚定、大小写不敏感）', () => {
  test('** 跨任意路径段', () => {
    expect(globMatch('src/**', 'src/a/b/c.ts')).toBe(true)
    expect(globMatch('src/**', 'src/a.ts')).toBe(true)
  })

  test('两端锚定：src/** 不匹配 other/src/x', () => {
    expect(globMatch('src/**', 'other/src/x.ts')).toBe(false)
  })

  test('**/ 可匹配零个目录段', () => {
    expect(globMatch('**/*.test.ts', 'web/src/foo.test.ts')).toBe(true)
    expect(globMatch('**/*.test.ts', 'foo.test.ts')).toBe(true)
    expect(globMatch('**/*.test.ts', 'foo.test.tsx')).toBe(false)
  })

  test('* 不跨路径段', () => {
    expect(globMatch('src/*.ts', 'src/a.ts')).toBe(true)
    expect(globMatch('src/*.ts', 'src/a/b.ts')).toBe(false)
  })

  test('Windows 反斜杠与大小写归一', () => {
    expect(globMatch('D:/Coder/**', 'D:\\Coder\\Agents\\anyplane\\x.ts')).toBe(true)
    expect(globMatch('c:/users/**', 'C:\\Users\\foo\\y.ts')).toBe(true)
  })

  test('正则元字符按字面处理', () => {
    expect(globMatch('src/a+b.ts', 'src/a+b.ts')).toBe(true)
    expect(globMatch('src/a+b.ts', 'src/aab.ts')).toBe(false)
  })
})

describe('domainMatch：域名后缀匹配', () => {
  test('*. 前缀匹配多级子域与裸域', () => {
    expect(domainMatch('*.anthropic.com', 'api.anthropic.com')).toBe(true)
    expect(domainMatch('*.anthropic.com', 'a.b.anthropic.com')).toBe(true)
    expect(domainMatch('*.anthropic.com', 'anthropic.com')).toBe(true)
  })

  test('裸域名匹配自身与子域', () => {
    expect(domainMatch('github.com', 'github.com')).toBe(true)
    expect(domainMatch('github.com', 'api.github.com')).toBe(true)
  })

  test('不匹配形近域名（防后缀欺骗）', () => {
    expect(domainMatch('github.com', 'notgithub.com')).toBe(false)
    expect(domainMatch('github.com', 'github.com.evil.com')).toBe(false)
    expect(domainMatch('*.github.com', 'notgithub.com')).toBe(false)
  })

  test('大小写不敏感', () => {
    expect(domainMatch('*.GitHub.com', 'API.GITHUB.COM')).toBe(true)
  })
})

describe('matchApprovalRule：按序首中、AND 语义', () => {
  const rules: ApprovalRule[] = [
    { match: { tool: 'Bash', command: '^git (status|diff|log)' }, action: 'allow', note: '只读 git' },
    { match: { tool: 'Bash', command: '^rm -rf' }, action: 'deny', note: '禁止递归删除' },
    { match: { tool: 'Bash' }, action: 'allow' },
  ]

  test('首条命中生效（前面的规则优先于后面的宽泛规则）', () => {
    const hit = matchApprovalRule(rules, 'Bash', { command: 'rm -rf /tmp/x' })
    expect(hit?.rule.action).toBe('deny')
    expect(hit?.index).toBe(1)
  })

  test('tool 不匹配即跳过该规则', () => {
    const hit = matchApprovalRule(rules, 'Write', { file_path: 'src/x.ts' })
    expect(hit).toBeNull()
  })

  test('AND 语义：tool 命中但 command 不匹配 → 继续往下找', () => {
    const hit = matchApprovalRule(rules, 'Bash', { command: 'bun test' })
    expect(hit?.index).toBe(2) // 跳过第一条（command 不符），命中兜底 Bash 规则
  })

  test('tool 支持 | 多值', () => {
    const r: ApprovalRule[] = [{ match: { tool: 'Write|Edit' }, action: 'deny' }]
    expect(matchApprovalRule(r, 'Edit', { file_path: 'x' })?.rule.action).toBe('deny')
    expect(matchApprovalRule(r, 'Read', {})).toBeNull()
  })

  test('path glob 对 file_path 匹配', () => {
    const r: ApprovalRule[] = [{ match: { path: '**/*.test.ts' }, action: 'allow' }]
    expect(matchApprovalRule(r, 'Write', { file_path: 'web/src/a.test.ts' })?.rule.action).toBe('allow')
    expect(matchApprovalRule(r, 'Write', { file_path: 'web/src/a.ts' })).toBeNull()
  })

  test('domain 后缀对 url 匹配', () => {
    const r: ApprovalRule[] = [{ match: { tool: 'WebFetch', domain: '*.anthropic.com' }, action: 'allow' }]
    expect(matchApprovalRule(r, 'WebFetch', { url: 'https://docs.anthropic.com/x' })?.rule.action).toBe('allow')
    expect(matchApprovalRule(r, 'WebFetch', { url: 'https://evil.com/' })).toBeNull()
  })

  test('输入字段缺失（非对象 / 无该字段）→ 不命中，不落异常', () => {
    const r: ApprovalRule[] = [{ match: { command: '^git' }, action: 'allow' }]
    expect(matchApprovalRule(r, 'Bash', undefined)).toBeNull()
    expect(matchApprovalRule(r, 'Bash', {})).toBeNull()
    expect(matchApprovalRule(r, 'WebFetch', { url: 'not-a-url' })).toBeNull()
  })

  test('codex 重塑输入同形兼容（command 字符串）', () => {
    // codex translate 后 input 也是 { command: string } 形状，规则引擎无需区分后端
    const hit = matchApprovalRule(rules, 'Bash', { command: 'git status' })
    expect(hit?.rule.action).toBe('allow')
    expect(hit?.index).toBe(0)
  })

  test('无规则 → null（走人工 ask）', () => {
    expect(matchApprovalRule([], 'Bash', { command: 'ls' })).toBeNull()
  })
})

describe('decisionOfRule：决策形状与人工审批同形', () => {
  test('allow 携带 updatedInput 原样透传', () => {
    const input = { command: 'git status' }
    expect(decisionOfRule({ match: { tool: 'Bash' }, action: 'allow' }, input)).toEqual({
      behavior: 'allow',
      updatedInput: input,
    })
  })

  test('deny 带规则备注作为拒绝理由', () => {
    expect(decisionOfRule({ match: { tool: 'Bash' }, action: 'deny', note: '太危险' }, {})).toEqual({
      behavior: 'deny',
      message: '规则拒绝：太危险',
    })
    expect(decisionOfRule({ match: { tool: 'Bash' }, action: 'deny' }, {}).behavior).toBe('deny')
  })
})
