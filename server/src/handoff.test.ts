// 接力编排：briefPrompt/seedMessage 的纯文案契约（进程内），
// 以及 appendLineage/lineageFor 的血缘读写（子进程 + 临时 HOME 隔离——
// ccDataDir 走 homedir() 而 Bun 的 homedir 进程启动时定型，且绝不能触碰真实 ~/.anyplane/lineage.json）。

import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { BACKEND_LABEL, briefPrompt, seedMessage } from './handoff'

describe('briefPrompt', () => {
  test('三档字数上限分别嵌入提示词', () => {
    expect(briefPrompt('brief')).toContain('300字以内')
    expect(briefPrompt('standard')).toContain('500字以内')
    expect(briefPrompt('detailed')).toContain('800字以内')
  })

  test('简报要素与"直接输出正文"指令齐备（源会话看不到对话外上下文是契约前提）', () => {
    const p = briefPrompt('standard')
    for (const kw of ['交接简报', '项目目标', '当前进度', '关键架构决策', '文件清单', '下一步任务', '直接输出简报正文']) {
      expect(p).toContain(kw)
    }
  })
})

describe('seedMessage', () => {
  test('携带 cwd、源后端显示名、简报原文与现场确认指令', () => {
    const msg = seedMessage('/tmp/proj', 'claude', '简报<正文> & 一切')
    expect(msg).toContain('/tmp/proj')
    expect(msg).toContain(BACKEND_LABEL.claude) // 'Claude Code'
    expect(msg).toContain('简报<正文> & 一切') // 原样嵌入，不转义（进 prompt 不进 HTML）
    expect(msg).toContain('git log --oneline') // 现场确认是实验验证的关键一环
  })

  test('codex 源后端显示名为 Codex', () => {
    expect(seedMessage('/p', 'codex', 'b')).toContain('Codex')
  })
})

// ---------- 血缘（子进程隔离） ----------

const HANDOFF_URL = pathToFileURL(join(import.meta.dir, 'handoff.ts')).href
const tmpRoots: string[] = []

afterEach(() => {
  for (const r of tmpRoots.splice(0)) rmSync(r, { recursive: true, force: true })
})

function freshHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'anyplane-handoff-'))
  tmpRoots.push(home)
  return home
}

function runInSubprocess(script: string, home: string): unknown {
  const res = Bun.spawnSync({
    cmd: [process.execPath, '-e', script],
    env: { ...process.env, HOME: home, USERPROFILE: home },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  if (res.exitCode !== 0) throw new Error(`子进程失败: ${res.stderr.toString()}`)
  return JSON.parse(res.stdout.toString())
}

const REC_A = {
  id: 'ha',
  at: '2026-09-04T00:00:00Z',
  fromKey: 's|-proj|sid-1',
  toKey: 'n|%2Ftmp%2Fproj',
  toResolvedKey: 's|-proj|sid-2',
  fromBackend: 'claude',
  toBackend: 'claude',
  cwd: '/tmp/proj',
  detail: 'standard',
  brief: '简报甲',
}
const REC_B = {
  id: 'hb',
  at: '2026-09-04T00:01:00Z',
  fromKey: 'x|thread-9',
  toKey: 'xn|%2Ftmp%2Fproj',
  fromResolvedKey: 'x|thread-9',
  fromBackend: 'codex',
  toBackend: 'claude',
  cwd: '/tmp/proj',
  detail: 'brief',
  brief: '简报乙',
}

describe('appendLineage / lineageFor（子进程 + 临时 HOME）', () => {
  test('文件不存在→创建；连续追加累积；lineageFor 按四个 key 字段匹配且排除无关', () => {
    const home = freshHome()
    const script = `import { appendLineage, lineageFor } from ${JSON.stringify(HANDOFF_URL)};
import { readFileSync } from 'node:fs';
const before = lineageFor('s|-proj|sid-1'); // 文件都不存在时
appendLineage(${JSON.stringify(REC_A)});
appendLineage(${JSON.stringify(REC_B)});
const file = JSON.parse(readFileSync(process.env.HOME + '/.anyplane/lineage.json', 'utf8'));
console.log(JSON.stringify({
  before,
  fileIds: file.map((r) => r.id),
  byFromKey: lineageFor('s|-proj|sid-1').map((r) => r.id),
  byToKey: lineageFor('n|%2Ftmp%2Fproj').map((r) => r.id),
  byFromResolved: lineageFor('x|thread-9').map((r) => r.id),
  byToResolved: lineageFor('s|-proj|sid-2').map((r) => r.id),
  unrelated: lineageFor('s|-proj|sid-zzz'),
}))`
    const out = runInSubprocess(script, home) as Record<string, unknown[]>
    expect(out.before).toEqual([])
    expect(out.fileIds).toEqual(['ha', 'hb']) // 追加顺序保持
    expect(out.byFromKey).toEqual(['ha'])
    expect(out.byToKey).toEqual(['ha'])
    expect(out.byFromResolved).toEqual(['hb']) // fromResolvedKey 也命中
    expect(out.byToResolved).toEqual(['ha'])
    expect(out.unrelated).toEqual([])
  })

  test('既有血缘文件是坏 JSON → 从空重建而非崩溃（readJsonFile 静默吞错的既定语义）', () => {
    const home = freshHome()
    const script = `import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
const dir = process.env.HOME + '/.anyplane';
mkdirSync(dir, { recursive: true });
writeFileSync(dir + '/lineage.json', '{corrupted');
const { appendLineage, lineageFor } = await import(${JSON.stringify(HANDOFF_URL)});
appendLineage(${JSON.stringify(REC_A)});
console.log(JSON.stringify({
  file: JSON.parse(readFileSync(dir + '/lineage.json', 'utf8')).map((r) => r.id),
  found: lineageFor('s|-proj|sid-1').map((r) => r.id),
}))`
    const out = runInSubprocess(script, home) as { file: string[]; found: string[] }
    expect(out.file).toEqual(['ha']) // 旧数据丢失是既定行为（半截文件防呆注释见 util.writeJsonFile）
    expect(out.found).toEqual(['ha'])
  })
})
