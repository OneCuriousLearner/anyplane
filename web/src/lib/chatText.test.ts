import { describe, expect, test } from 'bun:test'
import { cliSidechainToHistory, statusLineOf } from './chatText'
import type { SessionState } from './ws'

const baseState: SessionState = { spawned: false, busy: false }

describe('statusLineOf 早退链（优先级即源码顺序）', () => {
  test('未连接最先', () => {
    expect(statusLineOf({ ...baseState, busy: true }, { connected: false, waiting: true, phase: 'requesting' })).toBe('连接中…')
  })
  test('phase 优先于 waiting/busy', () => {
    expect(statusLineOf({ ...baseState, busy: true }, { connected: true, waiting: true, phase: 'compacting' })).toBe('压缩上下文…')
    // 未知 phase 原样透传
    expect(statusLineOf(baseState, { connected: true, waiting: false, phase: 'whatever' })).toBe('whatever…')
  })
  test('waiting 区分 tailing', () => {
    expect(statusLineOf(baseState, { connected: true, waiting: true })).toBe('等待审批')
    expect(statusLineOf({ ...baseState, tailing: true }, { connected: true, waiting: true })).toBe('外部会话等待操作')
  })
  test('activeTaskCount 优先于 busy', () => {
    expect(statusLineOf({ ...baseState, busy: true, activeTaskCount: 2 }, { connected: true, waiting: false })).toBe('2 个后台任务运行中')
  })
  test('busy 区分 tailing', () => {
    expect(statusLineOf({ ...baseState, busy: true }, { connected: true, waiting: false })).toBe('工作中')
    expect(statusLineOf({ ...baseState, busy: true, tailing: true }, { connected: true, waiting: false })).toBe('外部会话工作中')
  })
  test('spawned 看 sessionState；且不再看 exited/tailing', () => {
    expect(statusLineOf({ spawned: true, busy: false, sessionState: 'idle' }, { connected: true, waiting: false })).toBe('CLI 空闲')
    expect(statusLineOf({ spawned: true, busy: false, sessionState: 'running' }, { connected: true, waiting: false })).toBe('CLI 运行中')
    expect(statusLineOf({ spawned: true, busy: false, exited: true }, { connected: true, waiting: false })).not.toBe('进程已退出')
  })
  test('exited / tailing / 未启动三态', () => {
    expect(statusLineOf({ ...baseState, exited: true }, { connected: true, waiting: false })).toBe('进程已退出')
    expect(statusLineOf({ ...baseState, tailing: true }, { connected: true, waiting: false })).toBe('外部会话 · 实时跟踪中')
    expect(statusLineOf(baseState, { connected: true, waiting: false })).toBe('浏览中（发送消息时启动 CLI）')
    expect(statusLineOf({ ...baseState, model: 'sonnet' }, { connected: true, waiting: false })).toBe('配置已保存（发送消息时启动 CLI）')
  })
})

describe('cliSidechainToHistory', () => {
  test('非 assistant/user 一律 null', () => {
    expect(cliSidechainToHistory({ type: 'system' })).toBeNull()
    expect(cliSidechainToHistory({ type: 'result' })).toBeNull()
  })
  test('字符串 content → text 块；空串不落块返回 null', () => {
    expect(cliSidechainToHistory({ type: 'user', message: { content: '  ' } })).toBeNull()
    const h = cliSidechainToHistory({ type: 'user', uuid: 'u1', message: { content: '你好' }, timestamp: 't' })
    expect(h).toEqual({ uuid: 'u1', role: 'user', blocks: [{ kind: 'text', text: '你好' }], timestamp: 't' })
  })
  test('块映射与 discovery 同形：text/thinking/tool_use/tool_result', () => {
    const h = cliSidechainToHistory({
      type: 'assistant',
      uuid: 'a1',
      message: {
        content: [
          { type: 'thinking', thinking: '想一想' },
          { type: 'text', text: '答' },
          { type: 'tool_use', name: 'Bash', id: 'tu1', input: { command: 'ls' } },
          { type: 'tool_result', tool_use_id: 'tu1', content: [{ type: 'text', text: 'ok' }], is_error: false },
          { type: 'text', text: '   ' }, // 空白 text 不落块
        ],
      },
    })
    expect(h?.role).toBe('assistant')
    expect(h?.blocks.map((b) => b.kind)).toEqual(['thinking', 'text', 'tool_use', 'tool_result'])
    const tr = h?.blocks[3]
    expect(tr?.kind === 'tool_result' && tr.id).toBe('tu1')
  })
})
