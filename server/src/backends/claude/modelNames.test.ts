import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolveTierModelNames } from './modelNames'

// 全隔离：configDir 与 cwd 都用 mkdtemp（不读真实 user settings），procEnv 显式注入。

describe('resolveTierModelNames', () => {
  let configDir = ''
  let cwd = ''
  const setup = () => {
    configDir = mkdtempSync(join(tmpdir(), 'ccr-mn-cfg-'))
    cwd = mkdtempSync(join(tmpdir(), 'ccr-mn-cwd-'))
  }
  setup()
  afterEach(() => {
    rmSync(configDir, { recursive: true, force: true })
    rmSync(cwd, { recursive: true, force: true })
    setup()
  })

  test('process.env 注入的 _MODEL_NAME 透传为显示名，_MODEL 进 id', () => {
    const out = resolveTierModelNames(cwd, {
      ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME: 'kimi-for-coding-highspeed',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'kimi-k2-0905-preview',
    }, configDir)
    expect(out.haiku).toEqual({ name: 'kimi-for-coding-highspeed', id: 'kimi-k2-0905-preview' })
  })

  test('无 _MODEL_NAME 时降级为模型 ID', () => {
    const out = resolveTierModelNames(cwd, { ANTHROPIC_DEFAULT_SONNET_MODEL: 'some-gateway-model-v2' }, configDir)
    expect(out.sonnet).toEqual({ name: 'some-gateway-model-v2' })
  })

  test('都没配 → 空表（前端降级 tier 名）', () => {
    expect(Object.keys(resolveTierModelNames(cwd, {}, configDir))).toEqual([])
  })

  test('user settings 文件源生效', () => {
    writeFileSync(
      join(configDir, 'settings.json'),
      JSON.stringify({ env: { ANTHROPIC_DEFAULT_OPUS_MODEL_NAME: 'user-level-opus' } }),
    )
    expect(resolveTierModelNames(cwd, {}, configDir).opus?.name).toBe('user-level-opus')
  })

  test('覆盖链：user < project local < process.env', () => {
    writeFileSync(
      join(configDir, 'settings.json'),
      JSON.stringify({ env: { ANTHROPIC_DEFAULT_FABLE_MODEL_NAME: 'user-level' } }),
    )
    mkdirSync(join(cwd, '.claude'), { recursive: true })
    writeFileSync(
      join(cwd, '.claude', 'settings.local.json'),
      JSON.stringify({ env: { ANTHROPIC_DEFAULT_FABLE_MODEL_NAME: 'project-level' } }),
    )
    expect(resolveTierModelNames(cwd, {}, configDir).fable?.name).toBe('project-level')
    expect(
      resolveTierModelNames(cwd, { ANTHROPIC_DEFAULT_FABLE_MODEL_NAME: 'shell-level' }, configDir).fable?.name,
    ).toBe('shell-level')
  })

  test('非法 JSON 的设置文件静默跳过', () => {
    writeFileSync(join(configDir, 'settings.json'), '{ broken')
    expect(() => resolveTierModelNames(cwd, {}, configDir)).not.toThrow()
    expect(Object.keys(resolveTierModelNames(cwd, {}, configDir))).toEqual([])
  })
})
