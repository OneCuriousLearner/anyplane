import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  DiskDiscoveryError,
  listThreadsFromDisk,
  parseRolloutHead,
  parseSessionIndex,
  resetDiskDiscoveryCache,
} from './discovery'

let home: string

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'codex-disc-'))
  resetDiskDiscoveryCache()
})

afterEach(() => {
  rmSync(home, { recursive: true, force: true })
})

// ---------- 夹具构造 ----------

function metaLine(id: string, opts: { cwd?: string; source?: unknown; timestamp?: string; parent?: string } = {}): string {
  return JSON.stringify({
    timestamp: opts.timestamp ?? '2026-09-10T11:00:00.000Z',
    type: 'session_meta',
    payload: {
      id,
      timestamp: opts.timestamp ?? '2026-09-10T11:00:00.000Z',
      cwd: opts.cwd ?? '/tmp/proj',
      ...(opts.source === undefined ? { source: 'cli' } : { source: opts.source }),
      ...(opts.parent ? { parent_thread_id: opts.parent } : {}),
    },
  })
}

function userMessageLine(text: string): string {
  return JSON.stringify({
    timestamp: '2026-09-10T11:00:01.000Z',
    type: 'event_msg',
    payload: {
      type: 'item_completed',
      item: { type: 'UserMessage', id: 'm1', content: [{ type: 'text', text }] },
    },
  })
}

function legacyUserMessageLine(text: string): string {
  return JSON.stringify({
    timestamp: '2026-09-10T11:00:01.000Z',
    type: 'event_msg',
    payload: { type: 'user_message', message: text },
  })
}

function goalLine(objective: string): string {
  return JSON.stringify({
    timestamp: '2026-09-10T11:00:01.000Z',
    type: 'event_msg',
    payload: { type: 'thread_goal_updated', goal: { objective } },
  })
}

function writeRollout(
  id: string,
  lines: string[],
  opts: { archived?: boolean; day?: string; mtime?: Date } = {},
): string {
  const day = opts.day ?? '2026/09/10'
  const dir = join(home, opts.archived ? 'archived_sessions' : 'sessions', day)
  mkdirSync(dir, { recursive: true })
  const path = join(dir, `rollout-2026-09-10T11-00-00-${id}.jsonl`)
  writeFileSync(path, lines.join('\n') + '\n')
  if (opts.mtime) utimesSync(path, opts.mtime, opts.mtime)
  return path
}

const ID_A = '01a00000-0000-7000-8000-aaaaaaaaaaaa'
const ID_B = '01a00000-0000-7000-8000-bbbbbbbbbbbb'
const ID_C = '01a00000-0000-7000-8000-cccccccccccc'

// ---------- 纯函数 ----------

describe('parseRolloutHead', () => {
  test('session_meta 取 id/cwd/createdAt/source；paginated 用户消息作 preview', () => {
    const head = parseRolloutHead([metaLine(ID_A), userMessageLine('你好世界')].join('\n'))
    expect(head).toMatchObject({
      id: ID_A,
      cwd: '/tmp/proj',
      source: 'cli',
      preview: '你好世界',
      sawSessionMeta: true,
    })
    expect(head.createdAt).toBeCloseTo(Date.parse('2026-09-10T11:00:00.000Z') / 1000, 0)
  })

  test('legacy user_message 事件同样产出 preview', () => {
    const head = parseRolloutHead([metaLine(ID_A), legacyUserMessageLine('老格式消息')].join('\n'))
    expect(head.preview).toBe('老格式消息')
  })

  test('strip 规则：USER_MESSAGE_BEGIN 之前的内容被裁掉', () => {
    const head = parseRolloutHead([
      metaLine(ID_A),
      userMessageLine('<environment_context>x</environment_context>\n## My request for Codex:\n真正的问题'),
    ].join('\n'))
    expect(head.preview).toBe('真正的问题')
  })

  test('无用户消息时 goal.objective 兜底 preview', () => {
    const head = parseRolloutHead([metaLine(ID_A), goalLine('修掉登录页')].join('\n'))
    expect(head.preview).toBe('修掉登录页')
  })

  test('preview 取首条用户消息，后续不改写；坏行不连坐', () => {
    const head = parseRolloutHead([
      metaLine(ID_A),
      '{broken json',
      userMessageLine('第一条'),
      userMessageLine('第二条'),
    ].join('\n'))
    expect(head.preview).toBe('第一条')
  })

  test('source 为对象形态（subagent）时 source 字段不留存', () => {
    const head = parseRolloutHead([metaLine(ID_A, { source: { subagent: { thread_spawn: {} } } })].join('\n'))
    expect(head.source).toBeUndefined()
    expect(head.sawSessionMeta).toBe(true)
  })

  test('fork 文件第二条 session_meta（父线程拷贝）不得覆盖第一条（上游 list.rs:1145 同款守卫）', () => {
    // 真实案例：subagent fork 文件的行 1 是自己的 meta（id=子线程、source=subagent），
    // 行 2 是父线程 meta（id=父线程、source=vscode）——被覆盖会产生父线程的幻影行
    const head = parseRolloutHead(
      [
        metaLine(ID_B, { source: { subagent: { thread_spawn: {} } }, parent: ID_A }),
        metaLine(ID_A, { source: 'vscode' }),
      ].join('\n'),
    )
    expect(head.id).toBe(ID_B)
    expect(head.source).toBeUndefined()
  })
})

describe('parseSessionIndex', () => {
  test('同名后写胜出；空名跳过（上游 session_index.rs:146-150 同款）', () => {
    const names = parseSessionIndex(
      [
        JSON.stringify({ id: ID_A, thread_name: '旧名', updated_at: '2026-09-01T00:00:00Z' }),
        JSON.stringify({ id: ID_A, thread_name: '新名', updated_at: '2026-09-02T00:00:00Z' }),
        JSON.stringify({ id: ID_B, thread_name: '  ', updated_at: '2026-09-03T00:00:00Z' }),
        JSON.stringify({ id: ID_B, thread_name: '', updated_at: '2026-09-04T00:00:00Z' }),
        '{"oops',
      ].join('\n'),
    )
    expect(names.get(ID_A)).toBe('新名')
    expect(names.has(ID_B)).toBe(false)
  })
})

// ---------- 文件扫描 ----------

describe('listThreadsFromDisk', () => {
  test('基础：按 mtime 降序、字段齐全、名字从 session_index 解析', async () => {
    writeRollout(ID_A, [metaLine(ID_A), userMessageLine('旧线程')], {
      mtime: new Date('2026-09-01T00:00:00Z'),
    })
    writeRollout(ID_B, [metaLine(ID_B), userMessageLine('新线程')], {
      day: '2026/09/11',
      mtime: new Date('2026-09-10T00:00:00Z'),
    })
    writeFileSync(
      join(home, 'session_index.jsonl'),
      JSON.stringify({ id: ID_B, thread_name: '被改名的线程', updated_at: '2026-09-10T00:00:00Z' }) + '\n',
    )

    const rows = await listThreadsFromDisk(home)
    expect(rows.map((r) => r.id)).toEqual([ID_B, ID_A])
    expect(rows[0]).toMatchObject({ name: '被改名的线程', preview: '新线程', cwd: '/tmp/proj' })
    expect(rows[1].name).toBeUndefined()
    expect(rows[0].updatedAt).toBeCloseTo(new Date('2026-09-10T00:00:00Z').getTime() / 1000, 0)
  })

  test('source 过滤与 RPC 一致：cli/vscode/exec/mcp 进，subagent/custom/unknown/缺失 排除', async () => {
    writeRollout(ID_A, [metaLine(ID_A, { source: { subagent: { thread_spawn: {} } } }), userMessageLine('x')])
    writeRollout(ID_B, [metaLine(ID_B, { source: 'mcp' }), userMessageLine('x')])
    writeRollout(ID_C, [metaLine(ID_C, { source: 'unknown' }), userMessageLine('x')])
    writeRollout('01a00000-0000-7000-8000-dddddddddddd', [
      metaLine('01a00000-0000-7000-8000-dddddddddddd', { source: { custom: 'x' } }),
      userMessageLine('x'),
    ])
    const rows = await listThreadsFromDisk(home)
    expect(rows.map((r) => r.id)).toEqual([ID_B])
  })

  test('入列要求 preview（上游 list.rs:819-820 同款）：无 preview 的线程不入列但不算漂移', async () => {
    writeRollout(ID_A, [metaLine(ID_A)]) // 只有 meta
    writeRollout(ID_B, [metaLine(ID_B), userMessageLine('有内容')])
    const rows = await listThreadsFromDisk(home)
    expect(rows.map((r) => r.id)).toEqual([ID_B])
  })

  test('sawSessionMeta 需要字符串 id：meta 缺 id 时触发漂移跳线', async () => {
    const noId = JSON.stringify({
      timestamp: '2026-09-10T11:00:00.000Z',
      type: 'session_meta',
      payload: { thread_id: ID_A, cwd: '/tmp/proj', source: 'cli' },
    })
    writeRollout(ID_A, [noId, userMessageLine('x')])
    await expect(listThreadsFromDisk(home)).rejects.toBeInstanceOf(DiskDiscoveryError)
  })

  test('archived 走 archived_sessions 根', async () => {
    writeRollout(ID_A, [metaLine(ID_A), userMessageLine('活跃')], { mtime: new Date('2026-09-01T00:00:00Z') })
    writeRollout(ID_B, [metaLine(ID_B), userMessageLine('已归档')], { archived: true })
    expect((await listThreadsFromDisk(home)).map((r) => r.id)).toEqual([ID_A])
    expect((await listThreadsFromDisk(home, { archived: true })).map((r) => r.id)).toEqual([ID_B])
  })

  test('空目录 → 空列表（新安装非漂移）', async () => {
    expect(await listThreadsFromDisk(home)).toEqual([])
  })

  test('漂移跳线①：有文件但无一含 session_meta → 抛 DiskDiscoveryError', async () => {
    writeRollout(ID_A, [JSON.stringify({ type: 'event_msg', payload: { type: 'x' } })])
    await expect(listThreadsFromDisk(home)).rejects.toBeInstanceOf(DiskDiscoveryError)
  })

  test('mtime 变化触发重解析（缓存不失效就是 bug）', async () => {
    const path = writeRollout(ID_A, [metaLine(ID_A), userMessageLine('改前')])
    expect((await listThreadsFromDisk(home))[0].preview).toBe('改前')
    writeFileSync(path, [metaLine(ID_A), userMessageLine('改后')].join('\n') + '\n')
    utimesSync(path, new Date(), new Date())
    expect((await listThreadsFromDisk(home))[0].preview).toBe('改后')
  })

  test('同 id 多文件（resume 续跑）去重：取最新 mtime 行，createdAt 取更早者', async () => {
    // 原始线程（09-07 创建）+ 续跑文件（09-09，meta id 相同且也有自己的 preview）
    writeRollout(ID_A, [metaLine(ID_A, { timestamp: '2026-09-07T08:00:00.000Z' }), userMessageLine('原始问题')], {
      day: '2026/09/07',
      mtime: new Date('2026-09-07T09:00:00Z'),
    })
    writeRollout(ID_A, [metaLine(ID_A, { timestamp: '2026-09-09T06:00:00.000Z' }), userMessageLine('续跑提问')], {
      day: '2026/09/09',
      mtime: new Date('2026-09-09T10:00:00Z'),
    })
    const rows = await listThreadsFromDisk(home)
    expect(rows.length).toBe(1)
    expect(rows[0].preview).toBe('续跑提问')
    expect(rows[0].updatedAt).toBeCloseTo(new Date('2026-09-09T10:00:00Z').getTime() / 1000, 0)
    expect(rows[0].createdAt).toBeCloseTo(Date.parse('2026-09-07T08:00:00.000Z') / 1000, 0)
  })

  test('续跑文件无 preview 时该行不产生，线程以原始文件入列', async () => {
    writeRollout(ID_A, [metaLine(ID_A, { timestamp: '2026-09-07T08:00:00.000Z' }), userMessageLine('原始问题')], {
      day: '2026/09/07',
      mtime: new Date('2026-09-07T09:00:00Z'),
    })
    writeRollout(ID_A, [metaLine(ID_A, { timestamp: '2026-09-09T06:00:00.000Z' })], {
      day: '2026/09/09',
      mtime: new Date('2026-09-09T10:00:00Z'),
    })
    const rows = await listThreadsFromDisk(home)
    expect(rows.length).toBe(1)
    expect(rows[0].preview).toBe('原始问题')
    expect(rows[0].updatedAt).toBeCloseTo(new Date('2026-09-07T09:00:00Z').getTime() / 1000, 0)
  })

  test('垃圾文件与空骨架目录不触发漂移跳线', async () => {
    mkdirSync(join(home, 'sessions', '2026', '09', '10'), { recursive: true })
    writeFileSync(join(home, 'sessions', '2026', '09', '10', '.DS_Store'), 'junk')
    writeFileSync(join(home, 'sessions', '2026', '09', '10', 'Thumbs.db'), 'junk')
    expect(await listThreadsFromDisk(home)).toEqual([])
  })

  test('不可识别后缀的 rollout-* 文件（如 .jsonl.zst）触发漂移跳线', async () => {
    mkdirSync(join(home, 'sessions', '2026', '09', '10'), { recursive: true })
    writeFileSync(join(home, 'sessions', '2026', '09', '10', 'rollout-x.jsonl.zst'), 'compressed?')
    await expect(listThreadsFromDisk(home)).rejects.toBeInstanceOf(DiskDiscoveryError)
  })

  test('limit 截断', async () => {
    for (let i = 0; i < 5; i++) {
      writeRollout(`01a00000-0000-7000-8000-00000000000${i}`, [
        metaLine(`01a00000-0000-7000-8000-00000000000${i}`),
        userMessageLine(`消息 ${i}`),
      ])
    }
    expect((await listThreadsFromDisk(home, { limit: 3 })).length).toBe(3)
  })
})
