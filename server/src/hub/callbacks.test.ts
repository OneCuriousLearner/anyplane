// 共享会话回调的纯 Hub 编排边界：
// - 内部 user 载荷不进入广播/回放环
// - 普通 cli/result 广播并把 turn 完成发布到 inbox
// - 进程退出撤销全部死审批，再推送明确的退出状态

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { processManager } from '../backends/claude/processManager'
import type { CliMessage } from '../backends/claude/streamJson'
import { claudePort } from '../backends/claude/port'
import { codexPort } from '../backends/codex/port'
import { registerBackend } from '../backends/port'
import { config } from '../config'
import { summarizeInput } from '../util'
import { resetInboxSinkForTest, setInboxSink } from './broadcast'
import { sessionCallbacks } from './callbacks'
import { resolveApproval } from './lifecycle'
import { getHub, hubs } from './registry'
import type { InboxEvent } from '@anyplane/protocol'
import type { Hub } from './types'

// portFor 经注册表取用（13.3 起）：注册真实适配器，镜像 index.ts 装配（各测试文件同一单例，幂等）。
registerBackend('claude', claudePort)
registerBackend('codex', codexPort)

const KEY = 'n|%2Ftmp%2Fcallbacks-test'
const inbox: InboxEvent[] = []

interface FakeWs {
  sent: string[]
  data: { key: string; inbox?: true }
  send(text: string): void
}

function fakeWs(key: string): FakeWs {
  return { sent: [], data: { key }, send(text: string) { this.sent.push(text) } }
}

function payloads(ws: FakeWs): Array<Record<string, unknown>> {
  return ws.sent.map((text) => JSON.parse(text) as Record<string, unknown>)
}

const extraKeys: string[] = []
const sessionMap = () => (processManager as unknown as { sessions: Map<string, unknown> }).sessions

/** 往 processManager 登记未退出的假句柄（等价 ensure 的登记半段，不 spawn） */
function injectFakeSession(key: string): { key: string } {
  extraKeys.push(key)
  const fake = { key }
  sessionMap().set(key, fake)
  return fake
}

function freshHub(): { hub: Hub; ws: FakeWs } {
  hubs.delete(KEY)
  const hub = getHub(KEY)
  const ws = fakeWs(KEY)
  hub.clients.add(ws as never)
  return { hub, ws }
}

function hubAt(key: string): { hub: Hub; ws: FakeWs } {
  extraKeys.push(key)
  hubs.delete(key)
  const hub = getHub(key)
  const ws = fakeWs(key)
  hub.clients.add(ws as never)
  return { hub, ws }
}

beforeEach(() => {
  inbox.length = 0
  setInboxSink({ publish: (event) => inbox.push(event) })
})

afterEach(() => {
  resetInboxSinkForTest()
  hubs.delete(KEY)
  sessionMap().delete(KEY)
  for (const k of extraKeys) {
    hubs.delete(k)
    sessionMap().delete(k)
  }
  extraKeys.length = 0
  inbox.length = 0
})

describe('sessionCallbacks.onMessage', () => {
  test('过滤 internal user：元数据标记与纯内部 XML 均不广播、不入回放环', () => {
    const { hub, ws } = freshHub()
    const callbacks = sessionCallbacks(hub)

    callbacks.onMessage({ type: 'user', isMeta: true } as CliMessage)
    callbacks.onMessage({
      type: 'user',
      message: { content: '<task-notification>background agent done</task-notification>' },
    } as CliMessage)

    expect(ws.sent).toEqual([])
    expect(hub.cliSeq).toBeUndefined()
    expect(hub.cliRing).toBeUndefined()
    expect(inbox).toEqual([])
  })

  test('普通 cli/result 均广播入环，result 同步发布 done inbox', () => {
    const { hub, ws } = freshHub()
    const callbacks = sessionCallbacks(hub)

    callbacks.onMessage({ type: 'assistant', message: { content: 'answer' } })
    callbacks.onMessage({ type: 'result', is_error: false })

    expect(payloads(ws)).toEqual([
      { kind: 'cli', seq: 1, msg: { type: 'assistant', message: { content: 'answer' } } },
      { kind: 'cli', seq: 2, msg: { type: 'result', is_error: false } },
    ])
    expect(hub.cliRing?.map((slot) => slot.seq)).toEqual([1, 2])
    expect(inbox).toEqual([{ type: 'done', key: KEY, ok: true }])
  })
})

describe('sessionCallbacks.conversation_reset', () => {
  test('claude key 进入 rekey，事件不进抄本', () => {
    const { hub, ws } = hubAt('n|%2Ftmp')
    sessionCallbacks(hub).onMessage({ type: 'conversation_reset' } as CliMessage)
    expect(hub.transition).toEqual({ kind: 'rekey' })
    expect(ws.sent).toEqual([])
  })

  test('codex key 不重键，落入普通透传', () => {
    const { hub, ws } = hubAt('x|thread-1')
    sessionCallbacks(hub).onMessage({ type: 'conversation_reset' } as CliMessage)
    expect(hub.transition).toBeUndefined()
    expect(payloads(ws)[0]).toMatchObject({ kind: 'cli', msg: { type: 'conversation_reset' } })
  })

  test('损坏 xn| 编码仍归 codex，不误触 claude 重键', () => {
    const { hub, ws } = hubAt('xn|%E4%B8')
    sessionCallbacks(hub).onMessage({ type: 'conversation_reset' } as CliMessage)
    expect(hub.transition).toBeUndefined()
    expect(payloads(ws)[0]).toMatchObject({ kind: 'cli', msg: { type: 'conversation_reset' } })
  })

  test('init 完成三层重键：Hub 注册表 / 进程 map / ws.data.key，并广播 moved', () => {
    const oldKey = 'n|%2Ftmp%2Fclear-cwd'
    const { hub, ws } = hubAt(oldKey)
    const fake = injectFakeSession(oldKey)
    const cb = sessionCallbacks(hub)
    cb.onMessage({ type: 'conversation_reset' } as CliMessage)
    cb.onMessage({ type: 'system', subtype: 'init', session_id: 'new-sid-1' } as CliMessage)

    const newKey = 's|-tmp-clear-cwd|new-sid-1'
    extraKeys.push(newKey)
    expect(hub.key).toBe(newKey)
    expect(hub.transition).toBeUndefined()
    expect(ws.data.key).toBe(newKey)
    expect(hubs.get(oldKey)).toBeUndefined()
    expect(hubs.get(newKey)).toBe(hub)
    expect(sessionMap().has(oldKey)).toBe(false)
    expect(sessionMap().get(newKey)).toBe(fake)
    expect(fake.key).toBe(newKey)
    expect(payloads(ws).some((p) => p.kind === 'moved' && p.targetKey === newKey && p.reason === 'clear')).toBe(true)
  })

  test('cwd 优先 spawnOpts，覆盖 n| key 内嵌路径', () => {
    const oldKey = 'n|%2Ftmp%2Ffrom-key'
    const { hub, ws } = hubAt(oldKey)
    hub.spawnOpts = { cwd: '/explicit/spawn-cwd' }
    const cb = sessionCallbacks(hub)
    cb.onMessage({ type: 'conversation_reset' } as CliMessage)
    cb.onMessage({ type: 'system', subtype: 'init', session_id: 'sid-opts' } as CliMessage)

    const newKey = 's|-explicit-spawn-cwd|sid-opts'
    extraKeys.push(newKey)
    expect(hub.key).toBe(newKey)
    expect(ws.data.key).toBe(newKey)
  })

  test('已是 s| 的第二次 /clear：spawnOpts.cwd 升到新 sid，进程 map 跟随', () => {
    const oldKey = 's|-tmp-clear-cwd|old-sid'
    const { hub, ws } = hubAt(oldKey)
    hub.spawnOpts = { cwd: '/tmp/clear-cwd' }
    const fake = injectFakeSession(oldKey)
    const cb = sessionCallbacks(hub)
    cb.onMessage({ type: 'conversation_reset' } as CliMessage)
    cb.onMessage({ type: 'system', subtype: 'init', session_id: 'sid-again' } as CliMessage)

    const newKey = 's|-tmp-clear-cwd|sid-again'
    extraKeys.push(newKey)
    expect(hub.key).toBe(newKey)
    expect(ws.data.key).toBe(newKey)
    expect(sessionMap().has(oldKey)).toBe(false)
    expect(sessionMap().get(newKey)).toBe(fake)
    expect(fake.key).toBe(newKey)
  })
})

describe('sessionCallbacks.init 通用升键（n|/xn|/b| 拿到真实 id 即重键）', () => {
  test('claude n| 首个 init 升键 s|：三层同步 + moved(reason=spawned)', () => {
    const oldKey = 'n|%2Ftmp%2Flazy-cwd'
    const { hub, ws } = hubAt(oldKey)
    const fake = injectFakeSession(oldKey)
    sessionCallbacks(hub).onMessage({ type: 'system', subtype: 'init', session_id: 'sid-lazy' } as CliMessage)

    const newKey = 's|-tmp-lazy-cwd|sid-lazy'
    extraKeys.push(newKey)
    expect(hub.key).toBe(newKey)
    expect(hub.sessionId).toBe('sid-lazy')
    expect(ws.data.key).toBe(newKey)
    expect(hubs.get(oldKey)).toBeUndefined()
    expect(hubs.get(newKey)).toBe(hub)
    expect(sessionMap().has(oldKey)).toBe(false)
    expect(sessionMap().get(newKey)).toBe(fake)
    const moved = payloads(ws).filter((p) => p.kind === 'moved')
    expect(moved).toEqual([{ kind: 'moved', targetKey: newKey, targetSessionId: 'sid-lazy', reason: 'spawned' }])
  })

  test('codex xn| 合成 init 升键 x|（cwd 不参与 key）', () => {
    const oldKey = 'xn|%2Ftmp%2Fx-cwd'
    const { hub, ws } = hubAt(oldKey)
    sessionCallbacks(hub).onMessage({ type: 'system', subtype: 'init', session_id: 'th-1' } as CliMessage)

    const newKey = 'x|th-1'
    extraKeys.push(newKey)
    expect(hub.key).toBe(newKey)
    expect(ws.data.key).toBe(newKey)
    expect(payloads(ws).some((p) => p.kind === 'moved' && p.targetKey === newKey && p.reason === 'spawned')).toBe(true)
  })

  test('claude b| 懒分叉首个 init 升键到分叉自身 s|（cwd 取 key 内嵌段）', () => {
    const oldKey = 'b|%2Ftmp%2Ffork-cwd|source-sid'
    const { hub, ws } = hubAt(oldKey)
    const fake = injectFakeSession(oldKey)
    sessionCallbacks(hub).onMessage({ type: 'system', subtype: 'init', session_id: 'fork-sid' } as CliMessage)

    const newKey = 's|-tmp-fork-cwd|fork-sid'
    extraKeys.push(newKey)
    expect(hub.key).toBe(newKey)
    expect(sessionMap().get(newKey)).toBe(fake)
    expect(payloads(ws).some((p) => p.kind === 'moved' && p.targetKey === newKey)).toBe(true)
  })

  test('existing key（s|/x|）的 init 不升键、不发 moved', () => {
    const { hub, ws } = hubAt('s|-tmp|sid-1')
    sessionCallbacks(hub).onMessage({ type: 'system', subtype: 'init', session_id: 'sid-1' } as CliMessage)
    expect(hub.key).toBe('s|-tmp|sid-1')
    expect(payloads(ws).some((p) => p.kind === 'moved')).toBe(false)

    const cx = hubAt('x|th-9')
    sessionCallbacks(cx.hub).onMessage({ type: 'system', subtype: 'init', session_id: 'th-9' } as CliMessage)
    expect(cx.hub.key).toBe('x|th-9')
    expect(payloads(cx.ws).some((p) => p.kind === 'moved')).toBe(false)
  })

  test('/clear 重键后通用分支不重复升键：moved 只有一条且 reason=clear', () => {
    const oldKey = 'n|%2Ftmp%2Fclear-once'
    const { hub, ws } = hubAt(oldKey)
    injectFakeSession(oldKey)
    const cb = sessionCallbacks(hub)
    cb.onMessage({ type: 'conversation_reset' } as CliMessage)
    cb.onMessage({ type: 'system', subtype: 'init', session_id: 'sid-once' } as CliMessage)

    const newKey = 's|-tmp-clear-once|sid-once'
    extraKeys.push(newKey)
    expect(hub.key).toBe(newKey)
    const moved = payloads(ws).filter((p) => p.kind === 'moved')
    expect(moved).toEqual([{ kind: 'moved', targetKey: newKey, targetSessionId: 'sid-once', reason: 'clear' }])
  })
})

describe('sessionCallbacks.onExit', () => {
  test('清空死审批，逐条撤卡并发布 inbox，最后推送退出状态', () => {
    const { hub, ws } = freshHub()
    hub.pendingApprovals.set('r1', { requestId: 'r1', toolName: 'Bash', input: {} })
    hub.pendingApprovals.set('r2', { requestId: 'r2', toolName: 'Write', input: { file_path: '/tmp/x' } })
    hub.sessionAllowTools = new Set(['Bash'])

    sessionCallbacks(hub).onExit(17)

    expect(hub.pendingApprovals.size).toBe(0)
    // 「本会话允许」随进程死亡失效：Hub 因客户端存活而保留，不清则重 spawn 的新会话继承旧放行集
    expect(hub.sessionAllowTools).toBeUndefined()
    const sent = payloads(ws)
    expect(sent.slice(0, 2)).toEqual([
      { kind: 'approval_resolved', requestId: 'r1' },
      { kind: 'approval_resolved', requestId: 'r2' },
    ])
    expect(sent[2]).toMatchObject({
      kind: 'status',
      state: { exited: true, exitCode: 17, spawned: false, busy: false, waiting: false },
    })
    expect(inbox).toEqual([
      { type: 'approval_resolved', key: KEY, requestId: 'r1' },
      { type: 'approval_resolved', key: KEY, requestId: 'r2' },
    ])
  })
})

describe('sessionCallbacks.onApprovalRequest（审批规则引擎集成）', () => {
  let savedRules: typeof config.approvalRules
  beforeEach(() => {
    savedRules = config.approvalRules
  })
  afterEach(() => {
    config.approvalRules = savedRules
  })

  /** 往 processManager 登记带审批投递捕获的假句柄（deliverApproval 的接收端） */
  function injectApprovalSession(): Array<[string, unknown]> {
    const delivered: Array<[string, unknown]> = []
    sessionMap().set(KEY, {
      key: KEY,
      exited: false,
      sendApproval: (requestId: string, decision: unknown) => delivered.push([requestId, decision]),
      notifyExternalGate: () => {},
    })
    return delivered
  }

  test('规则命中 → 不进 pending、不打扰（无 approval_request/inbox），广播 approval_auto 留痕并共用投递半段', () => {
    const { hub, ws } = freshHub()
    const delivered = injectApprovalSession()
    config.approvalRules = [{ match: { tool: 'Bash', command: '^git status$' }, action: 'allow', note: 'git 只读' }]

    const input = { command: 'git status' }
    sessionCallbacks(hub).onApprovalRequest({ requestId: 'ra1', toolName: 'Bash', input })

    expect(hub.pendingApprovals.size).toBe(0) // 自动裁决不进 pending
    expect(payloads(ws)).toEqual([
      {
        kind: 'approval_auto',
        requestId: 'ra1',
        toolName: 'Bash',
        input,
        detail: summarizeInput('Bash', input), // 摘要服务端唯一口径算好下发
        action: 'allow',
        rule: 'git 只读', // note 优先于 approvalRules[i] 兜底
      },
    ])
    // 与手动裁决共用投递半段：decisionOfRule 的 allow 形状（updatedInput 沿用原始 input）
    expect(delivered).toEqual([['ra1', { behavior: 'allow', updatedInput: input }]])
    expect(inbox).toEqual([]) // 不推送不打扰
  })

  test('规则命中 deny → 拒绝文案带 note，action 留痕为 deny', () => {
    const { hub, ws } = freshHub()
    const delivered = injectApprovalSession()
    config.approvalRules = [{ match: { tool: 'Bash', command: 'rm -rf' }, action: 'deny', note: '禁止删根' }]

    sessionCallbacks(hub).onApprovalRequest({ requestId: 'ra2', toolName: 'Bash', input: { command: 'rm -rf /' } })

    expect(payloads(ws)[0]).toMatchObject({ kind: 'approval_auto', action: 'deny', rule: '禁止删根' })
    expect(delivered).toEqual([['ra2', { behavior: 'deny', message: '规则拒绝：禁止删根' }]])
  })

  test('规则未命中 → pending 入表 + approval_request 广播 + inbox approval 带 detail + 状态推送', () => {
    const { hub, ws } = freshHub()
    config.approvalRules = [{ match: { tool: 'Write' }, action: 'allow' }] // 不命中 Bash

    const input = { command: 'make deploy' }
    sessionCallbacks(hub).onApprovalRequest({ requestId: 'ra3', toolName: 'Bash', input })

    expect(hub.pendingApprovals.get('ra3')).toEqual({ requestId: 'ra3', toolName: 'Bash', input })
    const sent = payloads(ws)
    expect(sent[0]).toEqual({ kind: 'approval_request', requestId: 'ra3', toolName: 'Bash', input })
    expect(sent.some((p) => p.kind === 'status')).toBe(true)
    expect(inbox).toEqual([
      { type: 'approval', key: KEY, requestId: 'ra3', toolName: 'Bash', input, detail: summarizeInput('Bash', input) },
    ])
  })

  test('无规则配置（approvalRules 缺席）→ 全部进 pending', () => {
    const { hub } = freshHub()
    config.approvalRules = undefined

    sessionCallbacks(hub).onApprovalRequest({ requestId: 'ra4', toolName: 'Bash', input: { command: 'ls' } })
    expect(hub.pendingApprovals.has('ra4')).toBe(true)
  })

  test('rememberTool 裁决后：同工具后续请求走 approval_auto（本会话允许），不进 pending 不推送', () => {
    const { hub, ws } = freshHub()
    const delivered = injectApprovalSession()
    config.approvalRules = undefined
    const cb = sessionCallbacks(hub)

    // 首次请求进 pending，WS 裁决 allow + rememberTool → 写入 Hub 内存放行集
    cb.onApprovalRequest({ requestId: 'rm1', toolName: 'Edit', input: { file_path: '/a.ts' } })
    expect(hub.pendingApprovals.has('rm1')).toBe(true)
    resolveApproval(hub, 'rm1', { behavior: 'allow', updatedInput: { file_path: '/a.ts' }, rememberTool: true })
    expect(hub.sessionAllowTools?.has('Edit')).toBe(true)
    // rememberTool 是 Hub 内部语义：投递上游的裁决必须剥掉（claude control_response 全量透传）
    expect(delivered[0]).toEqual(['rm1', { behavior: 'allow', updatedInput: { file_path: '/a.ts' } }])

    // 同工具后续请求：与规则路径同形留痕（approval_auto），共用投递半段
    ws.sent.length = 0
    inbox.length = 0
    cb.onApprovalRequest({ requestId: 'rm2', toolName: 'Edit', input: { file_path: '/b.ts' } })
    expect(hub.pendingApprovals.has('rm2')).toBe(false)
    expect(payloads(ws)[0]).toMatchObject({
      kind: 'approval_auto',
      requestId: 'rm2',
      toolName: 'Edit',
      action: 'allow',
      rule: '本会话允许',
    })
    expect(delivered[1]).toEqual(['rm2', { behavior: 'allow', updatedInput: { file_path: '/b.ts' } }])
    expect(inbox).toEqual([]) // 自动放行不打扰

    // 不同工具不放行
    cb.onApprovalRequest({ requestId: 'rm3', toolName: 'Bash', input: { command: 'ls' } })
    expect(hub.pendingApprovals.has('rm3')).toBe(true)
  })

  test('/clear 重键后「本会话允许」放行集失效（sessionId 已换）', () => {
    const oldKey = 'n|%2Ftmp%2Fclear-allowset'
    const { hub } = hubAt(oldKey)
    injectFakeSession(oldKey)
    hub.sessionAllowTools = new Set(['Edit'])
    const cb = sessionCallbacks(hub)
    cb.onMessage({ type: 'conversation_reset' } as CliMessage)
    cb.onMessage({ type: 'system', subtype: 'init', session_id: 'sid-fresh' } as CliMessage)

    const newKey = 's|-tmp-clear-allowset|sid-fresh'
    extraKeys.push(newKey)
    expect(hub.key).toBe(newKey) // 重键已发生
    expect(hub.sessionAllowTools).toBeUndefined()
  })
})

describe('sessionCallbacks.onApprovalResolved（上游终结的审批清理）', () => {
  test('pending 在 → 删除 + 撤卡广播 + inbox + 状态推送', () => {
    const { hub, ws } = freshHub()
    hub.pendingApprovals.set('r9', { requestId: 'r9', toolName: 'Bash', input: {} })

    sessionCallbacks(hub).onApprovalResolved('r9')

    expect(hub.pendingApprovals.size).toBe(0)
    expect(payloads(ws).map((p) => p.kind)).toEqual(['approval_resolved', 'status'])
    expect(inbox).toEqual([{ type: 'approval_resolved', key: KEY, requestId: 'r9' }])
  })

  test('pending 不在 → 完全静默（重复办结/竞态是常态，不留痕不推送）', () => {
    const { hub, ws } = freshHub()

    sessionCallbacks(hub).onApprovalResolved('never-pending')

    expect(ws.sent).toEqual([])
    expect(inbox).toEqual([])
  })
})

describe('sessionCallbacks.onMessage result 与 goal 清除', () => {
  test('goal 激活期间 result 到达即视为目标完成：清 goal 并推送状态（chip 随之清除）', () => {
    const { hub, ws } = freshHub()
    hub.goal = { condition: '跑通测试', since: Date.now() }

    sessionCallbacks(hub).onMessage({ type: 'result', is_error: false })

    expect(hub.goal).toBeUndefined()
    const sent = payloads(ws)
    expect(sent[0]).toMatchObject({ kind: 'cli', msg: { type: 'result' } })
    expect(sent.some((p) => p.kind === 'status' && (p.state as { goal?: unknown }).goal === null)).toBe(true)
    expect(inbox).toEqual([{ type: 'done', key: KEY, ok: true }])
  })

  test('无 goal 时 result 不追加状态推送（只有 cli 广播 + done inbox）', () => {
    const { hub, ws } = freshHub()

    sessionCallbacks(hub).onMessage({ type: 'result', is_error: true })

    expect(payloads(ws).map((p) => p.kind)).toEqual(['cli'])
    expect(inbox).toEqual([{ type: 'done', key: KEY, ok: false }])
  })
})
