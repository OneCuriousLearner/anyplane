import { afterEach, describe, expect, test } from 'bun:test'
import { configureLog, errFields, logger } from './log'

/** 捕获 console 三路输出 */
function capture(fn: () => void): { out: string[]; warn: string[]; err: string[] } {
  const out: string[] = []
  const warn: string[] = []
  const err: string[] = []
  const o = console.log
  const w = console.warn
  const e = console.error
  console.log = (...a: unknown[]) => out.push(a.join(' '))
  console.warn = (...a: unknown[]) => warn.push(a.join(' '))
  console.error = (...a: unknown[]) => err.push(a.join(' '))
  try {
    fn()
  } finally {
    console.log = o
    console.warn = w
    console.error = e
  }
  return { out, warn, err }
}

afterEach(() => configureLog({ level: 'info', json: false }))

describe('logger', () => {
  test('文本模式与旧格式一致：[scope] msg，字段以 k=v 追加', () => {
    const { out } = capture(() => logger('anyplane').info('listening', { port: 7480, host: '127.0.0.1' }))
    expect(out).toEqual(['[anyplane] listening port=7480 host=127.0.0.1'])
  })

  test('含空格/空字符串的值加引号，避免 k=v 边界糊掉', () => {
    const { out } = capture(() => logger('s').info('m', { cmd: 'echo hi', empty: '' }))
    expect(out[0]).toBe('[s] m cmd="echo hi" empty=""')
  })

  test('级别阈值：默认 info 时 debug 静默，调到 debug 后放行', () => {
    expect(capture(() => logger('s').debug('noisy')).out).toHaveLength(0)
    configureLog({ level: 'debug' })
    expect(capture(() => logger('s').debug('noisy')).out).toEqual(['[s] noisy'])
  })

  test('warn/error 走各自 console 通道（stderr 语义）', () => {
    const c = capture(() => {
      logger('s').warn('degraded')
      logger('s').error('broken')
    })
    expect(c.warn).toEqual(['[s] degraded'])
    expect(c.err).toEqual(['[s] broken'])
    expect(c.out).toHaveLength(0)
  })

  test('JSON 模式逐行输出，含 ts/level/scope/msg 与平铺字段', () => {
    configureLog({ json: true })
    const { out } = capture(() => logger('session x|1').info('exited', { code: 0 }))
    const rec = JSON.parse(out[0]) as Record<string, unknown>
    expect(rec).toMatchObject({ level: 'info', scope: 'session x|1', msg: 'exited', code: 0 })
    expect(typeof rec.ts).toBe('string')
  })

  test('undefined 字段不落库（避免 key=undefined 噪声）', () => {
    const { out } = capture(() => logger('s').info('m', { a: 1, b: undefined }))
    expect(out[0]).toBe('[s] m a=1')
  })

  test('child 派生子 scope', () => {
    const { out } = capture(() => logger('codex').child('x|abc').info('subscribed'))
    expect(out).toEqual(['[codex x|abc] subscribed'])
  })

  test('errFields 提取 message 与 errno code', () => {
    expect(errFields(new Error('boom'))).toEqual({ error: 'boom' })
    const e = Object.assign(new Error('nope'), { code: 'ENOENT' })
    expect(errFields(e)).toEqual({ error: 'nope', code: 'ENOENT' })
    expect(errFields('plain')).toEqual({ error: 'plain' })
  })
})
