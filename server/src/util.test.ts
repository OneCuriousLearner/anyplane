import { describe, expect, test } from 'bun:test'
import { chmodSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ensurePrivateDir, childEnv, errorMessage, pumpLines } from './util'

function streamOf(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(c)
      controller.close()
    },
  })
}

const enc = (s: string) => new TextEncoder().encode(s)

async function collect(stream: ReadableStream<Uint8Array>): Promise<string[]> {
  const lines: string[] = []
  await pumpLines(stream, (l) => lines.push(l))
  return lines
}

describe('pumpLines（NDJSON 行泵）', () => {
  test('单 chunk 多行按 \\n 切分', async () => {
    expect(await collect(streamOf([enc('{"a":1}\n{"b":2}\n')]))).toEqual(['{"a":1}', '{"b":2}'])
  })

  test('一行跨多个 chunk 也能拼回', async () => {
    expect(await collect(streamOf([enc('{"a'), enc('":1'), enc('}\n{"b":2}\n')]))).toEqual(['{"a":1}', '{"b":2}'])
  })

  test('多字节 UTF-8 字符跨 chunk 不断裂（流式解码）', async () => {
    const full = enc('{"text":"你好，世界"}\n')
    // 在"你"的字节中间切断（"你" = E4 BD A0）
    const cut = full.indexOf(0xe4)
    const lines = await collect(streamOf([full.slice(0, cut + 1), full.slice(cut + 1)]))
    expect(lines).toEqual(['{"text":"你好，世界"}'])
  })

  test('末尾无换行的余量也会冲刷为一行', async () => {
    expect(await collect(streamOf([enc('{"a":1}\n{"tail":true}')]))).toEqual(['{"a":1}', '{"tail":true}'])
  })

  test('空行与纯空白行被跳过', async () => {
    expect(await collect(streamOf([enc('\n{"a":1}\n\n  \n{"b":2}\n')]))).toEqual(['{"a":1}', '{"b":2}'])
  })

  test('读取异常经 onError 上报且不抛出', async () => {
    const boom = new Error('boom')
    let pulled = 0
    // pull 驱动：先吐出一条完整行，下一次读取才失败（真实进程管道断开的形态）
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (pulled++ === 0) controller.enqueue(enc('{"a":1}\n'))
        else controller.error(boom)
      },
    })
    const lines: string[] = []
    const errors: unknown[] = []
    await pumpLines(stream, (l) => lines.push(l), (e) => errors.push(e))
    expect(lines).toEqual(['{"a":1}'])
    expect(errors).toEqual([boom])
  })
})

describe('errorMessage', () => {
  test('Error 取 message，其余 String 化', () => {
    expect(errorMessage(new Error('失败原因'))).toBe('失败原因')
    expect(errorMessage('字符串错误')).toBe('字符串错误')
    expect(errorMessage(42)).toBe('42')
    expect(errorMessage(undefined)).toBe('undefined')
  })
})

describe('childEnv（CLI 子进程环境）', () => {
  test('剥离 ANYPLANE_TOKEN，其余继承变量与 extra 不受影响', () => {
    const savedToken = process.env.ANYPLANE_TOKEN
    process.env.ANYPLANE_TOKEN = 'secret-token'
    process.env.ANYPLANE_TEST_MARKER = 'm'
    try {
      const env = childEnv({ CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING: '1' })
      expect(env.ANYPLANE_TOKEN).toBeUndefined()
      expect(env.ANYPLANE_TEST_MARKER).toBe('m') // 其余继承不受影响
      expect(env.CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING).toBe('1') // extra 叠加生效
    } finally {
      if (savedToken === undefined) delete process.env.ANYPLANE_TOKEN
      else process.env.ANYPLANE_TOKEN = savedToken
      delete process.env.ANYPLANE_TEST_MARKER
    }
  })

  test('extra 显式注入 ANYPLANE_TOKEN 也会被剥除', () => {
    expect(childEnv({ ANYPLANE_TOKEN: 'x' }).ANYPLANE_TOKEN).toBeUndefined()
  })
})

describe('ensurePrivateDir（~/.anyplane 私有目录）', () => {
  // POSIX 权限语义测试；Windows 的 chmod 语义不同，跳过断言仅保证不抛错
  test('新建目录与既有宽松目录都收紧为 700', () => {
    const root = mkdtempSync(join(tmpdir(), 'ccr-util-'))
    try {
      const dir = join(root, '.anyplane', 'uploads')
      expect(ensurePrivateDir(dir)).toBe(dir)
      if (process.platform !== 'win32') {
        // .anyplane 根与目标层都是 700
        expect(statSync(join(root, '.anyplane')).mode & 0o777).toBe(0o700)
        expect(statSync(dir).mode & 0o777).toBe(0o700)
      }
      // 幂等：重复调用不抛错
      expect(ensurePrivateDir(dir)).toBe(dir)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('路径不含 .anyplane 段时只收紧目标目录本身', () => {
    const root = mkdtempSync(join(tmpdir(), 'ccr-util-'))
    try {
      if (process.platform !== 'win32') chmodSync(root, 0o755) // mkdtemp 默认 700，先放宽以观察不受影响
      const dir = join(root, 'plain')
      expect(ensurePrivateDir(dir)).toBe(dir)
      if (process.platform !== 'win32') {
        expect(statSync(dir).mode & 0o777).toBe(0o700)
        // 父目录不受影响
        expect(statSync(root).mode & 0o777).toBe(0o755)
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
