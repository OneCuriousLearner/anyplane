import { describe, expect, test } from 'bun:test'
import { browserOpenArgs, shouldOpenBrowser } from './openBrowser'

const tty = {
  isTTY: true,
  inDocker: false,
  argv: ['bun', 'src/index.ts'] as string[],
  env: {} as NodeJS.ProcessEnv,
}

describe('shouldOpenBrowser', () => {
  test('交互 TTY 默认打开', () => {
    expect(shouldOpenBrowser(tty)).toBe(true)
  })

  test('容器内不打开（xdg-open 打到的是容器，不是用户桌面）', () => {
    expect(shouldOpenBrowser({ ...tty, inDocker: true })).toBe(false)
  })

  test('非 TTY（管道 / e2e / 服务管理器）不打开', () => {
    expect(shouldOpenBrowser({ ...tty, isTTY: false })).toBe(false)
  })

  test('--no-open 关闭', () => {
    expect(shouldOpenBrowser({ ...tty, argv: ['bun', 'src/index.ts', '--no-open'] })).toBe(false)
  })

  test('ANYPLANE_NO_OPEN=1 与 ANYPLANE_OPEN=0 关闭', () => {
    expect(shouldOpenBrowser({ ...tty, env: { ANYPLANE_NO_OPEN: '1' } })).toBe(false)
    expect(shouldOpenBrowser({ ...tty, env: { ANYPLANE_OPEN: '0' } })).toBe(false)
  })

  test('CI 不打开', () => {
    expect(shouldOpenBrowser({ ...tty, env: { CI: 'true' } })).toBe(false)
    expect(shouldOpenBrowser({ ...tty, env: { CI: '1' } })).toBe(false)
  })
})

describe('browserOpenArgs', () => {
  test('Windows 走 cmd start，空标题防吞 URL', () => {
    expect(browserOpenArgs('http://localhost:7480/', 'win32')).toEqual([
      'cmd',
      '/c',
      'start',
      '""',
      '/b',
      'http://localhost:7480/',
    ])
  })

  test('macOS 走 open，Linux 走 xdg-open', () => {
    expect(browserOpenArgs('http://localhost:7480/', 'darwin')).toEqual(['open', 'http://localhost:7480/'])
    expect(browserOpenArgs('http://localhost:7480/', 'linux')).toEqual(['xdg-open', 'http://localhost:7480/'])
  })
})
