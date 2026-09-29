// claude 会话回收站：jsonl + subagents 目录整体移动，无物理删除。
// trash 根目录固定在 ~/.anyplane/trash/claude/（homedir），测试用唯一 slug 隔离并清理。
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { archiveClaudeSession, listTrash, restoreClaudeSession } from './archive'
import { config } from '../../config'

const SLUG = `-test-trash-${Date.now().toString(36)}`
const SID = 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff'

let configDir = ''
let savedConfigDir = ''

const transcript = () => join(configDir, 'projects', SLUG, `${SID}.jsonl`)
const trashDir = () => join(homedir(), '.anyplane', 'trash', 'claude', SLUG)

beforeAll(() => {
  configDir = mkdtempSync(join(tmpdir(), 'anyplane-archive-'))
  savedConfigDir = config.claudeConfigDir
  config.claudeConfigDir = configDir
})

afterAll(() => {
  config.claudeConfigDir = savedConfigDir
  rmSync(configDir, { recursive: true, force: true })
  rmSync(trashDir(), { recursive: true, force: true })
})

/** 造一个带 subagents 侧目录的会话 */
function seedSession() {
  mkdirSync(join(configDir, 'projects', SLUG, SID), { recursive: true })
  writeFileSync(transcript(), '{"type":"user"}\n')
  writeFileSync(join(configDir, 'projects', SLUG, SID, 'agent-1.jsonl'), '{"type":"assistant"}\n')
}

describe('archiveClaudeSession / restoreClaudeSession / listTrash', () => {
  test('归档：jsonl 与 subagents 目录一起移入回收站并写元信息', () => {
    seedSession()
    archiveClaudeSession(SLUG, SID)

    expect(existsSync(transcript())).toBe(false)
    expect(existsSync(join(configDir, 'projects', SLUG, SID))).toBe(false)
    expect(existsSync(join(trashDir(), `${SID}.jsonl`))).toBe(true)
    expect(existsSync(join(trashDir(), SID, 'agent-1.jsonl'))).toBe(true)
    expect(existsSync(join(trashDir(), `${SID}.meta.json`))).toBe(true)

    // 重复归档被同名守卫拦下（先恢复或手动清理）
    seedSession()
    expect(() => archiveClaudeSession(SLUG, SID)).toThrow('回收站已有同名会话')
    rmSync(transcript(), { force: true })
    rmSync(join(configDir, 'projects', SLUG, SID), { recursive: true, force: true })
  })

  test('归档不存在的 transcript 直接报错', () => {
    expect(() => archiveClaudeSession(SLUG, '00000000-0000-4000-8000-000000000000')).toThrow('transcript 不存在')
  })

  test('回收站列表带 key/trashedAt，且不混入 meta/bak 文件', () => {
    const entries = listTrash().filter((e) => e.slug === SLUG)
    expect(entries).toHaveLength(1)
    expect(entries[0]!.key).toBe(`s|${SLUG}|${SID}`)
    expect(entries[0]!.trashedAt).toBeTruthy()
    expect(entries[0]!.sizeBytes).toBeGreaterThan(0)
  })

  test('回收站列表带 title/lastPrompt（与主列表同口径 extractMeta，裸 id 可认）', () => {
    // ai-title 记录 → title 直取
    const SID2 = 'cccccccc-0000-4ddd-8eee-000000000001'
    mkdirSync(join(configDir, 'projects', SLUG), { recursive: true })
    writeFileSync(
      join(configDir, 'projects', SLUG, `${SID2}.jsonl`),
      [
        JSON.stringify({ type: 'user', message: { role: 'user', content: '帮我看看这个仓库是干嘛的' } }),
        JSON.stringify({ type: 'ai-title', aiTitle: '仓库用途探查' }),
      ].join('\n') + '\n',
    )
    archiveClaudeSession(SLUG, SID2)
    // 无标题记录 → title 回退首条用户消息（head 扫描，小文件即可得）
    const SID3 = 'cccccccc-0000-4ddd-8eee-000000000002'
    writeFileSync(
      join(configDir, 'projects', SLUG, `${SID3}.jsonl`),
      JSON.stringify({ type: 'user', message: { role: 'user', content: '只回复两个字：收到' } }) + '\n',
    )
    archiveClaudeSession(SLUG, SID3)

    const e2 = listTrash().find((x) => x.sessionId === SID2)
    expect(e2?.title).toBe('仓库用途探查')
    const e3 = listTrash().find((x) => x.sessionId === SID3)
    expect(e3?.title).toBe('只回复两个字：收到')
    // lastPrompt 只在大文件尾块扫描（extractMeta 的 64KB tail 契约），小文件不强求
  })

  test('恢复：移回原位，元信息改名 .bak 保留', () => {
    restoreClaudeSession(SLUG, SID)

    expect(existsSync(transcript())).toBe(true)
    expect(existsSync(join(configDir, 'projects', SLUG, SID, 'agent-1.jsonl'))).toBe(true)
    expect(existsSync(join(trashDir(), `${SID}.jsonl`))).toBe(false)
    expect(existsSync(join(trashDir(), `${SID}.meta.json.bak`))).toBe(true)

    // 原位置已有同名 transcript 时拒绝恢复（不覆盖在线数据）
    expect(() => restoreClaudeSession(SLUG, SID)).toThrow('回收站中没有该会话')
  })

  test('恢复时原位置被占 → 报错且不覆盖', () => {
    // 重新归档（清掉上一步的 .bak 干扰），再占住原位置
    rmSync(join(trashDir(), `${SID}.meta.json.bak`), { force: true })
    archiveClaudeSession(SLUG, SID)
    seedSession()
    expect(() => restoreClaudeSession(SLUG, SID)).toThrow('原位置已有同名 transcript')
    expect(existsSync(join(trashDir(), `${SID}.jsonl`))).toBe(true) // 回收站侧未动
  })
})
