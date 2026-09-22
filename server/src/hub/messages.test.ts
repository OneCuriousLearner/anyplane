// WS 上行消息编排的高风险边界：
// - 非 JSON 帧只丢弃，不把异常抛回 socket 处理器
// - attach 的审批与 CLI 断线补发严格单播，缺口显式通知发起方
// - transition=rewind 时 user 消息同步拒绝，不解析/启动任何真实后端

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { InboxEvent } from '@anyplane/protocol'
import { claudePort } from '../backends/claude/port'
import { codexPort } from '../backends/codex/port'
import { processManager } from '../backends/claude/processManager'
import type { BackendPort } from '../backends/port'
import { registerBackend } from '../backends/port'
import { MAX_IMAGE_BASE64 } from '../uploads'
import { resetInboxSinkForTest, setInboxSink } from './broadcast'
import { handleClientMessage } from './messages'
import { getHub, hubs } from './registry'
import type { Hub } from './types'

const KEY = 'n|%2Ftmp%2Fmessages-test'

interface FakeWs {
  sent: string[]
  send(text: string): void
}

function fakeWs(): FakeWs {
  return { sent: [], send(text: string) { this.sent.push(text) } }
}

function payloads(ws: FakeWs): Array<Record<string, unknown>> {
  return ws.sent.map((text) => JSON.parse(text) as Record<string, unknown>)
}

function freshHub(): Hub {
  hubs.delete(KEY)
  return getHub(KEY)
}

const inbox: InboxEvent[] = []
const sessionMap = () => (processManager as unknown as { sessions: Map<string, unknown> }).sessions

beforeEach(() => {
  inbox.length = 0
  setInboxSink({ publish: (event) => inbox.push(event) })
  // user/approval 路径的 pushStatus 走真实注册表（resolvePort 注入只覆盖分发臂）：
  // 注册真实适配器，镜像 index.ts 装配（幂等；port.test.ts 跑过 resetBackendsForTest 后本文件仍自足）
  registerBackend('claude', claudePort)
  registerBackend('codex', codexPort)
})

afterEach(() => {
  resetInboxSinkForTest()
  hubs.delete(KEY)
  sessionMap().delete(KEY)
})

describe('handleClientMessage', () => {
  test('非法 JSON 不抛且不解析后端', () => {
    const hub = freshHub()
    let resolved = 0
    const resolvePort = () => {
      resolved++
      return {} as BackendPort
    }

    expect(() => handleClientMessage(hub, '{"kind":', undefined, resolvePort)).not.toThrow()
    expect(resolved).toBe(0)
  })

  test('attach 审批与 CLI 补发只发给发起连接，replay gap 也仅单播', () => {
    const hub = freshHub()
    const target = fakeWs()
    const peer = fakeWs()
    hub.clients.add(target as never)
    hub.clients.add(peer as never)
    hub.pendingApprovals.set('approval-1', {
      requestId: 'approval-1',
      toolName: 'Bash',
      input: { command: 'git status' },
    })
    hub.cliSeq = 5
    hub.cliRing = [
      { seq: 4, payload: { kind: 'cli', seq: 4, msg: { type: 'assistant', text: 'four' } } },
      { seq: 5, payload: { kind: 'cli', seq: 5, msg: { type: 'result', is_error: false } } },
    ]

    let attaches = 0
    const fakePort = {
      onAttach: () => {
        attaches++
      },
    } as unknown as BackendPort
    handleClientMessage(
      hub,
      JSON.stringify({ kind: 'attach', fromSeq: 2 }),
      target as never,
      () => fakePort,
    )

    expect(attaches).toBe(1)
    expect(peer.sent).toEqual([])
    expect(payloads(target)).toEqual([
      {
        kind: 'approval_request',
        requestId: 'approval-1',
        toolName: 'Bash',
        input: { command: 'git status' },
      },
      { kind: 'cli', seq: 4, msg: { type: 'assistant', text: 'four' }, replay: true },
      { kind: 'cli', seq: 5, msg: { type: 'result', is_error: false }, replay: true },
      { kind: 'replay_gap', fromSeq: 2 },
    ])
    expect(hub.cliSeq).toBe(5)
    expect(hub.cliRing).toHaveLength(2)
  })

  test('transition=rewind 拒绝 user，且不会触发 ensureForSend 或真实 CLI', () => {
    const hub = freshHub()
    const ws = fakeWs()
    hub.clients.add(ws as never)
    hub.transition = { kind: 'rewind' }

    let ensures = 0
    const fakePort = {
      ensureForSend: async () => {
        ensures++
        return undefined
      },
    } as unknown as BackendPort
    handleClientMessage(
      hub,
      JSON.stringify({ kind: 'user', text: 'must not send' }),
      ws as never,
      () => fakePort,
    )

    expect(ensures).toBe(0)
    expect(payloads(ws)).toEqual([
      { kind: 'error', message: '正在恢复文件，请等待回滚完成后再发送消息' },
    ])
  })
})

/** user 发送路径是 fire-and-forget IIFE：轮询等异步臂落定，超时即失败 */
async function untilOk(label: string, cond: () => boolean): Promise<void> {
  const deadline = Date.now() + 3000
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`等待超时: ${label}`)
    await Bun.sleep(2)
  }
}

describe('handleClientMessage user 附件校验与发送路径', () => {
  test('不支持的图片类型 → 错误广播，不启动懒 spawn', () => {
    const hub = freshHub()
    const ws = fakeWs()
    hub.clients.add(ws as never)

    let ensures = 0
    const fakePort = {
      ensureForSend: async () => {
        ensures++
        return undefined
      },
    } as unknown as BackendPort
    handleClientMessage(
      hub,
      JSON.stringify({
        kind: 'user',
        text: 'x',
        attachments: [{ name: 'a.svg', mediaType: 'image/svg+xml', dataBase64: 'QQ==' }],
      }),
      ws as never,
      () => fakePort,
    )

    expect(ensures).toBe(0)
    expect(payloads(ws)).toEqual([
      { kind: 'error', message: '不支持的图片类型 image/svg+xml（支持 jpeg/png/gif/webp）' },
    ])
  })

  test('图片超 5MB → 错误广播（缺省 mediaType 归一为 image/png 后仍按大小闸）', () => {
    const hub = freshHub()
    const ws = fakeWs()
    hub.clients.add(ws as never)

    let ensures = 0
    const fakePort = {
      ensureForSend: async () => {
        ensures++
        return undefined
      },
    } as unknown as BackendPort
    handleClientMessage(
      hub,
      JSON.stringify({
        kind: 'user',
        text: 'x',
        attachments: [{ name: 'big.png', dataBase64: 'x'.repeat(MAX_IMAGE_BASE64 + 1) }],
      }),
      ws as never,
      () => fakePort,
    )

    expect(ensures).toBe(0)
    expect(payloads(ws)).toEqual([{ kind: 'error', message: '图片超过 5MB 限制（big.png）' }])
  })

  test('happy path：ensureForSend → sendUserText 直通文本/sendMode/附件，随后 afterUserSent 与状态推送', async () => {
    const hub = freshHub()
    const ws = fakeWs()
    hub.clients.add(ws as never)

    const events: string[] = []
    let sent: { text: string; mode: unknown; atts: unknown } | undefined
    const fakePort = {
      ensureForSend: async () => ({
        sendUserText: (text: string, mode: unknown, atts: unknown) => {
          sent = { text, mode, atts }
          events.push('send')
        },
      }),
      afterUserSent: () => events.push('afterUserSent'),
    } as unknown as BackendPort
    handleClientMessage(
      hub,
      JSON.stringify({
        kind: 'user',
        text: 'hello',
        sendMode: 'steer',
        attachments: [{ name: 'a.png', mediaType: 'image/png', dataBase64: 'QQ==' }],
      }),
      ws as never,
      () => fakePort,
    )

    await untilOk('sendUserText', () => sent !== undefined)
    expect(sent).toEqual({
      text: 'hello',
      mode: 'steer',
      atts: [{ name: 'a.png', mediaType: 'image/png', dataBase64: 'QQ==' }],
    })
    expect(events).toEqual(['send', 'afterUserSent'])
    // pushStatus 殿后：真实注册表（beforeEach 已注册 claudePort）派生 SessionState
    await untilOk('status 推送', () => payloads(ws).some((p) => p.kind === 'status'))
  })

  test('非法 sendMode 归一为 undefined 再下发（协议外取值不透传）', async () => {
    const hub = freshHub()
    let mode: unknown = 'untouched'
    const fakePort = {
      ensureForSend: async () => ({
        sendUserText: (_text: string, m: unknown) => {
          mode = m
        },
      }),
    } as unknown as BackendPort
    handleClientMessage(
      hub,
      JSON.stringify({ kind: 'user', text: 'x', sendMode: 'bogus' }),
      undefined,
      () => fakePort,
    )

    await untilOk('sendUserText', () => mode !== 'untouched')
    expect(mode).toBeUndefined()
  })

  test('ensureForSend 未就绪返回 undefined → 不再发送（具体错误由适配器自行广播）', async () => {
    const hub = freshHub()
    const ws = fakeWs()
    hub.clients.add(ws as never)
    let sends = 0
    const fakePort = {
      ensureForSend: async () => undefined,
      afterUserSent: () => {
        sends++
      },
    } as unknown as BackendPort
    handleClientMessage(hub, JSON.stringify({ kind: 'user', text: 'x' }), ws as never, () => fakePort)

    await Bun.sleep(20) // 给异步臂一个落定窗口（无事件可等——钉的正是"什么都不发生"）
    expect(sends).toBe(0)
    expect(ws.sent).toEqual([]) // hub 层不追加任何广播（错误卡是适配器的职责）
  })

  test('ensureForSend 抛错 → 广播发送失败错误卡（fire-and-forget 不许变 unhandled rejection）', async () => {
    const hub = freshHub()
    const ws = fakeWs()
    hub.clients.add(ws as never)
    const fakePort = {
      ensureForSend: async () => {
        throw new Error('spawn exploded')
      },
    } as unknown as BackendPort
    handleClientMessage(hub, JSON.stringify({ kind: 'user', text: 'x' }), ws as never, () => fakePort)

    await untilOk('错误卡', () => payloads(ws).some((p) => p.kind === 'error'))
    expect(payloads(ws)[0]).toEqual({ kind: 'error', message: '发送失败: spawn exploded' })
  })
})

describe('handleClientMessage control / update_env 的 spawnOpts 缓存', () => {
  test('set_model 与 set_permission_mode 先缓存最终选择再直通 deliverControl（懒 spawn 首条消息应用）', () => {
    const hub = freshHub()
    const delivered: Array<[string, Record<string, unknown>]> = []
    const fakePort = {
      deliverControl: (_hub: Hub, subtype: string, extra: Record<string, unknown>) => {
        delivered.push([subtype, extra])
      },
    } as unknown as BackendPort

    handleClientMessage(hub, JSON.stringify({ kind: 'control', subtype: 'set_model', extra: { model: 'opus' } }), undefined, () => fakePort)
    handleClientMessage(hub, JSON.stringify({ kind: 'control', subtype: 'set_permission_mode', extra: { mode: 'plan' } }), undefined, () => fakePort)

    expect(hub.spawnOpts).toEqual({ model: 'opus', permissionMode: 'plan' })
    expect(delivered).toEqual([
      ['set_model', { model: 'opus' }],
      ['set_permission_mode', { mode: 'plan' }],
    ])
  })

  test('transition=rewind 期间 rewind_files 被拒且不直通（组合回滚不得竞争）', () => {
    const hub = freshHub()
    const ws = fakeWs()
    hub.clients.add(ws as never)
    hub.transition = { kind: 'rewind' }

    let delivered = 0
    const fakePort = {
      deliverControl: () => {
        delivered++
      },
    } as unknown as BackendPort
    handleClientMessage(hub, JSON.stringify({ kind: 'control', subtype: 'rewind_files' }), ws as never, () => fakePort)

    expect(delivered).toBe(0)
    expect(payloads(ws)).toEqual([{ kind: 'error', message: '已有回滚操作正在进行' }])
  })

  test('update_env 的 CLAUDE_CODE_EFFORT_LEVEL 缓存进 spawnOpts.effort，变量原样直通', () => {
    const hub = freshHub()
    let updated: Record<string, string> | undefined
    const fakePort = {
      updateEnv: (_hub: Hub, variables: Record<string, string>) => {
        updated = variables
      },
    } as unknown as BackendPort
    handleClientMessage(
      hub,
      JSON.stringify({ kind: 'update_env', variables: { CLAUDE_CODE_EFFORT_LEVEL: 'high', OTHER: '1' } }),
      undefined,
      () => fakePort,
    )

    expect(hub.spawnOpts).toEqual({ effort: 'high' })
    expect(updated).toEqual({ CLAUDE_CODE_EFFORT_LEVEL: 'high', OTHER: '1' })
  })
})

describe('handleClientMessage 能力闸（capabilities 是唯一权威）', () => {
  test('branch 未声明能力 → 错误广播，不调用 port.branch', () => {
    const hub = freshHub()
    const ws = fakeWs()
    hub.clients.add(ws as never)

    let branches = 0
    const fakePort = {
      capabilities: { branch: false, queries: [] },
      branch: () => {
        branches++
      },
    } as unknown as BackendPort
    handleClientMessage(hub, JSON.stringify({ kind: 'branch', name: 'x' }), ws as never, () => fakePort)

    expect(branches).toBe(0)
    expect(payloads(ws)).toEqual([
      { kind: 'error', message: '当前后端不支持会话分叉（可从「回滚」面板从此处分叉）' },
    ])
  })

  test('branch 声明能力 → port.branch 收到名字（声明即契约，! 断言 fail fast）', () => {
    const hub = freshHub()
    let name: string | undefined
    const fakePort = {
      capabilities: { branch: true, queries: [] },
      branch: (_hub: Hub, n: string) => {
        name = n
      },
    } as unknown as BackendPort
    handleClientMessage(hub, JSON.stringify({ kind: 'branch', name: '试验叉' }), undefined, () => fakePort)

    expect(name).toBe('试验叉')
  })

  test('rewind_both 无文件检查点能力 → 错误广播（codex 路径）', () => {
    const hub = freshHub()
    const ws = fakeWs()
    hub.clients.add(ws as never)

    let rewinds = 0
    const fakePort = {
      capabilities: { fileCheckpoint: false, queries: [] },
      rewindBoth: () => {
        rewinds++
      },
    } as unknown as BackendPort
    handleClientMessage(hub, JSON.stringify({ kind: 'rewind_both', userMessageId: 'u1' }), ws as never, () => fakePort)

    expect(rewinds).toBe(0)
    expect(payloads(ws)).toEqual([
      { kind: 'error', message: '当前后端没有文件检查点，不支持文件回滚（可用 git 管理代码历史）' },
    ])
  })

  test('rewind_conversation 缺 userMessageId → 静默丢弃，不解析端口', () => {
    const hub = freshHub()
    let resolved = 0
    const resolvePort = () => {
      resolved++
      return {} as BackendPort
    }
    handleClientMessage(hub, JSON.stringify({ kind: 'rewind_conversation' }), undefined, resolvePort)
    expect(resolved).toBe(0)
  })
})

describe('handleClientMessage btw / query / approval', () => {
  test('btw 先播 btw_pending 再交适配器（前端卡片靠 pending 创建，晚播会被静默丢弃）', () => {
    const hub = freshHub()
    const ws = fakeWs()
    hub.clients.add(ws as never)

    const events: string[] = []
    const orderedWs = {
      send(text: string) {
        events.push(`ws:${(JSON.parse(text) as { kind: string }).kind}`)
      },
    }
    hub.clients.add(orderedWs as never)
    let question: string | undefined
    const fakePort = {
      btw: (_hub: Hub, q: string) => {
        events.push('port:btw')
        question = q
      },
    } as unknown as BackendPort
    handleClientMessage(hub, JSON.stringify({ kind: 'btw', question: '  带空格的问题  ' }), undefined, () => fakePort)

    expect(events).toEqual(['ws:btw_pending', 'port:btw'])
    expect(question).toBe('带空格的问题') // trim 后下发
  })

  test('btw 空问题不播 pending（避免无配对孤儿卡），但仍交适配器做权威校验', () => {
    const hub = freshHub()
    const ws = fakeWs()
    hub.clients.add(ws as never)

    let question: string | undefined
    const fakePort = {
      btw: (_hub: Hub, q: string) => {
        question = q
      },
    } as unknown as BackendPort
    handleClientMessage(hub, JSON.stringify({ kind: 'btw', question: '   ' }), ws as never, () => fakePort)

    expect(payloads(ws)).toEqual([]) // 无 btw_pending
    expect(question).toBe('')
  })

  test('query 不在能力白名单 → reply ok:false；在白名单 → 直通且应答带 id', () => {
    const hub = freshHub()
    const ws = fakeWs()
    hub.clients.add(ws as never)

    const queried: string[] = []
    const fakePort = {
      capabilities: { queries: ['get_settings'] },
      query: (_hub: Hub, q: string, _extra: Record<string, unknown>, reply: (p: unknown) => void) => {
        queried.push(q)
        reply({ ok: true, data: { model: 'opus' } })
      },
    } as unknown as BackendPort
    handleClientMessage(hub, JSON.stringify({ kind: 'query', id: 'q1', query: 'mcp_status' }), ws as never, () => fakePort)
    handleClientMessage(hub, JSON.stringify({ kind: 'query', id: 'q2', query: 'get_settings' }), ws as never, () => fakePort)

    expect(queried).toEqual(['get_settings']) // 白名单外的不到适配器
    expect(payloads(ws)).toEqual([
      { kind: 'query_result', id: 'q1', ok: false, error: '当前后端不支持 mcp_status 查询' },
      { kind: 'query_result', id: 'q2', ok: true, data: { model: 'opus' } },
    ])
  })

  test('query 缺 id 或 query → 静默丢弃，不解析端口', () => {
    const hub = freshHub()
    let resolved = 0
    const resolvePort = () => {
      resolved++
      return {} as BackendPort
    }
    handleClientMessage(hub, JSON.stringify({ kind: 'query', query: 'get_settings' }), undefined, resolvePort)
    handleClientMessage(hub, JSON.stringify({ kind: 'query', id: 'q3' }), undefined, resolvePort)
    expect(resolved).toBe(0)
  })

  test('approval 有存活会话 → 决定经 sendApproval 投递', () => {
    const hub = freshHub()
    hub.pendingApprovals.set('r2', { requestId: 'r2', toolName: 'Write', input: {} })

    const delivered: Array<[string, unknown]> = []
    sessionMap().set(KEY, {
      key: KEY,
      exited: false,
      sendApproval: (requestId: string, decision: unknown) => delivered.push([requestId, decision]),
      notifyExternalGate: () => {},
    })

    const decision = { behavior: 'deny', message: '不行' }
    handleClientMessage(hub, JSON.stringify({ kind: 'approval', requestId: 'r2', decision }))

    expect(delivered).toEqual([['r2', decision]])
    expect(hub.pendingApprovals.size).toBe(0)
  })
})
