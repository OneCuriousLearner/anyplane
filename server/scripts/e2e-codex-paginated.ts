// E2E（方向四）：codex paginated 历史与 thread/revert 全链路。
// 需服务端已启动（bun run dev:server）。真实调用 codex app-server 与模型。
// 服务端配置 authToken 时需要 ANYPLANE_TOKEN 环境变量。
//
// 断言三组：
//  A) 新线程 historyMode=paginated（status 下发）且环形在 turn 完成后即有数
//  B) 历史完整性：readHistory 分页路径含 commandExecution 工具卡（legacy thread/read 缺口修复）
//  C) 原地回滚：rewind_conversation → reverted 广播 + thread_reverted 回声；
//     重读历史该轮已消失；会话 key 不变继续对话（无 fork 导航）
//  D) legacy 线程仍走 fork 降级（可选，传入真实 legacyThreadId 实测）
//
// 不在此断言：paginated 冷 resume 自动补发 tokenUsage（0.153 上游契约，环形水合数据源）——
// e2e 内验证需等 detachRecycleMs(5min)+unload(60s) 释放跨进程 writer lock，超时间预算；
// 该契约由 0.153.4 独立探针钉死并记录在 AGENTS.md「Codex 关键实现点」。
// 用法：bun run server/scripts/e2e-codex-paginated.ts [cwd] [legacyThreadId]

import { mkdtempSync } from 'node:fs'
import { connect, exitWithSummary, makeNote } from './e2e-lib'

// 默认每次跑独立目录：xn|<cwd> 是会话 key，跨次复用会撞上服务端残留 Hub/旧线程
//（实测：同 key 二跑时事件静默不进，turn 悬挂——根因未深挖，用唯一 key 规避整类污染）
const cwd = process.argv[2] ?? mkdtempSync('/tmp/d4-e2e-')
const legacyTid = process.argv[3] // 可选：用一个真实 legacy 线程验证 D 组
const { note, results } = makeNote()

const tokenQ = process.env.ANYPLANE_TOKEN ? `?token=${process.env.ANYPLANE_TOKEN}` : ''
async function fetchCodexHistory(threadId: string): Promise<Array<{ uuid: string; role: string; rewindable?: boolean; blocks: Array<{ kind: string }> }>> {
  const res = await fetch(`http://localhost:7480/api/codex/history/${threadId}${tokenQ}`)
  if (!res.ok) throw new Error(`history HTTP ${res.status}`)
  return ((await res.json()) as { messages: never[] }).messages
}

// ---------- A/B/C：新 paginated 线程 ----------
const key = `xn|${encodeURIComponent(cwd)}`
const { on, send, open } = connect(key)

let threadId = ''
let historyMode = ''
let sawContextByTurn2 = false
let turn3Done = false
let phase: 't1' | 't2' | 't3' = 't1'
let revertedEv: { userMessageId?: string } | null = null
let revertedEcho = false
let finished = false

// ---- 事件轨迹 + 分 turn 超时（模型 flake 时快速失败并留下现场） ----
interface Rec {
  at: number
  name: string
  detail?: string
}
const t0 = Date.now()
const trace: Rec[] = []
const seen = (name: string, detail?: string) => trace.push({ at: Date.now() - t0, name, detail })

/** 每个 turn 独立计时：卡住的 turn 直接失败并 dump 轨迹，不拖到 480s 总时限 */
const TURN_TIMEOUT_MS = 150_000
let turnTimer: ReturnType<typeof setTimeout> | undefined
const armTurnTimer = (label: string) => {
  clearTimeout(turnTimer)
  turnTimer = setTimeout(() => finish(false, `${label} 超时（${TURN_TIMEOUT_MS / 1000}s 无 result）`), TURN_TIMEOUT_MS)
}

const finish = (ok: boolean, label: string) => {
  if (finished) return
  finished = true
  clearTimeout(turnTimer)
  note(ok, label)
  runAssertions().finally(() => {
    if (!ok || results.some((r) => r.startsWith('✗'))) {
      console.log('\n===== 事件轨迹 =====')
      for (const e of trace) console.log(`  [${String(e.at).padStart(7)}] ${e.name}${e.detail ? `  ${e.detail}` : ''}`)
    }
    exitWithSummary(results)
  })
}
setTimeout(() => finish(false, '总时限内未完成（模型挂起/服务停滞/WS 断开）'), 480_000)

on((ev) => {
  if (ev.kind === 'status') {
    const st = ev.state as { historyMode?: string; context?: unknown }
    if (st.historyMode) historyMode = st.historyMode
    if (phase === 't2' && st.context) sawContextByTurn2 = true // turn1 产出 tokenUsage 后环形即有数
    return
  }
  if (ev.kind === 'reverted') {
    revertedEv = ev as { userMessageId?: string }
    seen('reverted', revertedEv.userMessageId)
    console.log('<< reverted', revertedEv.userMessageId)
    // C 组后续：重读历史验证截断，然后原地发 turn3
    setTimeout(() => void afterRevert(), 1500)
    return
  }
  if (ev.kind === 'error') {
    seen('error', String((ev as { message?: unknown }).message ?? '').slice(0, 120))
    return
  }
  if (ev.kind === 'approval_request') {
    // e2e 无人值守：审批一律 accept，避免默认权限模式下 echo 类命令悬挂
    seen('approval_request', String((ev as { toolName?: unknown }).toolName ?? ''))
    send({ kind: 'approval', requestId: (ev as { requestId: string }).requestId, decision: 'accept' })
    return
  }
  if (ev.kind !== 'cli') return
  const m = ev.msg as Record<string, any>
  if (m.type === 'system' && m.subtype === 'thread_reverted') {
    revertedEcho = true
    seen('thread_reverted')
    return
  }
  if (m.type === 'system' && m.subtype === 'init') {
    threadId = String(m.session_id ?? '')
    seen('init', threadId.slice(0, 8))
    return
  }
  if (m.type === 'assistant' || m.type === 'user') {
    // 高频事件只记类别，dump 时能看出"卡在等工具还是等正文"
    const kinds = (m.message?.content ?? []).map((c: { type?: string }) => c?.type ?? '?').join('+')
    if (trace.filter((e) => e.name === `msg:${m.type}:${kinds}`).length < 3) seen(`msg:${m.type}:${kinds}`)
  }
  if (m.type === 'result') {
    seen(`result:${phase}`, m.is_error ? 'error' : 'ok')
    if (phase === 't1') {
      phase = 't2'
      console.log('>> turn2')
      armTurnTimer('turn2')
      setTimeout(() => send({ kind: 'user', text: '运行 shell 命令 `echo d4-marker-b`，然后只回复 done2' }), 500)
    } else if (phase === 't2') {
      console.log('>> turn2 done，执行原地回滚')
      clearTimeout(turnTimer)
      setTimeout(() => void doRevert(), 800)
    } else {
      turn3Done = true
      clearTimeout(turnTimer)
      finish(true, '回滚后原地续聊完成')
    }
  }
})

let revertTarget = ''
async function doRevert() {
  try {
    const hist = await fetchCodexHistory(threadId)
    // B 组断言素材：工具卡 + 两个 rewindable 锚点
    const toolUse = hist.filter((m) => m.blocks.some((b) => b.kind === 'tool_use'))
    const toolResult = hist.filter((m) => m.blocks.some((b) => b.kind === 'tool_result'))
    note(toolUse.length >= 2 && toolResult.length >= 2, 'B1 分页历史含 commandExecution 工具卡（≥2 轮）', `use=${toolUse.length} result=${toolResult.length}`)
    const anchors = hist.filter((m) => m.rewindable === true)
    note(anchors.length === 2, 'B2 每轮首条 userMessage 以 turnId 为 rewindable 锚点', `${anchors.length} 个`)
    revertTarget = anchors[1]?.uuid ?? ''
    if (!revertTarget) throw new Error('缺第二轮 rewindable 锚点')
    armTurnTimer('回滚应答（reverted）')
    send({ kind: 'rewind_conversation', userMessageId: revertTarget })
  } catch (e) {
    finish(false, `回滚前置失败: ${e instanceof Error ? e.message : e}`)
  }
}

async function afterRevert() {
  try {
    const hist = await fetchCodexHistory(threadId)
    const anchors = hist.filter((m) => m.rewindable === true)
    note(anchors.length === 1 && anchors[0].uuid !== revertTarget, 'C3 回滚后重读历史：第二轮已消失', `剩 ${anchors.length} 轮`)
    phase = 't3'
    console.log('>> turn3（原地续聊，key 不变）')
    armTurnTimer('turn3')
    send({ kind: 'user', text: '只回复 done3' })
  } catch (e) {
    finish(false, `回滚后重读历史失败: ${e instanceof Error ? e.message : e}`)
  }
}

async function runAssertions() {
  note(historyMode === 'paginated', 'A1 status 下发 historyMode=paginated', historyMode || '(未下发)')
  // 注意：本脚本只走 thread/start 新线程，从未 resume——不断言"resume 自动补发 tokenUsage"
  // 契约（那是冷 resume 水合路径，e2e 预算内无法验证，见文件头注释）；这里只锁环形数据通路活着
  note(sawContextByTurn2, 'A2 环形数据通路（turn 完成后 context 随 status 下发）')
  note(!!revertedEv && revertedEv!.userMessageId === revertTarget, 'C1 reverted 广播携带目标锚点')
  note(revertedEcho, 'C2 thread_reverted 系统消息回声到达（入环信号）')
  note(turn3Done, 'C4 回滚后原地续聊（无 fork 导航，key 不变）')

  // D) legacy 线程双轨：fork 降级（可选，需传入真实 legacy 线程 id）
  if (legacyTid) {
    try {
      const hist = await fetchCodexHistory(legacyTid)
      const anchor = hist.find((m) => m.rewindable === true)
      if (!anchor) throw new Error('legacy 线程无 rewindable 锚点')
      const d = await new Promise<boolean>((resolve) => {
        const { on: on2, send: send2, open: open2 } = connect(`x|${legacyTid}`)
        const timer = setTimeout(() => resolve(false), 60_000)
        on2((ev) => {
          if (ev.kind === 'forked') {
            clearTimeout(timer)
            console.log('<< legacy forked →', (ev as { targetKey?: string }).targetKey)
            resolve(true)
          }
          if (ev.kind === 'reverted') {
            clearTimeout(timer)
            resolve(false) // legacy 不应走 revert
          }
        })
        void open2().then(() => {
          send2({ kind: 'attach' })
          setTimeout(() => send2({ kind: 'rewind_conversation', userMessageId: anchor.uuid }), 2500)
        })
      })
      note(d, 'D1 legacy 线程回滚降级为 thread/fork（forked 广播）')
    } catch (e) {
      note(false, 'D1 legacy 线程回滚降级为 thread/fork（forked 广播）', e instanceof Error ? e.message : String(e))
    }
  } else {
    note(true, 'D1 legacy 双轨（未传 legacyThreadId，跳过实测）')
  }
}

await open()
console.log('>> open, attach', key)
send({ kind: 'attach' })
setTimeout(() => {
  console.log('>> turn1')
  armTurnTimer('turn1')
  send({ kind: 'user', text: '运行 shell 命令 `echo d4-marker-a`，然后只回复 done1' })
}, 1500)
