import { describe, expect, test } from 'bun:test'
import { COMMAND_DESC, FALLBACK_COMMANDS, HEADLESS_TUI_COMMANDS, filterSlashHints, mergeSlashCommands } from './slashCommands'
import { interceptSlash } from './slashIntercept'

describe('mergeSlashCommands', () => {
  test('自有命令置顶，顺序即 FALLBACK 顺序', () => {
    const merged = mergeSlashCommands([{ name: 'model', desc: 'Switch model' }])
    expect(merged.map((e) => e.name)).toEqual([...FALLBACK_COMMANDS, 'model'])
  })

  test('CLI 同名命令去重：中文描述胜出，不重复出现', () => {
    const merged = mergeSlashCommands([
      { name: 'btw', desc: 'Ask a side question' },
      { name: 'compact', desc: 'Compact conversation' },
      { name: 'model', desc: 'Switch model' },
    ])
    const names = merged.map((e) => e.name)
    expect(names.filter((n) => n === 'btw')).toHaveLength(1)
    expect(names.filter((n) => n === 'compact')).toHaveLength(1)
    expect(merged.find((e) => e.name === 'btw')!.desc).toBe(COMMAND_DESC.btw)
    // CLI 独有命令保留原描述
    expect(merged.find((e) => e.name === 'model')!.desc).toBe('Switch model')
  })

  test('CLI 清单为空 → 仅自有命令', () => {
    const merged = mergeSlashCommands([])
    expect(merged).toHaveLength(FALLBACK_COMMANDS.length)
  })

  test('CLI 清单原序保留（技能/插件命令按握手顺序出现）', () => {
    const merged = mergeSlashCommands([
      { name: 'deep-research' },
      { name: 'dataviz' },
      { name: 'design-sync' },
    ])
    expect(merged.slice(-3).map((e) => e.name)).toEqual(['deep-research', 'dataviz', 'design-sync'])
  })

  test('不变式：每个自有命令都有中文描述', () => {
    for (const n of FALLBACK_COMMANDS) expect(COMMAND_DESC[n]).toBeTruthy()
  })

  test('B 类 TUI 命令被过滤，C 类技能保留', () => {
    const merged = mergeSlashCommands([
      { name: 'status', desc: 'TUI status page' }, // B 类：headless 打不开
      { name: 'permissions', desc: 'TUI permissions' }, // 已被拦截接管（不进过滤集），保留
      { name: 'plan', desc: 'plan mode' }, // 同上
      { name: 'deep-research', desc: 'skill' }, // C 类技能：保留
      { name: 'init', desc: 'skill' },
    ])
    const names = merged.map((e) => e.name)
    expect(names).not.toContain('status')
    expect(names).toContain('permissions')
    expect(names).toContain('plan')
    expect(names).toContain('deep-research')
    expect(names).toContain('init')
  })

  test('不变式：过滤集 ∩ 自有命令 = ∅（已接管的命令不许进过滤表）', () => {
    for (const n of FALLBACK_COMMANDS) expect(HEADLESS_TUI_COMMANDS.has(n)).toBe(false)
  })

  test('不变式：过滤集内每条都不被拦截表命中（两条防线不重叠， drift 时相互作证）', () => {
    for (const n of HEADLESS_TUI_COMMANDS) {
      expect(interceptSlash(`/${n}`, { isCodex: false })).toBeNull()
      expect(interceptSlash(`/${n}`, { isCodex: true })).toBeNull()
    }
  })
})

describe('filterSlashHints', () => {
  const entries = mergeSlashCommands([{ name: 'model' }, { name: 'memory' }])

  test('前缀匹配：/b → btw、branch；/br → 仅 branch', () => {
    expect(filterSlashHints('/b', entries).map((e) => e.name)).toEqual(['btw', 'branch'])
    expect(filterSlashHints('/br', entries).map((e) => e.name)).toEqual(['branch'])
  })

  test('完整名也命中自己（Enter 直接执行的依据）', () => {
    expect(filterSlashHints('/btw', entries).map((e) => e.name)).toEqual(['btw'])
  })

  test('无前缀命中 → 空', () => {
    expect(filterSlashHints('/zzz', entries)).toEqual([])
  })

  test('非斜杠输入不出提示', () => {
    expect(filterSlashHints('hello', entries)).toEqual([])
    expect(filterSlashHints('', entries)).toEqual([])
  })

  test('进入参数区（含空格）不出提示', () => {
    expect(filterSlashHints('/btw 你好', entries)).toEqual([])
    expect(filterSlashHints('/goal ', entries)).toEqual([])
  })

  test('仅一个 / 时列出全部命令', () => {
    expect(filterSlashHints('/', entries)).toHaveLength(entries.length)
  })
})
