import { describe, expect, test } from 'bun:test'
import { resolveCliCommand } from './args'

describe('resolveCliCommand', () => {
  test('默认与 --no-open 都走 start', () => {
    expect(resolveCliCommand([])).toBe('start')
    expect(resolveCliCommand(['--no-open'])).toBe('start')
    expect(resolveCliCommand(['start', '--no-open'])).toBe('start')
  })

  test('help / version 短旗标不被当成未知命令', () => {
    expect(resolveCliCommand(['--help'])).toBe('help')
    expect(resolveCliCommand(['-h'])).toBe('help')
    expect(resolveCliCommand(['--version'])).toBe('version')
    expect(resolveCliCommand(['-v'])).toBe('version')
  })

  test('显式子命令仍优先', () => {
    expect(resolveCliCommand(['gateway'])).toBe('gateway')
    expect(resolveCliCommand(['help'])).toBe('help')
  })
})
