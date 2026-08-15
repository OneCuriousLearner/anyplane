import { describe, expect, test } from 'bun:test'
import { isInternalUserMessage } from './protocol'

describe('isInternalUserMessage', () => {
  test('filters task notifications even when an older transcript lacks metadata', () => {
    expect(
      isInternalUserMessage({
        type: 'user',
        message: {
          content:
            '<task-notification><task-id>a2daf5dfc4fc79ed7</task-id><summary>Task completed</summary></task-notification>',
        },
      }),
    ).toBe(true)
  })

  test('filters synthetic/meta messages and task-notification origin', () => {
    expect(isInternalUserMessage({ type: 'user', isMeta: true, message: { content: 'injected' } })).toBe(true)
    expect(isInternalUserMessage({ type: 'user', isSynthetic: true, message: { content: 'injected' } })).toBe(true)
    expect(
      isInternalUserMessage({ type: 'user', origin: { kind: 'task-notification' }, message: { content: 'completed' } }),
    ).toBe(true)
  })

  test('keeps real user prompts and tool-result messages', () => {
    expect(isInternalUserMessage({ type: 'user', message: { content: '请检查当前目录。' } })).toBe(false)
    expect(
      isInternalUserMessage({
        type: 'user',
        message: { content: [{ type: 'tool_result', tool_use_id: 'call-1', content: 'ok' }] },
      }),
    ).toBe(false)
  })
})
