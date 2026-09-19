// 推送扇出（push/fanout.ts）的三块纯逻辑：
// - sessionNameOf：会话显示名的多级回退（spawnOpts.cwd → key 内嵌 cwd → nameCwd 缓存 →
//   slug 末段 → key 截断），推送/审批页共用
// - approvalPageHtml：webhook 一键审批确认页——工具名/摘要/会话名全部转义（XSS 面），
//   能力 secret 只经页面 URL 传递、绝不写进 HTML
// - fanoutPush：inbox 事件 → 推送载荷装配与类型过滤（snapshot/approval_resolved 不推送）
// webhook 通道走 config.pushWebhooks 改写 + 全局 fetch 捕获（vapid.test.ts 同款模式），
// 零真实出站；订阅表本机为空（subscriptionCount=0），web push 腿不产生捕获。

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { config } from '../config'
import { getHub, hubs } from '../hub/registry'
import type { PendingApproval } from '../hub/types'
import { approvalPageHtml, fanoutPush, sessionNameOf } from './fanout'

const usedKeys: string[] = []

function track(key: string): string {
  usedKeys.push(key)
  return key
}

afterEach(() => {
  for (const key of usedKeys.splice(0)) hubs.delete(key)
})

describe('sessionNameOf：显示名多级回退', () => {
  test('Hub 的 spawnOpts.cwd 优先，尾部斜杠剥除', () => {
    const key = track('n|%2Ftmp%2Ffanout-name')
    const hub = getHub(key)
    hub.spawnOpts = { cwd: '/home/user/proj/' }
    expect(sessionNameOf(key)).toBe('proj')
  })

  test('n|/b|/xn| key：cwd 内嵌在 key 里，零 I/O 取 basename', () => {
    expect(sessionNameOf(track(`n|${encodeURIComponent('/tmp/demo-app')}`))).toBe('demo-app')
    expect(sessionNameOf(track(`b|${encodeURIComponent('/tmp/feat-x')}|sid-1`))).toBe('feat-x')
    expect(sessionNameOf(track(`xn|${encodeURIComponent('/work/codex-proj')}`))).toBe('codex-proj')
  })

  test('s| key 无 Hub：slug 末段近似（slug 是 sanitizePath(cwd)）', () => {
    // 无 Hub 时不会触发 parseKey 的 listSessions 全盘扫描
    expect(sessionNameOf('s|-home-user-shop|sid-9')).toBe('shop')
  })

  test('s| key 有 Hub：nameCwd 缓存命中直接用；缓存空串（已查过未知）落 slug 末段', () => {
    const key = track('s|-whatever-slug|sid-cached')
    const hub = getHub(key)
    hub.nameCwd = '/real/checkout'
    expect(sessionNameOf(key)).toBe('checkout')
    // '' = 已反查过但未知：不再查盘，回退 slug 末段
    hub.nameCwd = ''
    expect(sessionNameOf(key)).toBe('slug')
  })

  test('x| key：Hub.nameCwd 命中取 basename；无 Hub 无句柄落 key 截断', () => {
    const key = track('x|thread-with-a-long-id-0123456789abcdef')
    expect(sessionNameOf(key)).toBe(key.slice(0, 18))
    const hub = getHub(key)
    hub.nameCwd = '/work/repo'
    expect(sessionNameOf(key)).toBe('repo')
  })

  test('不可解析 key：截断兜底不抛', () => {
    expect(sessionNameOf('totally-unparseable-garbage-key')).toBe('totally-unparseabl')
    expect(sessionNameOf('x')).toBe('x')
  })
})

describe('approvalPageHtml：webhook 审批确认页', () => {
  const key = `n|${encodeURIComponent('/tmp/fanout-page')}`

  test('pending：会话名/工具名/摘要渲染，允许拒绝按钮齐备', () => {
    const pending: PendingApproval = {
      requestId: 'r1',
      toolName: 'Bash',
      input: { command: 'echo hi' },
    }
    const html = approvalPageHtml(key, pending)
    expect(html).toContain('需要审批 · Bash')
    expect(html).toContain('fanout-page')
    expect(html).toContain('echo hi')
    expect(html).toContain("act('allow')")
    expect(html).toContain("act('deny')")
  })

  test('工具名/输入/会话名中的 HTML 注入全部转义', () => {
    // 目录名取 basename（split('/')），注入串本身不能含 '/'
    const xssKey = `n|${encodeURIComponent('/tmp/<script>alert(3)')}`
    const pending: PendingApproval = {
      requestId: 'r-xss',
      toolName: '<img src=x onerror=alert(1)>',
      input: { command: 'echo "</pre><script>alert(2)</script>"' },
    }
    const html = approvalPageHtml(xssKey, pending)
    // 断言原始可执行形态（尖括号未转义）不出现；页面自带的 act() <script> 块不含这些串
    expect(html).not.toContain('<img src=x')
    expect(html).not.toContain('</pre><script>alert(2)</script>')
    expect(html).not.toContain('<script>alert(3)')
    // 转义形态保留可见文本（escapeHtml 不转义括号，onerror 属性随标签一并失活）
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;')
    expect(html).toContain('&lt;script&gt;alert(3)')
  })

  test('能力 secret 不落 HTML：页面 JS 从自身 URL 读 s 参数', () => {
    const pending: PendingApproval = { requestId: 'r1', toolName: 'Bash', input: {} }
    const html = approvalPageHtml(key, pending)
    // HTML 里只有参数名拼接（'&s='+），绝无 base64url 形态的 secret 值
    expect(html).not.toMatch(/[?&]s=[A-Za-z0-9_-]{8,}/)
    expect(html).toContain("p.get('s')")
  })

  test('无 pending（已裁决/不存在）：提示页无操作按钮', () => {
    const html = approvalPageHtml(key, undefined)
    expect(html).toContain('审批已处理')
    expect(html).not.toContain('<button')
  })
})

// ---------- fanoutPush：载荷装配与类型过滤 ----------

interface CapturedReq {
  url: string
  method: string
  headers: Record<string, string>
  body: string
}

const captured: CapturedReq[] = []
const realFetch = globalThis.fetch
const realWebhooks = config.pushWebhooks
const realPublicUrl = config.publicUrl

function captureFetch(): void {
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : (input as Request).url
    const headers: Record<string, string> = {}
    new Headers(init?.headers).forEach((v, k) => {
      headers[k] = v
    })
    captured.push({ url, method: init?.method ?? 'GET', headers, body: typeof init?.body === 'string' ? init.body : '' })
    return new Response('ok', { status: 200 })
  }) as unknown as typeof fetch
}

/** fanoutPush 是 fire-and-forget：轮询捕获队列直到够数（或超时失败） */
async function flushUntil(n: number): Promise<void> {
  for (let i = 0; i < 100 && captured.length < n; i++) {
    await new Promise((r) => setTimeout(r, 10))
  }
}

/** 反向断言用：确认安静期内无任何捕获 */
async function expectQuiet(): Promise<void> {
  await new Promise((r) => setTimeout(r, 80))
  expect(captured).toEqual([])
}

interface NtfyBody {
  topic: string
  title: string
  message: string
  click?: string
  actions?: Array<{ label: string; url: string }>
}

describe('fanoutPush：inbox 事件 → 推送载荷', () => {
  beforeEach(() => {
    captured.length = 0
    captureFetch()
    config.publicUrl = 'https://push.test'
    config.pushWebhooks = [{ type: 'ntfy', server: 'https://ntfy.test.invalid', topic: 't-fanout' }]
  })

  afterEach(() => {
    globalThis.fetch = realFetch
    config.pushWebhooks = realWebhooks
    config.publicUrl = realPublicUrl
  })

  test('approval：标题带工具名、正文是 会话｜摘要，动作 URL 装配 key/requestId/决策/能力密钥', async () => {
    const key = track(`n|${encodeURIComponent('/tmp/fanout-proj')}`)
    fanoutPush({ type: 'approval', key, requestId: 'req-1', toolName: 'Bash', input: { command: 'echo hi' } })
    await flushUntil(1)

    expect(captured).toHaveLength(1)
    expect(captured[0].url).toBe('https://ntfy.test.invalid/')
    const body = JSON.parse(captured[0].body) as NtfyBody
    expect(body.title).toBe('需要审批 · Bash')
    expect(body.message).toBe('fanout-proj｜echo hi')
    expect(body.click).toBe(`https://push.test/#s=${encodeURIComponent(key)}`)
    expect(body.actions).toHaveLength(2)
    const [allow, deny] = body.actions as Array<{ label: string; url: string }>
    for (const [action, d] of [[allow, 'allow'], [deny, 'deny']] as const) {
      const u = new URL(action.url)
      expect(u.origin).toBe('https://push.test')
      expect(u.pathname).toBe('/api/approval-action')
      expect(u.searchParams.get('k')).toBe(key)
      expect(u.searchParams.get('r')).toBe('req-1')
      expect(u.searchParams.get('d')).toBe(d)
      expect(u.searchParams.get('s')).toBeTruthy() // 能力密钥已按渠道补全
    }
  })

  test('done：ok/fail 标题分叉，正文引导查看结果', async () => {
    const key = track(`n|${encodeURIComponent('/tmp/fanout-proj')}`)
    fanoutPush({ type: 'done', key, ok: true })
    fanoutPush({ type: 'done', key, ok: false })
    await flushUntil(2)

    const [ok, fail] = captured.map((c) => JSON.parse(c.body) as NtfyBody)
    expect(ok.title).toBe('✓ 完成 · fanout-proj')
    expect(fail.title).toBe('✗ 结束（有错） · fanout-proj')
    expect(ok.message).toBe('会话已空闲，点击查看结果')
  })

  test('error：标题带告警，正文截断 300 字符', async () => {
    const key = track(`n|${encodeURIComponent('/tmp/fanout-proj')}`)
    fanoutPush({ type: 'error', key, message: 'x'.repeat(400) })
    await flushUntil(1)

    const body = JSON.parse(captured[0].body) as NtfyBody
    expect(body.title).toBe('⚠ 出错 · fanout-proj')
    expect(body.message).toHaveLength(300)
  })

  test('snapshot 与 approval_resolved 不推送（快照只给新连接，裁决通知靠 tag 替换语义）', async () => {
    const key = track(`n|${encodeURIComponent('/tmp/fanout-proj')}`)
    fanoutPush({ type: 'snapshot', states: [], approvals: [] })
    fanoutPush({ type: 'approval_resolved', key, requestId: 'req-1' })
    await expectQuiet()
  })

  test('零订阅且零 webhook：早退，连载荷装配都不发生', async () => {
    config.pushWebhooks = []
    const key = track(`n|${encodeURIComponent('/tmp/fanout-proj')}`)
    fanoutPush({ type: 'done', key, ok: true })
    await expectQuiet()
  })
})
