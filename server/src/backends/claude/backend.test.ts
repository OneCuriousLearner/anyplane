import { describe, expect, test } from 'bun:test'
import { mkdtempSync, writeFileSync, utimesSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { config } from '../../config'
import { hydratedContextOf, splitExistingKey } from './backend'
import { rememberSessionModel, setStoreFileForTest } from './sessionModels'

// splitExistingKey 是 key → ~/.claude/projects/ 文件路径的唯一入口（rename/archive/restore/tailer），
// 字符集闸必须挡住路径遍历与分隔符注入。
describe('splitExistingKey', () => {
  test('合法 s| key 解析', () => {
    expect(splitExistingKey('s|-data-workspace-anyplane|01a03cac-3fdc-7b80-9c5d-f14ba518f4dc')).toEqual({
      slug: '-data-workspace-anyplane',
      sessionId: '01a03cac-3fdc-7b80-9c5d-f14ba518f4dc',
    })
  })

  test('路径遍历一律拒绝', () => {
    expect(splitExistingKey('s|../foo|bar')).toBeNull()
    expect(splitExistingKey('s|..|bar')).toBeNull()
    expect(splitExistingKey('s|foo|..')).toBeNull()
    expect(splitExistingKey('s|foo/bar|baz')).toBeNull()
    expect(splitExistingKey('s|foo|bar/baz')).toBeNull()
    expect(splitExistingKey('s|foo\\bar|baz')).toBeNull()
    expect(splitExistingKey('s|foo|bar.exe')).toBeNull()
    expect(splitExistingKey('s|%2e%2e|bar')).toBeNull()
  })

  test('非 s| 形状拒绝', () => {
    expect(splitExistingKey('n|%2Ftmp')).toBeNull()
    expect(splitExistingKey('b|%2Ftmp|sid')).toBeNull()
    expect(splitExistingKey('x|thread-id')).toBeNull()
    expect(splitExistingKey('s|only-two')).toBeNull()
    expect(splitExistingKey('s|a|b|c')).toBeNull()
    expect(splitExistingKey('')).toBeNull()
  })
})

describe('hydratedContextOf（离线水合：点开会话即有环形）', () => {
  const tmpRoot = mkdtempSync(join(tmpdir(), 'anyplane-hydrate-'))
  const sid = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
  const slug = '-tmp'
  let savedConfigDir = ''

  const writeTranscript = (inputTokens: number, cacheRead: number) => {
    const dir = join(tmpRoot, 'projects', slug)
    mkdirSync(dir, { recursive: true })
    const line = JSON.stringify({
      type: 'assistant', isSidechain: false,
      message: { id: 'msg-1', role: 'assistant', content: [], usage: { input_tokens: inputTokens, cache_read_input_tokens: cacheRead, cache_creation_input_tokens: 10, output_tokens: 7 } },
    })
    writeFileSync(join(dir, `${sid}.jsonl`), line + '\n')
  }

  test('读 transcript 尾部合成上下文占用；sessionModels 提供窗口；非 s| key 与缺文件拒绝', () => {
    savedConfigDir = config.claudeConfigDir
    config.claudeConfigDir = tmpRoot
    setStoreFileForTest(join(tmpRoot, 'models.json'))
    writeTranscript(1000, 300)
    rememberSessionModel(sid, 'k3[1m]')

    expect(hydratedContextOf(`s|${slug}|${sid}`)).toEqual({
      usedTokens: 1310, // 1000 + 300 + 10
      windowSize: 1_000_000, // [1m] 后缀
      outputTokens: 7,
      inputTokens: 1000,
      cacheReadTokens: 300,
      cacheWriteTokens: 10,
    })
    expect(hydratedContextOf('n|%2Ftmp')).toBeUndefined()
    expect(hydratedContextOf('x|thread-1')).toBeUndefined()
    expect(hydratedContextOf(`s|${slug}|00000000-0000-0000-0000-000000000000`)).toBeUndefined()

    config.claudeConfigDir = savedConfigDir
    setStoreFileForTest(undefined)
  })

  test('未登记模型的会话回退默认窗口；mtime 变化后重读', () => {
    savedConfigDir = config.claudeConfigDir
    config.claudeConfigDir = tmpRoot
    setStoreFileForTest(join(tmpRoot, 'models-2.json'))
    writeTranscript(1000, 300)
    expect(hydratedContextOf(`s|${slug}|${sid}`)?.windowSize).toBe(200_000)

    // mtime 变化 → 重新读盘拿到新值（写文件后显式推进 mtime，避开文件系统精度）
    writeTranscript(2000, 400)
    const p = join(tmpRoot, 'projects', slug, `${sid}.jsonl`)
    const future = new Date(Date.now() + 5000)
    utimesSync(p, future, future)
    expect(hydratedContextOf(`s|${slug}|${sid}`)?.inputTokens).toBe(2000)

    config.claudeConfigDir = savedConfigDir
    setStoreFileForTest(undefined)
  })
})
