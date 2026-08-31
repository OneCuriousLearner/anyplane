// readHistory 的 rewind 目标过滤：对齐官方 selectableUserMessagesFilter，
// tool_result / isMeta / 系统注入标签消息不得标为可回滚（它们没有文件 checkpoint）。
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { config } from '../../config'
import { entryToHistoryMessage, isSelectableRewindTarget, readHistory } from './discovery'

const SLUG = 'D--test-rewind-filter'
const SID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'

let dir = ''
let savedConfigDir = ''

function line(obj: Record<string, unknown>): string {
  return JSON.stringify(obj)
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'anyplane-discovery-'))
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

describe('isSelectableRewindTarget', () => {
  const target = (content: unknown, extra: Record<string, unknown> = {}) => ({ message: { content }, ...extra })

  test('isMeta / isSynthetic / tool_result 块 → 不可回滚', () => {
    expect(isSelectableRewindTarget(target('文本', { isMeta: true }))).toBe(false)
    expect(isSelectableRewindTarget(target('文本', { isSynthetic: true }))).toBe(false)
    expect(isSelectableRewindTarget(target([{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }]))).toBe(false)
  })

  test('内部标签文本（bash 回显/tick/teammate/task-notification）→ 不可回滚', () => {
    for (const tag of ['<bash-stdout>', '<bash-stderr>', '<tick>', '<teammate-message>', '<task-notification>']) {
      expect(isSelectableRewindTarget(target(`${tag}内容`))).toBe(false)
    }
  })

  test('真实提问与斜杠命令回显 → 可回滚（官方同款：checkpoint 照常建立）', () => {
    expect(isSelectableRewindTarget(target('请检查当前项目'))).toBe(true)
    expect(isSelectableRewindTarget(target('<command-name>compact</command-name>'))).toBe(true)
    expect(isSelectableRewindTarget(target([{ type: 'text', text: '数组形态文本' }]))).toBe(true)
  })
})

describe('entryToHistoryMessage（readHistory 与 tailer 共用的单条解析）', () => {
  test('compact_boundary 元数据 camelCase 与 snake_case 都识别', () => {
    const camel = entryToHistoryMessage({
      type: 'system',
      subtype: 'compact_boundary',
      uuid: 'b1',
      compactMetadata: { trigger: 'auto', preTokens: 100, postTokens: 20 },
    })
    expect(camel).toMatchObject({
      role: 'system',
      subtype: 'compact_boundary',
      compactMeta: { trigger: 'auto', preTokens: 100, postTokens: 20 },
    })

    const snake = entryToHistoryMessage({
      type: 'system',
      subtype: 'compact_boundary',
      uuid: 'b2',
      compact_metadata: { pre_tokens: 90, post_tokens: 30 },
    })
    expect(snake).toMatchObject({ compactMeta: { preTokens: 90, postTokens: 30 } })
  })

  test('sidechain / 非对话类型 / 内部 user 消息 → null（不进主抄本）', () => {
    expect(entryToHistoryMessage({ type: 'assistant', isSidechain: true, message: { content: '子代理' } })).toBeNull()
    expect(entryToHistoryMessage({ type: 'system', subtype: 'init' })).toBeNull()
    expect(entryToHistoryMessage({ type: 'result', subtype: 'success' })).toBeNull()
    expect(entryToHistoryMessage({ type: 'user', isMeta: true, message: { content: '注入' } })).toBeNull()
  })

  test('内容块映射：text/thinking/tool_use/tool_result 各归其位', () => {
    const msg = entryToHistoryMessage({
      type: 'assistant',
      uuid: 'a1',
      timestamp: '2026-08-27T00:00:00Z',
      message: {
        content: [
          { type: 'thinking', thinking: '想一下' },
          { type: 'text', text: '结论' },
          { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } },
          { type: 'tool_result', tool_use_id: 't0', content: [{ type: 'text', text: '之前的结果' }], is_error: true },
        ],
      },
    })
    expect(msg).toMatchObject({
      uuid: 'a1',
      role: 'assistant',
      timestamp: '2026-08-27T00:00:00Z',
      blocks: [
        { kind: 'thinking', text: '想一下' },
        { kind: 'text', text: '结论' },
        { kind: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } },
        { kind: 'tool_result', id: 't0', text: '之前的结果', isError: true },
      ],
    })
  })

  test('纯空白内容 → null（不产生空气泡）', () => {
    expect(entryToHistoryMessage({ type: 'user', message: { content: '   ' } })).toBeNull()
    expect(entryToHistoryMessage({ type: 'assistant', message: { content: [{ type: 'text', text: '' }] } })).toBeNull()
    expect(entryToHistoryMessage({ type: 'assistant', message: {} })).toBeNull()
  })

  test('allowSidechain 放行侧链消息（子代理转录解析用）', () => {
    const side = { type: 'assistant', isSidechain: true, uuid: 's1', message: { content: [{ type: 'text', text: '子代理结论' }] } }
    expect(entryToHistoryMessage(side)).toBeNull()
    expect(entryToHistoryMessage(side, { allowSidechain: true })).toMatchObject({ uuid: 's1', blocks: [{ kind: 'text', text: '子代理结论' }] })
  })
})

describe('readHistory 子代理侧链收集', () => {
  const SID2 = 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff'

  beforeAll(() => {
    const projectDir = join(dir, 'projects', SLUG)
    // 主 transcript：一条提问 + 主线 Agent tool_use/tool_result + 一行旧版内联侧链
    writeFileSync(
      join(projectDir, `${SID2}.jsonl`),
      [
        line({ type: 'user', uuid: 'u1', timestamp: '2026-08-31T00:00:00Z', message: { role: 'user', content: '跑个子代理' } }),
        line({
          type: 'assistant', uuid: 'a1', timestamp: '2026-08-31T00:00:01Z',
          message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tool_main', name: 'Agent', input: { description: '旧版内联代理' } }] },
        }),
        line({ type: 'assistant', uuid: 's1', isSidechain: true, parentToolUseId: 'tool_main', timestamp: '2026-08-31T00:00:02Z', message: { role: 'assistant', content: [{ type: 'text', text: '内联侧链内容' }] } }),
        line({
          type: 'user', uuid: 'u2', timestamp: '2026-08-31T00:00:03Z',
          message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool_main', content: '旧版报告' }] },
        }),
      ].join('\n'),
    )
    // 新版拆分格式：subagents/agent-*.jsonl + .meta.json
    const subDir = join(projectDir, SID2, 'subagents')
    mkdirSync(subDir, { recursive: true })
    writeFileSync(
      join(subDir, 'agent-abc123.jsonl'),
      [
        line({ type: 'user', uuid: 'sa-u1', isSidechain: true, agentId: 'abc123', timestamp: '2026-08-31T00:01:00Z', message: { role: 'user', content: '查找 Hub 定义' } }),
        line({
          type: 'assistant', uuid: 'sa-a1', isSidechain: true, agentId: 'abc123', timestamp: '2026-08-31T00:01:01Z',
          message: { role: 'assistant', content: [{ type: 'thinking', thinking: '想' }, { type: 'tool_use', id: 'tool_inner', name: 'Grep', input: { pattern: 'Hub' } }] },
        }),
        line({
          type: 'user', uuid: 'sa-u2', isSidechain: true, agentId: 'abc123', timestamp: '2026-08-31T00:01:02Z',
          message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool_inner', content: 'index.ts' }] },
        }),
        line({ type: 'assistant', uuid: 'sa-a2', isSidechain: true, agentId: 'abc123', timestamp: '2026-08-31T00:01:03Z', message: { role: 'assistant', content: [{ type: 'text', text: '在 index.ts' }] } }),
      ].join('\n'),
    )
    writeFileSync(
      join(subDir, 'agent-abc123.meta.json'),
      JSON.stringify({ agentType: 'Explore', description: '查找 Hub 类定义文件', toolUseId: 'tool_split', spawnDepth: 1 }),
    )
  })

  test('新版拆分文件：消息 + meta 元数据齐全，tool_use/tool_result 可配对', () => {
    const { subagents } = readHistory(SLUG, SID2)
    const split = subagents.find((s) => s.toolUseId === 'tool_split')
    expect(split).toMatchObject({ agentId: 'abc123', agentType: 'Explore', description: '查找 Hub 类定义文件', spawnDepth: 1 })
    expect(split?.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant'])
    expect(split?.messages[1]?.blocks).toEqual([
      { kind: 'thinking', text: '想' },
      { kind: 'tool_use', id: 'tool_inner', name: 'Grep', input: { pattern: 'Hub' } },
    ])
  })

  test('旧版内联侧链：按 parentToolUseId 分桶，不污染主抄本', () => {
    const { messages, subagents } = readHistory(SLUG, SID2)
    expect(messages.some((m) => m.uuid === 's1')).toBe(false)
    const legacy = subagents.find((s) => s.toolUseId === 'tool_main')
    expect(legacy?.messages).toHaveLength(1)
    expect(legacy?.messages[0]?.blocks[0]).toEqual({ kind: 'text', text: '内联侧链内容' })
  })
})
