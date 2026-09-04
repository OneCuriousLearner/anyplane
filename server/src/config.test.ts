// 服务端配置：loadAnyplaneConfigFile 的候选优先级与坏 JSON 容错、模块级 config 的
// 默认值/env 覆盖/permissionPolicy → defaultPermissionMode。
// 全程子进程驱动：Bun 的 homedir() 在进程启动时定型（进程内改 HOME 无效），
// 且模块级 config 在 import 时一次性定型——只能用干净子进程 + 临时 HOME 隔离验证。

import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const CONFIG_URL = pathToFileURL(join(import.meta.dir, 'config.ts')).href
const tmpRoots: string[] = []

afterEach(() => {
  for (const r of tmpRoots.splice(0)) rmSync(r, { recursive: true, force: true })
})

/** 在干净子进程中执行脚本（临时 HOME 隔离真实 ~/.anyplane/config.json），输出须为单行 JSON */
function runInSubprocess(script: string, home: string, extra?: { cwd?: string; env?: Record<string, string> }): unknown {
  const res = Bun.spawnSync({
    cmd: [process.execPath, '-e', script],
    env: { ...process.env, HOME: home, USERPROFILE: home, ...extra?.env },
    cwd: extra?.cwd,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  if (res.exitCode !== 0) throw new Error(`子进程失败: ${res.stderr.toString()}`)
  return JSON.parse(res.stdout.toString())
}

/** 造临时目录：home 下可放 ~/.anyplane/config.json,cwd 下可放 anyplane.config.json */
function seedDirs(files: { home?: string; cwd?: string }): { home: string; cwd: string } {
  const root = mkdtempSync(join(tmpdir(), 'anyplane-config-'))
  tmpRoots.push(root)
  const home = join(root, 'home')
  const cwd = join(root, 'cwd')
  mkdirSync(join(home, '.anyplane'), { recursive: true })
  mkdirSync(cwd, { recursive: true })
  if (files.home !== undefined) writeFileSync(join(home, '.anyplane', 'config.json'), files.home)
  if (files.cwd !== undefined) writeFileSync(join(cwd, 'anyplane.config.json'), files.cwd)
  return { home, cwd }
}

const loadScript = `import { loadAnyplaneConfigFile } from ${JSON.stringify(CONFIG_URL)};
console.log(JSON.stringify(loadAnyplaneConfigFile()))`

describe('loadAnyplaneConfigFile', () => {
  // 候选顺序：cwd → 项目根（仓库中不存在）→ ~/.anyplane/config.json
  test('cwd 配置优先于 ~/.anyplane/config.json', () => {
    const { home, cwd } = seedDirs({
      home: JSON.stringify({ port: 1111, authToken: 'from-home' }),
      cwd: JSON.stringify({ port: 2222 }),
    })
    expect(runInSubprocess(loadScript, home, { cwd })).toEqual({ port: 2222 })
  })

  test('cwd 配置是坏 JSON → 落到下一个有效候选', () => {
    const { home, cwd } = seedDirs({ home: JSON.stringify({ port: 1111 }), cwd: '{broken' })
    expect(runInSubprocess(loadScript, home, { cwd })).toEqual({ port: 1111 })
  })

  test('所有候选缺失 → 空对象', () => {
    const { home, cwd } = seedDirs({})
    expect(runInSubprocess(loadScript, home, { cwd })).toEqual({})
  })
})

const configScript = `import { config, defaultPermissionMode } from ${JSON.stringify(CONFIG_URL)};
console.log(JSON.stringify({ ...config, defaultMode: defaultPermissionMode() }))`

describe('模块级 config', () => {
  test('干净环境走默认值：7480/回环/ask → defaultPermissionMode undefined', () => {
    const { home, cwd } = seedDirs({})
    const cfg = runInSubprocess(configScript, home, { cwd }) as Record<string, unknown>
    expect(cfg.port).toBe(7480)
    expect(cfg.host).toBe('127.0.0.1')
    expect(cfg.authToken).toBeUndefined()
    expect(cfg.permissionPolicy).toBe('ask')
    expect(cfg.defaultMode).toBeUndefined() // ask 策略不预置 bypassPermissions
  })

  test('env 覆盖配置文件：ANYPLANE_PORT/TOKEN 胜出，bypass → bypassPermissions', () => {
    const { home, cwd } = seedDirs({
      home: JSON.stringify({ port: 9000, permissionPolicy: 'bypass', authToken: 'file-token' }),
    })
    const cfg = runInSubprocess(configScript, home, {
      cwd,
      env: { ANYPLANE_PORT: '9999', ANYPLANE_TOKEN: 'env-token' },
    }) as Record<string, unknown>
    expect(cfg.port).toBe(9999) // env 覆盖文件
    expect(cfg.authToken).toBe('env-token')
    expect(cfg.defaultMode).toBe('bypassPermissions') // 文件里的 bypass 策略生效
  })
})
