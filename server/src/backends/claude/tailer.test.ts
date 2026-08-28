// TranscriptTailer 的行泵语义：偏移续读、半行/多字节跨块缓冲、截断自停、rewindable 标记。
// 用真实临时文件驱动（fs.watch + 2s 轮询兜底），不碰真实 CLI。

import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { HistoryMessage } from './discovery'
import { TranscriptTailer } from './tailer'

let dir = ''
let fileSeq = 0
const tailers: TranscriptTailer[] = []

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'cc-remote-tailer-'))
})

afterEach(() => {
  // pollTimer 是活跃 setInterval，不 stop 会挂住测试进程
  for (const t of tailers.splice(0)) t.stop()
})

afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
})

function freshFile(): string {
  return join(dir, `t${fileSeq++}.jsonl`)
}

function userLine(uuid: string, text: string): string {
  return JSON.stringify({ type: 'user', uuid, message: { role: 'user', content: text } })
}

function assistantLine(uuid: string, text: string): string {
  return JSON.stringify({ type: 'assistant', uuid, message: { role: 'assistant', content: [{ type: 'text', text }] } })
}

interface Collected {
  msgs: HistoryMessage[]
  resets: number
  ticks: number
}

function makeTailer(path: string, offset?: number): { tailer: TranscriptTailer; c: Collected } {
  const c: Collected = { msgs: [], resets: 0, ticks: 0 }
  const tailer = new TranscriptTailer(path, offset, {
    onMessage: (m) => c.msgs.push(m),
    onReset: () => c.resets++,
    onTick: () => c.ticks++,
  })
  tailers.push(tailer)
  return { tailer, c }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function waitFor(cond: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('waitFor 超时')
    await sleep(20)
  }
}

/** 找出一个落在多字节 UTF-8 序列中间的切点（lead byte 之后） */
function multiByteCut(buf: Buffer): number {
  for (let i = 0; i < buf.length; i++) {
    const b = buf[i]
    if (b !== undefined && b >= 0xc0 && b < 0xf8) return i + 1
  }
  throw new Error('测试行里没有多字节字符')
}

describe('TranscriptTailer 偏移与回放', () => {
  test('未指定偏移时不回放既有内容，只推送新追加的完整消息', async () => {
    const path = freshFile()
    writeFileSync(path, userLine('u-old', '历史消息') + '\n')
    const { tailer, c } = makeTailer(path) // 与「加载历史后订阅」约定一致：从文件尾开始
    tailer.start()
    expect(c.msgs).toHaveLength(0)

    appendFileSync(path, userLine('u-new', '新提问') + '\n')
    await waitFor(() => c.msgs.length === 1)
    expect(c.msgs[0]?.uuid).toBe('u-new')
  })

  test('startOffset=0 时 start() 的初始 flush 同步回放既有完整行', () => {
    const path = freshFile()
    writeFileSync(path, [userLine('u-1', '第一条'), assistantLine('a-1', '回答')].join('\n') + '\n')
    const { tailer, c } = makeTailer(path, 0)
    tailer.start()
    expect(c.msgs.map((m) => m.uuid)).toEqual(['u-1', 'a-1'])
    expect(c.msgs[0]?.role).toBe('user')
    expect(c.msgs[1]?.role).toBe('assistant')
  })

  test('构造时文件不存在也能跟上：轮询兜底建立读取', async () => {
    const path = freshFile() // 故意不创建（pid 会话刚起步的场景）
    const { tailer, c } = makeTailer(path)
    tailer.start()
    appendFileSync(path, userLine('u-born', '文件后建') + '\n')
    await waitFor(() => c.msgs.length === 1, 5000) // watch 未建立，靠 2s 轮询发现
    expect(c.msgs[0]?.blocks[0]?.text).toBe('文件后建')
  })
})

describe('TranscriptTailer 行解析', () => {
  test('rewindable 标记：普通 user 与 assistant 可回滚，tool_result user 不可', async () => {
    const path = freshFile()
    writeFileSync(path, '')
    const { tailer, c } = makeTailer(path)
    tailer.start()
    appendFileSync(
      path,
      [
        userLine('u-text', '普通提问'),
        JSON.stringify({
          type: 'user',
          uuid: 'u-tr',
          message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] },
        }),
        assistantLine('a-1', '回答'),
      ].join('\n') + '\n',
    )
    await waitFor(() => c.msgs.length === 3)
    const byUuid = new Map(c.msgs.map((m) => [m.uuid, m]))
    expect(byUuid.get('u-text')?.rewindable).toBe(true)
    // 官方同款语义：tool_result 消息没有文件检查点
    expect(byUuid.get('u-tr')?.rewindable).toBe(false)
    expect(byUuid.get('a-1')?.rewindable).toBe(true)
  })

  test('无换行结尾的半行先缓冲，补齐换行后按完整行解析', async () => {
    const path = freshFile()
    writeFileSync(path, '')
    const { tailer, c } = makeTailer(path)
    tailer.start()
    const line = userLine('u-half', '半行缓冲')
    const cut = Math.floor(line.length / 2)
    appendFileSync(path, line.slice(0, cut)) // 无 \n：不足以成行
    await waitFor(() => c.ticks > 1) // 追加已触发一次 flush（初始 flush 是第 1 次 tick）
    expect(c.msgs).toHaveLength(0)

    appendFileSync(path, line.slice(cut) + '\n')
    await waitFor(() => c.msgs.length === 1)
    expect(c.msgs[0]?.blocks[0]?.text).toBe('半行缓冲')
  })

  test('多字节 UTF-8 字符跨两次写入切开时不产生乱码', async () => {
    const path = freshFile()
    writeFileSync(path, '')
    const { tailer, c } = makeTailer(path)
    tailer.start()
    const text = '交接简报：中文内容'
    const buf = Buffer.from(userLine('u-utf8', text) + '\n', 'utf8')
    const cut = multiByteCut(buf) // 切点落在某个汉字的字节序列中间
    appendFileSync(path, buf.subarray(0, cut))
    await waitFor(() => c.ticks > 1)
    expect(c.msgs).toHaveLength(0)

    appendFileSync(path, buf.subarray(cut))
    await waitFor(() => c.msgs.length === 1)
    // 0x0A 不出现在多字节序列里，按字节切分后拼接应还原原文（无 U+FFFD 替换字符）
    expect(c.msgs[0]?.blocks[0]?.text).toBe(text)
  })

  test('非 JSON 行与损坏 JSON 行被跳过，不影响后续正常行', async () => {
    const path = freshFile()
    writeFileSync(path, '')
    const { tailer, c } = makeTailer(path)
    tailer.start()
    appendFileSync(
      path,
      ['plain noise not json', '{broken json', userLine('u-ok-1', '正常一'), userLine('u-ok-2', '正常二')].join('\n') +
        '\n',
    )
    await waitFor(() => c.msgs.length === 2)
    expect(c.msgs.map((m) => m.uuid)).toEqual(['u-ok-1', 'u-ok-2'])
  })

  test('sidechain/isMeta/非抄本类型行不推送，compact_boundary 推送为系统消息', async () => {
    const path = freshFile()
    writeFileSync(path, '')
    const { tailer, c } = makeTailer(path)
    tailer.start()
    appendFileSync(
      path,
      [
        JSON.stringify({ type: 'user', uuid: 'u-side', isSidechain: true, message: { role: 'user', content: '子代理内部' } }),
        JSON.stringify({ type: 'user', uuid: 'u-meta', isMeta: true, message: { role: 'user', content: '元消息' } }),
        JSON.stringify({ type: 'progress', uuid: 'p-1', data: {} }),
        JSON.stringify({
          type: 'system',
          subtype: 'compact_boundary',
          uuid: 'cb-1',
          compactMetadata: { trigger: 'auto', preTokens: 1000 },
        }),
      ].join('\n') + '\n',
    )
    await waitFor(() => c.msgs.length === 1)
    expect(c.msgs[0]?.uuid).toBe('cb-1')
    expect(c.msgs[0]?.role).toBe('system')
    expect(c.msgs[0]?.subtype).toBe('compact_boundary')
    expect(c.msgs[0]?.rewindable).toBe(true) // 非 user 角色恒 true
  })
})

describe('TranscriptTailer 截断与停止', () => {
  test('文件被截断/重建时 onReset 触发且自停，之后的内容不再推送', async () => {
    const path = freshFile()
    writeFileSync(path, '')
    const { tailer, c } = makeTailer(path)
    tailer.start()
    appendFileSync(path, userLine('u-1', '截断前') + '\n')
    await waitFor(() => c.msgs.length === 1)

    writeFileSync(path, '') // 外部 rewind / /clear：文件归零，偏移失效
    await waitFor(() => c.resets === 1)

    appendFileSync(path, userLine('u-2', '截断后') + '\n')
    await sleep(150) // 覆盖 watch debounce 窗口；tailer 已停，不应再有动静
    expect(c.msgs).toHaveLength(1)
    expect(c.resets).toBe(1)
  })

  test('stop() 后追加内容不再触发任何回调', async () => {
    const path = freshFile()
    writeFileSync(path, '')
    const { tailer, c } = makeTailer(path)
    tailer.start()
    tailer.stop()
    appendFileSync(path, userLine('u-late', '停止后') + '\n')
    await sleep(150)
    expect(c.msgs).toHaveLength(0)
    expect(c.ticks).toBe(1) // 仅 start() 的初始 flush
  })
})
