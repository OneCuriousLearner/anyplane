import { describe, expect, test } from 'bun:test'
import {
  checkForNpmUpdate,
  isNewerRelease,
  parseSemver,
  shouldSkipUpdateCheck,
  updateHint,
} from './updateCheck'

describe('parseSemver / isNewerRelease', () => {
  test('只认 x.y.z', () => {
    expect(parseSemver('1.2.3')).toEqual([1, 2, 3])
    expect(parseSemver('1.0.0-beta')).toBeNull()
    expect(parseSemver('latest')).toBeNull()
  })

  test('严格新于才提醒，同版本或旧版本不提醒', () => {
    expect(isNewerRelease('1.2.4', '1.2.3')).toBe(true)
    expect(isNewerRelease('2.0.0', '1.9.9')).toBe(true)
    expect(isNewerRelease('1.2.3', '1.2.3')).toBe(false)
    expect(isNewerRelease('1.2.3', '1.2.4')).toBe(false)
    expect(isNewerRelease('not-a-version', '1.2.3')).toBe(false)
  })
})

describe('updateHint', () => {
  test('文案带上传入的当前/最新版本，刷新命令钉 @latest 不钉具体号', () => {
    const msg = updateHint('1.2.3', '1.4.0')
    expect(msg).toContain('1.2.3')
    expect(msg).toContain('1.4.0')
    expect(msg).toContain('bunx anyplane@latest')
    expect(msg).not.toContain('anyplane@1.4.0')
  })
})

describe('shouldSkipUpdateCheck', () => {
  test('CI 与显式关闭跳过', () => {
    expect(shouldSkipUpdateCheck({ CI: 'true' })).toBe(true)
    expect(shouldSkipUpdateCheck({ ANYPLANE_NO_UPDATE_CHECK: '1' })).toBe(true)
    expect(shouldSkipUpdateCheck({})).toBe(false)
  })
})

describe('checkForNpmUpdate', () => {
  test('latest 更新则提醒，并写入状态', async () => {
    const saved: unknown[] = []
    const warns: string[] = []
    await checkForNpmUpdate('1.2.3', {
      now: 1_000,
      env: {},
      fetchLatest: async () => '1.2.4',
      loadState: () => undefined,
      saveState: (s) => saved.push(s),
      warn: (m) => warns.push(m),
    })
    expect(warns).toHaveLength(1)
    expect(warns[0]).toContain('bunx anyplane@latest')
    expect(saved).toEqual([{ checkedAt: 1_000, latest: '1.2.4' }])
  })

  test('TTL 内不打 registry，但缓存已落后则每次都提醒', async () => {
    let fetched = 0
    const warns: string[] = []
    await checkForNpmUpdate('1.2.3', {
      now: 10_000,
      env: {},
      fetchLatest: async () => {
        fetched++
        return '9.9.9'
      },
      loadState: () => ({ checkedAt: 9_000, latest: '1.2.4' }),
      saveState: () => {
        throw new Error('TTL 内不该写')
      },
      warn: (m) => warns.push(m),
    })
    expect(fetched).toBe(0)
    expect(warns).toHaveLength(1)
    expect(warns[0]).toContain('1.2.4')
  })

  test('已是 latest 不提醒；网络失败静默', async () => {
    const warns: string[] = []
    await checkForNpmUpdate('1.2.4', {
      now: 1,
      env: {},
      fetchLatest: async () => '1.2.4',
      loadState: () => undefined,
      saveState: () => {},
      warn: (m) => warns.push(m),
    })
    await checkForNpmUpdate('1.2.3', {
      now: 1,
      env: {},
      fetchLatest: async () => null,
      loadState: () => undefined,
      saveState: () => {
        throw new Error('失败不该写')
      },
      warn: (m) => warns.push(m),
    })
    expect(warns).toEqual([])
  })

  test('CI 整段跳过', async () => {
    let fetched = 0
    await checkForNpmUpdate('1.2.3', {
      env: { CI: '1' },
      fetchLatest: async () => {
        fetched++
        return '1.2.4'
      },
      warn: () => {
        throw new Error('CI 不该提醒')
      },
    })
    expect(fetched).toBe(0)
  })
})
