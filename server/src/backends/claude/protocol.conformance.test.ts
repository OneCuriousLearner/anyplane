// 协议一致性：把手抄的协议清单与**官方正本**对账。
//
// 正本 = server/scripts/protocol-baseline.claude.json，由 check-claude-protocol.ts 从
// 官方公开包 @anthropic-ai/claude-agent-sdk 的 sdk.d.ts 提取（CI 每周重跑，漂移开 issue）。
//
// 这层测试防的是手抄清单特有的两类静默失效：
//   ① 抄了个上游根本没有的 subtype —— 发出去被 CLI 回 "Unsupported control request subtype"，
//      而 AnyPlane 侧只当作一次普通失败，用户看到功能"偶尔不灵"
//   ② 上游改名/移除后这里仍留着旧名 —— 同上，且漂移检测只报"官方少了一项"，
//      不会告诉你"你正在用这一项"
// 单纯的 schema diff 报不出这两条，必须拿自己的清单去对。

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { CONTROL_REQUEST_SUBTYPES, PRINT_ONLY_SUBTYPES } from './protocol'

interface Baseline {
  extractedAt: string
  source: string
  controlSubtypes: string[]
  stdoutTypes: string[]
  systemSubtypes: string[]
}

const baselinePath = join(import.meta.dir, '../../../scripts/protocol-baseline.claude.json')
const baseline = JSON.parse(readFileSync(baselinePath, 'utf8')) as Baseline
/** npm 提取路径下 control 与 system subtype 混在同一形态，合成一张全集比对 */
const officialSubtypes = new Set([...baseline.controlSubtypes, ...baseline.systemSubtypes])

describe('control_request subtype 与官方正本对账', () => {
  test('基线自身可用（非空且来源已记录）', () => {
    expect(baseline.source).toBeTruthy()
    expect(officialSubtypes.size).toBeGreaterThan(20)
    expect(baseline.stdoutTypes.length).toBeGreaterThan(10)
  })

  test('除已登记的 print-only 例外，我们发出的每个 subtype 官方都存在', () => {
    const printOnly = new Set<string>(PRINT_ONLY_SUBTYPES)
    const missing = CONTROL_REQUEST_SUBTYPES.filter((s) => !officialSubtypes.has(s) && !printOnly.has(s))
    // 失败时把缺失项直接打出来：多半是上游改名，去 sdk.d.ts 找新名字；
    // 若确认是官方未声明的 headless 私货，登记进 PRINT_ONLY_SUBTYPES 并写明风险
    expect({ missing, source: baseline.source }).toEqual({ missing: [], source: baseline.source })
  })

  test('print-only 例外清单保持最小：一旦官方收编就该移出去', () => {
    // 移出去不只是整洁问题——进了官方清单才会被漂移检测覆盖
    const promoted = PRINT_ONLY_SUBTYPES.filter((s) => officialSubtypes.has(s))
    expect({ promoted, hint: '这些已进官方清单，请从 PRINT_ONLY_SUBTYPES 移除以纳入漂移检测' }).toEqual({
      promoted: [],
      hint: '这些已进官方清单，请从 PRINT_ONLY_SUBTYPES 移除以纳入漂移检测',
    })
  })

  test('print-only 例外必须逐条有据：不是随手加白名单', () => {
    // 数量刻意钉死：新增一项就要改这里，逼你在 PR 里解释为什么又依赖了一个未声明接口
    expect(PRINT_ONLY_SUBTYPES).toEqual(['side_question', 'generate_session_title'])
  })

  test('清单无重复项（手抄易漏）', () => {
    expect(new Set(CONTROL_REQUEST_SUBTYPES).size).toBe(CONTROL_REQUEST_SUBTYPES.length)
  })
})

describe('录制 fixture 与官方正本对账', () => {
  const fixture = join(import.meta.dir, '../../../scripts/fixtures/claude-turn-basic.jsonl')
  const lines = readFileSync(fixture, 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)

  test('fixture 可解析且非空', () => {
    expect(lines.length).toBeGreaterThan(5)
    for (const l of lines) expect(() => JSON.parse(l)).not.toThrow()
  })

  test('真实报文里出现的每个 type / subtype 官方都认', () => {
    const types = new Set<string>()
    const subtypes = new Set<string>()
    for (const l of lines) {
      const m = JSON.parse(l) as { type?: unknown; subtype?: unknown }
      if (typeof m.type === 'string') types.add(m.type)
      if (typeof m.subtype === 'string') subtypes.add(m.subtype)
    }
    const unknownTypes = [...types].filter((t) => !baseline.stdoutTypes.includes(t))
    const unknownSubtypes = [...subtypes].filter((s) => !officialSubtypes.has(s))
    // fixture 是真实 CLI 录制的，出现官方清单外的东西说明提取逻辑漏了，不是 CLI 的错
    expect({ unknownTypes, unknownSubtypes }).toEqual({ unknownTypes: [], unknownSubtypes: [] })
  })
})
