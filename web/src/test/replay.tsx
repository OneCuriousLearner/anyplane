// 转录回放 harness（Layer 2）：fixture → 真实 useTranscriptIngest/useTaskBuckets →
// buildTranscriptRows → Transcript 渲染，逐相位断言 DOM 不变量。
//
// fixture 由 server/scripts/record-transcript.ts 在真实 CLI 会话上录制（客户端视角的
// WS 事件流 + 重进 history 载荷，非 mock——AGENTS.md「非必要不 mock」）。
// 与 Chat 的差异只有窗口化切片与 WS 连接：归并（ingest）、行构建（blocks）、
// 渲染（Transcript）全是生产同一份代码——这正是纯函数单测够不到的整链层：
// 流式捕捉失败（partial 合并/乱序缓冲/孤儿结果）、元素重复（重进思考双份）、
// 元素混乱（配对错位/串行）都在这条链上现形。

import type { BackendCapabilities, CliMsg, HistoryResponse } from '@anyplane/protocol'
import { act, useEffect, useMemo, useRef } from 'react'
import { Transcript } from '../components/Transcript'
import { useTaskBuckets } from '../hooks/useTaskBuckets'
import { type Draft, type TranscriptIngestApi, useTranscriptIngest } from '../hooks/useTranscriptIngest'
import { buildTranscriptRows, type ChatMsg } from '../lib/blocks'
import type { SessionSocket } from '../lib/ws'
import { render } from './dom'

export interface TranscriptFixture {
  meta: {
    backend: string
    scenario: string
    prompt?: string
    recordedAt?: string
    approvals?: number
    source?: string
  }
  /** 重进场景的 history REST 载荷；live 录制为 null（新会话空抄本等价空 history） */
  history: HistoryResponse | null
  events: Record<string, unknown>[]
}

/** 读 fixtures 目录下的录制文件（提交物是 .json.gz——流式逐 token delta 的美化 JSON
 *  体积/行数虚高一个数量级；录制器双写的 .json 美化版 gitignore 供人工过目） */
export async function loadFixture(name: string): Promise<TranscriptFixture> {
  const base = name.endsWith('.json') ? name.slice(0, -'.json'.length) : name
  const raw = Bun.gunzipSync(await Bun.file(`${import.meta.dir}/fixtures/${base}.json.gz`).arrayBuffer())
  return JSON.parse(new TextDecoder().decode(raw)) as TranscriptFixture
}

interface HarnessBox {
  current?: { api: TranscriptIngestApi }
}

/** 回放宿主：与 Chat 同款的 hook 组合 + Transcript 直渲（回放数据量小，不做窗口化） */
function Harness(props: { isCodex: boolean; box: HarnessBox }) {
  const capsRef = useRef<BackendCapabilities | undefined>(undefined)
  const sockRef = useRef<SessionSocket | undefined>(undefined)
  const { api: taskApi } = useTaskBuckets({ isCodex: props.isCodex })
  const { messages, draft, api } = useTranscriptIngest({ capsRef, sockRef, taskApi })
  // api 每渲染重建但永不过期（hook 注释）——无依赖数组 effect 保证 box 拿到的恒为最新
  useEffect(() => {
    props.box.current = { api }
  })
  const rows = useMemo(() => buildTranscriptRows(messages, draft), [messages, draft])
  return <Transcript rows={rows} draft={draft} />
}

export interface ReplayHandle {
  container: HTMLElement
  /** 从游标起再推 n 条事件（一批一次 act，相位间 DOM 可断言） */
  pushNext: (n: number) => Promise<void>
  /** 推到首个命中 pred 的事件为止（默认含该事件）；未命中返回 -1 */
  pushUntil: (pred: (ev: Record<string, unknown>) => boolean, opts?: { inclusive?: boolean }) => Promise<number>
  /** 推完剩余全部事件 */
  pushRest: () => Promise<void>
  messages: () => ChatMsg[]
  draft: () => Draft | null
  unmount: () => Promise<void>
}

export async function mountReplay(fixture: TranscriptFixture): Promise<ReplayHandle> {
  const box: HarnessBox = {}
  const r = await render(<Harness isCodex={fixture.meta.backend === 'codex'} box={box} />)
  const api = (): TranscriptIngestApi => {
    if (!box.current) throw new Error('Harness 未就绪')
    return box.current.api
  }
  // 重进水合（history 为 null = 新会话，空抄本起步）
  if (fixture.history) {
    await act(async () => {
      api().applyHistory(fixture.history!)
    })
  }

  let cursor = 0
  const dispatchBatch = async (batch: Record<string, unknown>[]) => {
    await act(async () => {
      for (const ev of batch) {
        // v1 只喂 cli：status/approval_request/moved 驱动的是状态栏/审批卡/导航，
        // 不进主抄本（侧问 btw_* 与外部 tail 事件是另外两条路，本批 fixture 未覆盖）
        if (ev.kind === 'cli') api().handleCli(ev.msg as CliMsg, ev.replay === true)
      }
    })
  }

  const handle: ReplayHandle = {
    container: r.container,
    pushNext: async (n) => {
      const batch = fixture.events.slice(cursor, cursor + n)
      cursor += batch.length
      await dispatchBatch(batch)
    },
    pushUntil: async (pred, opts) => {
      let i = cursor
      while (i < fixture.events.length && !pred(fixture.events[i]!)) i++
      if (i >= fixture.events.length) return -1
      const end = opts?.inclusive === false ? i : i + 1
      const batch = fixture.events.slice(cursor, end)
      cursor = end
      await dispatchBatch(batch)
      return cursor
    },
    pushRest: async () => {
      await handle.pushNext(fixture.events.length - cursor)
    },
    messages: () => api().messagesStore.get(),
    draft: () => api().draftStore.get(),
    unmount: r.unmount,
  }
  return handle
}

// ---------- 通用不变量（与场景无关，每条回放都该成立） ----------

/** 模型层：消息 id / 工具块 id 唯一性（重复元素问题在 React 警告之前就位） */
export function modelProblems(msgs: ChatMsg[]): string[] {
  const problems: string[] = []
  const msgIds = new Set<string>()
  const toolIds = new Set<string>()
  for (const m of msgs) {
    if (msgIds.has(m.id)) problems.push(`重复消息 id: ${m.id}（role=${m.role}）`)
    msgIds.add(m.id)
    for (const b of m.blocks) {
      if (b.kind !== 'tool') continue
      if (toolIds.has(b.id)) problems.push(`重复工具块 id: ${b.id}（${b.name}）`)
      toolIds.add(b.id)
    }
  }
  return problems
}

/** 终态（turn 收尾后）：没有悬着的 pending 工具卡 */
export function pendingTools(msgs: ChatMsg[]): string[] {
  const out: string[] = []
  for (const m of msgs) {
    for (const b of m.blocks) {
      if (b.kind === 'tool' && b.pending === true) out.push(`${b.name}(${b.id})`)
    }
  }
  return out
}

export const countThinking = (msgs: ChatMsg[]): number =>
  msgs.reduce((n, m) => n + m.blocks.filter((b) => b.kind === 'thinking').length, 0)

export const countTools = (msgs: ChatMsg[]): number =>
  msgs.reduce((n, m) => n + m.blocks.filter((b) => b.kind === 'tool').length, 0)
