import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { cliSidechainToHistory, copyText, statusLineOf } from './chatText'
import type { SessionState } from '@anyplane/protocol'

const baseState: SessionState = { spawned: false, busy: false }

describe('statusLineOf 早退链（优先级即源码顺序）', () => {
  test('未连接最先', () => {
    expect(statusLineOf({ ...baseState, busy: true }, { connected: false, waiting: true, phase: 'requesting' })).toBe('连接中…')
  })
  test('compacting 保持最优先；waiting 压过 requesting phase（等审批不再是「请求中」）', () => {
    expect(statusLineOf({ ...baseState, busy: true }, { connected: true, waiting: true, phase: 'compacting' })).toBe('压缩上下文…')
    expect(statusLineOf(baseState, { connected: true, waiting: true, phase: 'requesting' })).toBe('等待审批')
    // 未知 phase 原样透传（无 waiting/后台任务时仍由 phase 兜底）
    expect(statusLineOf(baseState, { connected: true, waiting: false, phase: 'whatever' })).toBe('whatever…')
  })
  test('activeTaskCount 压过 requesting phase 与 busy（后台任务活着时「工作中」才是真相）', () => {
    expect(statusLineOf({ ...baseState, busy: true, activeTaskCount: 2 }, { connected: true, waiting: false, phase: 'requesting' })).toBe('2 个后台任务运行中')
    expect(statusLineOf({ ...baseState, busy: true, activeTaskCount: 2 }, { connected: true, waiting: false })).toBe('2 个后台任务运行中')
  })
  test('waiting 区分 tailing', () => {
    expect(statusLineOf(baseState, { connected: true, waiting: true })).toBe('等待审批')
    expect(statusLineOf({ ...baseState, tailing: true }, { connected: true, waiting: true })).toBe('外部会话等待操作')
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
  test('assistant 侧链：role 由 type 透传，块映射委托 cliContentToHistoryBlocks', () => {
    // 块映射本身的夹具对拍在 contentBlocks.lockstep.ts（web ↔ server 同形），这里只钉接线与 role 透传
    const h = cliSidechainToHistory({
      type: 'assistant',
      uuid: 'a1',
      message: { content: [{ type: 'text', text: '答' }] },
    })
    expect(h?.role).toBe('assistant')
    expect(h?.blocks).toEqual([{ kind: 'text', text: '答' }])
  })
})

// onImage 闸：桶转录里的图片只放行本站 /api/uploads/<16 位小写 hex>.<jpg|png|gif|webp>
// （服务端已把 localImage 解析成该形态）；其余一律丢弃——此前无承接方时图片被静默丢弃，
// 放开承接后闸本身成了唯一防线，逐类钉住。
describe('cliSidechainToHistory 的 onImage URL 闸', () => {
  const imgOnly = (c: Record<string, unknown>) => ({ type: 'user', message: { content: [c] } })

  test('本站 uploads 相对路径四种扩展名全部放行', () => {
    for (const ext of ['jpg', 'png', 'gif', 'webp']) {
      const url = `/api/uploads/0123456789abcdef.${ext}`
      const h = cliSidechainToHistory(imgOnly({ type: 'image', url }))
      expect(h?.blocks).toEqual([{ kind: 'image', src: url }])
    }
  })

  test('绝对 URL / 非 uploads 路径 / 白名单外扩展名 / hex 形状不符：一律丢弃（块空则整条 null）', () => {
    for (const url of [
      'https://evil.example.com/api/uploads/0123456789abcdef.png', // 只放行同源相对路径
      '/api/other/0123456789abcdef.png',
      '/api/uploads/0123456789abcdef.svg',
      '/api/uploads/0123456789abcdef.jpeg', // jpeg 不在白名单
      '/api/uploads/0123456789abc.png', // 不足 16 位
      '/api/uploads/0123456789ABCDEF.png', // 大写 hex 不符
    ]) {
      expect(cliSidechainToHistory(imgOnly({ type: 'image', url }))).toBeNull()
    }
  })

  test('url 缺失丢弃；混合内容只落合法块', () => {
    expect(cliSidechainToHistory(imgOnly({ type: 'image' }))).toBeNull()
    const h = cliSidechainToHistory({
      type: 'user',
      message: {
        content: [
          { type: 'text', text: '看图' },
          { type: 'image', url: 'https://x.example.com/api/uploads/0123456789abcdef.png' },
        ],
      },
    })
    expect(h?.blocks).toEqual([{ kind: 'text', text: '看图' }])
  })
})

// copyText 降级链：clipboard API（仅安全上下文）→ textarea+execCommand 回退 → false。
// bun test 无 document，回退路径在此环境必败——恰好钉住「回退也失败时如实返回 false」。
describe('copyText', () => {
  let saved: PropertyDescriptor | undefined

  beforeEach(() => {
    saved = Object.getOwnPropertyDescriptor(navigator, 'clipboard')
  })

  afterEach(() => {
    if (saved) Object.defineProperty(navigator, 'clipboard', saved)
    else delete (navigator as { clipboard?: unknown }).clipboard
  })

  test('clipboard API 可用且成功：返回 true，文本逐字透传', async () => {
    const seen: string[] = []
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: async (t: string) => void seen.push(t) },
    })
    await expect(copyText('hello\n多行')).resolves.toBe(true)
    expect(seen).toEqual(['hello\n多行'])
  })

  test('clipboard 拒绝（权限等）→ 走回退；回退也失败（无 DOM）→ false 而非抛错', async () => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: async () => {
          throw new Error('denied')
        },
      },
    })
    await expect(copyText('x')).resolves.toBe(false)
  })

  test('clipboard 缺席（http 局域网非安全上下文）→ 直接回退 → false', async () => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined })
    await expect(copyText('x')).resolves.toBe(false)
  })
})
