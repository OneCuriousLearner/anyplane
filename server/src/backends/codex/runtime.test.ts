// 权限模式映射是双后端体验一致的接缝：claude 风格模式与 codex 预设都汇聚到
// approvalPolicy+sandbox；wire 枚举双轨（thread/start 用 kebab-case sandbox，
// turn/start 用 camelCase sandboxPolicy 对象）是本文件锁定的重点。
import { describe, expect, test } from 'bun:test'
import { CodexSession, extractTokenCountFromRolloutTail, mapPermissionMode, sandboxPolicyOf } from './runtime'

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

describe('CodexSession contextUsage（tokenUsage/updated → 统一形状）', () => {
  // CodexSession 的 tokenUsage 分支只触字段与回调，不碰 rpc——stub runtime 即可直测
  const makeSession = () => {
    let statusPushes = 0
    const session = new CodexSession('x|thread-1', { cwd: '/tmp' }, {} as never, {
      onMessage: () => {},
      onApprovalRequest: () => {},
      onExit: () => {},
      onStatusChange: () => statusPushes++,
    })
    return { session, pushes: () => statusPushes }
  }
  const payload = {
    tokenUsage: {
      total: { totalTokens: 30000, inputTokens: 29000, cachedInputTokens: 9000, cacheWriteInputTokens: 0, outputTokens: 1000, reasoningOutputTokens: 400 },
      last: { totalTokens: 14589, inputTokens: 14548, cachedInputTokens: 8704, cacheWriteInputTokens: 0, outputTokens: 41, reasoningOutputTokens: 37 },
      modelContextWindow: 996147,
    },
  }

  test('首个通知前为 undefined；last.totalTokens + modelContextWindow 合成窗口占用', () => {
    const { session, pushes } = makeSession()
    expect(session.contextUsage).toBeUndefined()
    session.handleNotification('thread/tokenUsage/updated', payload)
    expect(session.contextUsage).toEqual({
      usedTokens: 14589, // last.totalTokens = 最新活跃上下文大小
      windowSize: 996147,
      outputTokens: 41,
      inputTokens: 14548,
      cacheReadTokens: 8704,
      cacheWriteTokens: 0,
      reasoningTokens: 37,
    })
    expect(pushes()).toBe(1)
  })

  test('旧版缺 modelContextWindow 时保持隐藏；累计用量（tokenUsage）走 total 桶', () => {
    const { session } = makeSession()
    session.handleNotification('thread/tokenUsage/updated', {
      tokenUsage: { total: payload.tokenUsage.total, last: payload.tokenUsage.last },
    })
    expect(session.contextUsage).toBeUndefined()
    expect(session.tokenUsage.inputTokens).toBe(29000)
    expect(session.tokenUsage.reasoningTokens).toBe(400)
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
