// 权限模式映射是双后端体验一致的接缝：claude 风格模式与 codex 预设都汇聚到
// approvalPolicy+sandbox；wire 枚举双轨（thread/start 用 kebab-case sandbox，
// turn/start 用 camelCase sandboxPolicy 对象）是本文件锁定的重点。
import { describe, expect, test } from 'bun:test'
import {
  extractCompactedFromRolloutTail,
  extractTokenCountFromRolloutTail,
  mapApprovalDecision,
  mapPermissionMode,
  mapTokenUsage,
  reasoningSidecarUuid,
  sandboxPolicyOf,
} from './mapping'

describe('mapPermissionMode（codex 原生预设）', () => {
  test('四档预设', () => {
    expect(mapPermissionMode('readOnly')).toEqual({ approvalPolicy: 'on-request', sandbox: 'read-only' })
    expect(mapPermissionMode('workspace')).toEqual({ approvalPolicy: 'on-request', sandbox: 'workspace-write' })
    expect(mapPermissionMode('workspaceAuto')).toEqual({ approvalPolicy: 'never', sandbox: 'workspace-write' })
    expect(mapPermissionMode('fullAccess')).toEqual({ approvalPolicy: 'never', sandbox: 'danger-full-access' })
  })
})

describe('mapPermissionMode（claude 名称近似映射）', () => {
  test('bypassPermissions → 完全访问', () => {
    expect(mapPermissionMode('bypassPermissions')).toEqual({ approvalPolicy: 'never', sandbox: 'danger-full-access' })
  })
  test('acceptEdits/auto → 工作区免审', () => {
    expect(mapPermissionMode('acceptEdits')).toEqual({ approvalPolicy: 'never', sandbox: 'workspace-write' })
    expect(mapPermissionMode('auto')).toEqual({ approvalPolicy: 'never', sandbox: 'workspace-write' })
  })
  test('plan → 只读询问', () => {
    expect(mapPermissionMode('plan')).toEqual({ approvalPolicy: 'on-request', sandbox: 'read-only' })
  })
  test('default/未知/缺省 → 工作区询问（安全中间档）', () => {
    expect(mapPermissionMode('default')).toEqual({ approvalPolicy: 'on-request', sandbox: 'workspace-write' })
    expect(mapPermissionMode(undefined)).toEqual({ approvalPolicy: 'on-request', sandbox: 'workspace-write' })
    expect(mapPermissionMode('some-future-mode')).toEqual({ approvalPolicy: 'on-request', sandbox: 'workspace-write' })
  })
})

describe('sandboxPolicyOf（kebab → camelCase 对象的双轨转换）', () => {
  test('已知三档', () => {
    expect(sandboxPolicyOf('read-only')).toEqual({ type: 'readOnly' })
    expect(sandboxPolicyOf('workspace-write')).toEqual({ type: 'workspaceWrite' })
    expect(sandboxPolicyOf('danger-full-access')).toEqual({ type: 'dangerFullAccess' })
  })
  test('未知值返回 undefined（调用方省略字段，不发明枚举）', () => {
    expect(sandboxPolicyOf('')).toBeUndefined()
    expect(sandboxPolicyOf('yolo')).toBeUndefined()
  })
})

describe('extractTokenCountFromRolloutTail（resume 水合）', () => {
  const rec = (last: Record<string, number>, total?: Record<string, number>, w?: number) => JSON.stringify({
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: {
        total_token_usage: total ?? last,
        last_token_usage: last,
        ...(w != null ? { model_context_window: w } : {}),
      },
    },
  })
  const u1 = { input_tokens: 14548, cached_input_tokens: 8704, cache_write_input_tokens: 0, output_tokens: 41, reasoning_output_tokens: 37, total_tokens: 14589 }
  const u2 = { input_tokens: 15492, cached_input_tokens: 14464, cache_write_input_tokens: 0, output_tokens: 3, reasoning_output_tokens: 0, total_tokens: 15495 }

  test('取尾部最后一条 token_count；snake → camel 与 wire 同形', () => {
    const text = [rec(u1), rec(u2, { ...u2, total_tokens: 30084 }, 996147)].join('\n')
    expect(extractTokenCountFromRolloutTail(text)).toEqual({
      last: { totalTokens: 15495, inputTokens: 15492, cachedInputTokens: 14464, cacheWriteInputTokens: 0, outputTokens: 3, reasoningOutputTokens: 0 },
      total: { totalTokens: 30084, inputTokens: 15492, cachedInputTokens: 14464, cacheWriteInputTokens: 0, outputTokens: 3, reasoningOutputTokens: 0 },
      modelContextWindow: 996147,
    })
  })

  test('截断行/非 token_count 行跳过；缺 model_context_window 时省略', () => {
    const truncated = '{"type":"event_msg","payload":{"type":"token_count","info":{"las'
    const other = JSON.stringify({ type: 'response_item', payload: { type: 'message' } })
    const text = [truncated, other, rec(u1)].join('\n')
    const got = extractTokenCountFromRolloutTail(text)
    expect(got?.last.totalTokens).toBe(14589)
    expect(got?.modelContextWindow).toBeUndefined()
    expect(extractTokenCountFromRolloutTail(other)).toBeUndefined()
  })
})

describe('extractCompactedFromRolloutTail（/compact 摘要水合）', () => {
  // 2026-09-24 实测形状：{ timestamp, ordinal, type:'compacted', payload:{ message, … } }
  const compacted = (message: string, ordinal?: number) =>
    JSON.stringify({ timestamp: 't', ...(ordinal != null ? { ordinal } : {}), type: 'compacted', payload: { message, retained_context: {} } })

  test('取尾部最后一条 compacted：message + ordinal 身份；截断行/非 compacted 行跳过', () => {
    const other = JSON.stringify({ type: 'response_item', payload: { type: 'message' } })
    const truncated = '{"type":"compacted","payload":{"mes'
    const text = [compacted('旧摘要', 7), other, truncated, compacted('新摘要', 42)].join('\n')
    expect(extractCompactedFromRolloutTail(text)).toEqual({ message: '新摘要', ordinal: 42, timestamp: 't' })
    expect(extractCompactedFromRolloutTail(other)).toBeUndefined()
    expect(extractCompactedFromRolloutTail('')).toBeUndefined()
  })

  test('compacted 但 message 非字符串/空串 → 跳过；ordinal 缺席时字段省略', () => {
    const bad = JSON.stringify({ type: 'compacted', payload: { message: 42 } })
    const empty = compacted('  ')
    expect(extractCompactedFromRolloutTail([bad, empty].join('\n'))).toBeUndefined()
    expect(extractCompactedFromRolloutTail(compacted('无序号'))?.ordinal).toBeUndefined()
  })
})

describe('reasoningSidecarUuid（侧车回插去重锚点）', () => {
  test('itemId 优先，缺省回退 rs-<ts>-<i>', () => {
    expect(reasoningSidecarUuid({ ts: 1000, itemId: 'r-1' }, 3)).toBe('r-1')
    expect(reasoningSidecarUuid({ ts: 1000 }, 3)).toBe('rs-1000-3')
  })
})

describe('mapTokenUsage（camelCase 归一）', () => {
  test('wire 字段映射；缺失/非数归 0', () => {
    expect(mapTokenUsage(undefined)).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
    })
    expect(
      mapTokenUsage({
        inputTokens: 14548,
        outputTokens: 41,
        cachedInputTokens: 8704,
        cacheWriteInputTokens: 0,
        reasoningOutputTokens: 37,
      }),
    ).toEqual({
      inputTokens: 14548,
      outputTokens: 41,
      cacheReadTokens: 8704,
      cacheWriteTokens: 0,
      reasoningTokens: 37,
    })
  })
})

describe('mapApprovalDecision', () => {
  test('allow → accept；带 updatedPermissions → acceptForSession；decline → decline', () => {
    expect(mapApprovalDecision({ behavior: 'allow' })).toBe('accept')
    expect(mapApprovalDecision({ behavior: 'allow', updatedPermissions: { mode: 'x' } } as never)).toBe('acceptForSession')
    expect(mapApprovalDecision({ behavior: 'deny' })).toBe('decline')
  })
})
