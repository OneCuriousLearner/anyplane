import { describe, expect, test } from 'bun:test'
import {
  isOwnServerProcess,
  isOwnViteProcess,
  parseLsofPids,
  parseSsListenPids,
  type PidDesc,
} from './portTakeover'

const SS_SAMPLE = `State    Recv-Q   Send-Q     Local Address:Port      Peer Address:Port   Process
LISTEN   0        511              0.0.0.0:80             0.0.0.0:*       users:(("bun",pid=100,fd=9))
LISTEN   0        511              0.0.0.0:8080           0.0.0.0:*       users:(("python3",pid=200,fd=3))
LISTEN   0        511            127.0.0.1:7480           0.0.0.0:*       users:(("bun",pid=300,fd=1353))
LISTEN   0        511                [::]:443              [::]:*       users:(("bun",pid=100,fd=10),("bun",pid=101,fd=7))
`

describe('parseSsListenPids', () => {
  test('按端口精确匹配，不误伤 :8080', () => {
    expect(parseSsListenPids(SS_SAMPLE, 80)).toEqual([100])
    expect(parseSsListenPids(SS_SAMPLE, 8080)).toEqual([200])
    expect(parseSsListenPids(SS_SAMPLE, 7480)).toEqual([300])
  })
  test('同行多 pid 都收', () => {
    expect(parseSsListenPids(SS_SAMPLE, 443).sort()).toEqual([100, 101])
  })
  test('无监听返回空', () => {
    expect(parseSsListenPids(SS_SAMPLE, 9999)).toEqual([])
    expect(parseSsListenPids('', 80)).toEqual([])
  })
})

describe('parseLsofPids', () => {
  test('每行一个 pid，去重去脏行', () => {
    expect(parseLsofPids('100\n200\n100\n\nabc\n')).toEqual([100, 200])
    expect(parseLsofPids('')).toEqual([])
  })
})

const SERVER = '/repo/server'
const WEB = '/repo/web'
const d = (cmdline: string, cwd: string | null): PidDesc => ({ cmdline, cwd })

describe('isOwnServerProcess', () => {
  test('bun src/index.ts + cwd=server → 自己人', () => {
    expect(isOwnServerProcess(d('bun\0src/index.ts\0', SERVER), SERVER)).toBe(true)
    expect(isOwnServerProcess(d('bun --watch src/index.ts', SERVER), SERVER)).toBe(true)
    expect(isOwnServerProcess(d('/root/.bun/bin/bun src/index.ts', SERVER), SERVER)).toBe(true)
    expect(isOwnServerProcess(d(`bun ${SERVER}/src/index.ts`, SERVER), SERVER)).toBe(true)
  })
  test('cwd 不符 → 拒绝（别的仓库的同名入口不杀）', () => {
    expect(isOwnServerProcess(d('bun src/index.ts', '/other/repo/server'), SERVER)).toBe(false)
    expect(isOwnServerProcess(d('bun src/index.ts', null), SERVER)).toBe(false)
  })
  test('入口不符 → 拒绝', () => {
    expect(isOwnServerProcess(d('node index.js', SERVER), SERVER)).toBe(false)
    expect(isOwnServerProcess(d('python3 -m http.server 7480', SERVER), SERVER)).toBe(false)
    expect(isOwnServerProcess(d('bun src/index.ts.bak', SERVER), SERVER)).toBe(false)
  })
})

describe('isOwnViteProcess', () => {
  test('vite + cwd=web → 自己人', () => {
    expect(isOwnViteProcess(d('bun x --bun vite', WEB), WEB)).toBe(true)
    expect(isOwnViteProcess(d(`node ${WEB}/node_modules/.bin/vite`, WEB), WEB)).toBe(true)
  })
  test('cwd 不符或入口不含 vite → 拒绝', () => {
    expect(isOwnViteProcess(d('node node_modules/.bin/vite', '/other/web'), WEB)).toBe(false)
    expect(isOwnViteProcess(d('bun x vite', null), WEB)).toBe(false)
    expect(isOwnViteProcess(d('bun src/index.ts', WEB), WEB)).toBe(false)
  })
})
