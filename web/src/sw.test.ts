// sw.js 的审批通知分支测试。放在 src 下而非 public 旁边：public 会被原样拷进 web/dist，
// 测试文件不能进生产构建。sw.js 仍是唯一正本，这里读源码在 stub 过的 self 上执行。
//
// 被锁住的行为：Safari（iOS/macOS）与旧 Firefox 桌面忽略通知 actions，按钮路径在这些平台
// 必须降级为「点击直达 GET 确认页」，否则用户看到「需要审批」却无从裁决。
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const SW_SRC = readFileSync(join(import.meta.dir, '..', 'public', 'sw.js'), 'utf8')

const ORIGIN = 'http://localhost:7480'
const ACTIONS = {
  allow: '/api/approval-action?k=s%7Cslug%7Csid&r=req-1&d=allow&s=cap-secret',
  deny: '/api/approval-action?k=s%7Cslug%7Csid&r=req-1&d=deny&s=cap-secret',
}

interface Shown {
  title: string
  opts: {
    body: string
    actions: Array<{ action: string; title: string }>
    data: { key?: string; requestId?: string; actions?: typeof ACTIONS; page?: string }
  }
}

/** 在 stub 的 self 上执行 sw.js，返回事件处理器与通知收集器。
 *  maxActions 传 undefined 模拟 Safari（属性不存在），传数字模拟 Chromium。 */
function loadSw(maxActions: number | undefined) {
  const handlers: Record<string, (e: unknown) => void> = {}
  const shown: Shown[] = []
  const opened: string[] = []
  const self_ = {
    addEventListener: (type: string, h: (e: unknown) => void) => {
      handlers[type] = h
    },
    Notification: maxActions === undefined ? {} : { maxActions },
    location: { origin: ORIGIN },
    registration: {
      showNotification: (title: string, opts: Shown['opts']) => {
        shown.push({ title, opts })
      },
    },
    clients: {
      claim: () => {},
      matchAll: async () => [],
      openWindow: async (u: string) => {
        opened.push(u)
      },
    },
  }
  new Function('self', SW_SRC)(self_)
  return { handlers, shown, opened }
}

function pushEvent(payload: unknown) {
  return { data: { json: () => payload }, waitUntil: (p: unknown) => p }
}

const APPROVAL_PAYLOAD = {
  type: 'approval',
  title: '需要审批 · Bash',
  body: 'anyplane｜git status',
  key: 's|slug|sid',
  requestId: 'req-1',
  actions: ACTIONS,
  tag: 'ccr-a-req-1',
}

describe('sw.js 审批通知：支持按钮的平台（Chromium）', () => {
  test('挂载 allow/deny 按钮，body 不加引导，data.page 不生成', () => {
    const { handlers, shown } = loadSw(2)
    handlers.push!(pushEvent(APPROVAL_PAYLOAD))
    expect(shown).toHaveLength(1)
    const { opts } = shown[0]!
    expect(opts.actions.map((a) => a.action)).toEqual(['allow', 'deny'])
    expect(opts.body).toBe('anyplane｜git status')
    expect(opts.data.page).toBeUndefined()
  })
})

describe('sw.js 审批通知：忽略按钮的平台（Safari / 旧 Firefox 桌面）', () => {
  test('不挂按钮，body 折入引导，data.page 指向同 secret 的 GET 确认页', () => {
    const { handlers, shown } = loadSw(undefined)
    handlers.push!(pushEvent(APPROVAL_PAYLOAD))
    const { opts } = shown[0]!
    expect(opts.actions).toEqual([])
    expect(opts.body).toContain('点击本通知前往审批')
    // 复用 approval-action 的能力密钥：validSecret 同时认订阅密钥与 webhook 密钥
    const page = new URL(opts.data.page!, ORIGIN)
    expect(page.pathname).toBe('/api/approval-page')
    expect(page.searchParams.get('k')).toBe('s|slug|sid')
    expect(page.searchParams.get('r')).toBe('req-1')
    expect(page.searchParams.get('s')).toBe('cap-secret')
    // 确认页是 GET 渲染页，绝不能把裁决动作带进 URL（链接被预览抓取即误触）
    expect(page.searchParams.get('d')).toBeNull()
  })

  test('maxActions 为 1 时同样降级（按钮位不够放 allow+deny）', () => {
    const { handlers, shown } = loadSw(1)
    handlers.push!(pushEvent(APPROVAL_PAYLOAD))
    expect(shown[0]!.opts.actions).toEqual([])
    expect(shown[0]!.opts.data.page).toBeTruthy()
  })

  test('点击降级通知时打开确认页，而不是应用深链', async () => {
    const { handlers, shown, opened } = loadSw(undefined)
    handlers.push!(pushEvent(APPROVAL_PAYLOAD))
    const data = shown[0]!.opts.data
    const waits: Promise<unknown>[] = []
    handlers.notificationclick!({
      notification: { data, close: () => {} },
      action: '',
      waitUntil: (p: Promise<unknown>) => waits.push(p),
    })
    await Promise.all(waits)
    expect(opened).toHaveLength(1)
    expect(opened[0]).toContain('/api/approval-page')
  })
})

describe('sw.js 非审批通知不受降级影响', () => {
  test('done 通知在任何平台都不生成确认页，点击回会话深链', async () => {
    const { handlers, shown, opened } = loadSw(undefined)
    handlers.push!(pushEvent({ type: 'done', title: '✓ 完成', body: '会话已空闲', key: 'x|t1', tag: 'ccr-d' }))
    const { opts } = shown[0]!
    expect(opts.data.page).toBeUndefined()
    expect(opts.body).toBe('会话已空闲')
    const waits: Promise<unknown>[] = []
    handlers.notificationclick!({
      notification: { data: opts.data, close: () => {} },
      action: '',
      waitUntil: (p: Promise<unknown>) => waits.push(p),
    })
    await Promise.all(waits)
    expect(opened[0]).toBe(`/#s=${encodeURIComponent('x|t1')}`)
  })

  test('能力 URL 缺字段时不生成确认页，退回深链（不构造半截 URL）', () => {
    const { handlers, shown } = loadSw(undefined)
    handlers.push!(pushEvent({ ...APPROVAL_PAYLOAD, actions: { allow: '/api/approval-action?k=a', deny: '' } }))
    expect(shown[0]!.opts.data.page).toBeUndefined()
    expect(shown[0]!.opts.body).toBe('anyplane｜git status')
  })
})
