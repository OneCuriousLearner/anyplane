// readHistory 的 rewind 目标过滤：对齐官方 selectableUserMessagesFilter，
// tool_result / isMeta / 系统注入标签消息不得标为可回滚（它们没有文件 checkpoint）。
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { config } from '../../config'
import { readHistory } from './discovery'

const SLUG = 'D--test-rewind-filter'
const SID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'

let dir = ''
let savedConfigDir = ''

function line(obj: Record<string, unknown>): string {
  return JSON.stringify(obj)
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'cc-remote-discovery-'))
  savedConfigDir = config.claudeConfigDir
  config.claudeConfigDir = dir
  const projectDir = join(dir, 'projects', SLUG)
  mkdirSync(projectDir, { recursive: true })
  writeFileSync(
    join(projectDir, `${SID}.jsonl`),
    [
      line({ type: 'user', uuid: 'u-text-1', message: { role: 'user', content: '第一条真实提问' } }),
      line({
        type: 'user',
        uuid: 'u-tool-result',
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] },
      }),
      line({ type: 'user', uuid: 'u-meta', isMeta: true, message: { role: 'user', content: '元消息' } }),
      line({
        type: 'user',
        uuid: 'u-local-cmd',
        message: { role: 'user', content: '<command-name>compact</command-name><local-command-stdout>输出</local-command-stdout>' },
      }),
      line({ type: 'user', uuid: 'u-slash', message: { role: 'user', content: '<command-name>compact</command-name><command-args>focus</command-args>' } }),
      line({ type: 'user', uuid: 'u-text-2', message: { role: 'user', content: '第二条真实提问' } }),
    ].join('\n'),
  )
})

afterAll(() => {
  config.claudeConfigDir = savedConfigDir
  rmSync(dir, { recursive: true, force: true })
})

describe('readHistory rewind 目标过滤', () => {
  test('tool_result / isMeta / 本地命令回显不可回滚，真实文本与斜杠命令可回滚', () => {
    const { messages } = readHistory(SLUG, SID)
    const byUuid = new Map(messages.map((m) => [m.uuid, m]))

    // 官方同款语义：斜杠命令回显也建 checkpoint，保留为可选目标
    expect(byUuid.get('u-text-1')?.rewindable).toBe(true)
    expect(byUuid.get('u-text-2')?.rewindable).toBe(true)
    expect(byUuid.get('u-slash')?.rewindable).toBe(true)

    expect(byUuid.get('u-tool-result')?.rewindable).toBe(false)
    expect(byUuid.get('u-local-cmd')?.rewindable).toBe(false)
    // isMeta 消息被 isInternalUserMessage 直接滤出抄本，根本不应出现
    expect(byUuid.has('u-meta')).toBe(false)
  })
})
