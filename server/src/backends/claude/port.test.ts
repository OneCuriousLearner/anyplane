import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { claudePort } from './port'
import { rememberSessionModel, setStoreFileForTest } from './sessionModels'

// statusOf 的 model 字段三级回退：spawnOpts.model（用户显式选择）→ initModel（live 权威）
// → sessionModels 持久化表（离线/tail 回填）。本文件只锁第三级与前两级缺席时的行为——
// 前两级的优先级由编排结构保证（?? 链），live 会话另有 processManager 测试覆盖。
describe('claudePort.statusOf model 离线回填', () => {
  // sessionModels 是 ~/.anyplane 下的真实文件：重定向到临时目录，避免污染与跨测试文件串扰
  const modelsTmp = join(mkdtempSync(join(tmpdir(), 'anyplane-port-models-')), 'session-models.json')
  beforeEach(() => setStoreFileForTest(modelsTmp))
  afterEach(() => setStoreFileForTest(undefined))

  const cx = { hub: undefined, liveHint: null, hydrateContext: false } as const

  test('离线 s| 会话：表中有模型则回填（tail/外部会话不再显示 … 占位）', () => {
    rememberSessionModel('sess-offline', 'k3[1m]')
    const st = claudePort.statusOf('s|-tmp-proj|sess-offline', cx)
    expect(st.model).toBe('k3[1m]')
  })

  test('离线 s| 会话：表中无模型则 undefined（从未 live 见过的会话不编造）', () => {
    const st = claudePort.statusOf('s|-tmp-proj|sess-never-seen', cx)
    expect(st.model).toBeUndefined()
  })

  test('n| 新会话 key 无表可查，model undefined', () => {
    const st = claudePort.statusOf('n|%2Ftmp%2Fproj', cx)
    expect(st.model).toBeUndefined()
  })

  test('畸形 s| key（非法字符段）不炸，model undefined', () => {
    const st = claudePort.statusOf('s|bad slug|sess', cx)
    expect(st.model).toBeUndefined()
  })
})
