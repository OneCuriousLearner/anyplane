import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { type ConsoleErrorSpy, restoreConsoleError, setupDom, thinkingButtons, toolButtons, unmountAll, watchConsoleError } from './dom'
import {
  countThinking,
  countTools,
  loadFixture,
  modelProblems,
  mountReplay,
  pendingTools,
  type ReplayHandle,
  type TranscriptFixture,
} from './replay'

// ---------- 事件谓词（相位切分用） ----------
const isCli = (ev: Record<string, unknown>): boolean => ev.kind === 'cli'
const msgOf = (ev: Record<string, unknown>) => ev.msg as Record<string, unknown> | undefined
const isToolUseStart = (ev: Record<string, unknown>): boolean => {
  if (!isCli(ev) || msgOf(ev)?.type !== 'stream_event') return false
  const e = msgOf(ev)?.event as { type?: string; content_block?: { type?: string } } | undefined
  return e?.type === 'content_block_start' && e?.content_block?.type === 'tool_use'
}
const isPartialResult = (ev: Record<string, unknown>): boolean => isCli(ev) && msgOf(ev)?.partial === true

// 回放只喂 cli 事件，其余 kind 必须落在已知集合内（终态用例另断言精确集合）——
// 「本批 fixture 未覆盖」由断言承载而非注释，新 kind 混进 fixture 会在这里炸出来
const SKIPPED_KINDS = new Set(['status', 'moved', 'approval_request', 'approval_resolved'])
const expectSkippedKnown = (r: ReplayHandle) => {
  for (const k of r.droppedKinds()) expect(SKIPPED_KINDS.has(k)).toBe(true)
}

let claudeLive: TranscriptFixture
let codexLive: TranscriptFixture
let claudeReentry: TranscriptFixture
let codexReentry: TranscriptFixture

describe('转录回放（真实会话 fixture → ingest → DOM 整链）', () => {
  let teardown: () => void
  // key 警告是重复元素的通用探测器：每条回放都必须零 key 碰撞，放 afterEach 统一断言
  let errorSpy: ConsoleErrorSpy
  beforeAll(async () => {
    teardown = setupDom()
    ;[claudeLive, codexLive, claudeReentry, codexReentry] = await Promise.all([
      loadFixture('claude-streaming-tools.json'),
      loadFixture('codex-streaming-tools.json'),
      loadFixture('claude-reentry.json'),
      loadFixture('codex-reentry.json'),
    ])
  })
  afterAll(() => teardown())
  beforeEach(() => {
    errorSpy = watchConsoleError()
  })
  afterEach(async () => {
    restoreConsoleError(errorSpy)
    await unmountAll()
  })

  describe('claude 流式工具会话（live 183 事件：思考流 + Read/Bash + 审批）', () => {
    test('相位：首个工具调用出现时，草稿思考展开、草稿工具折叠', async () => {
      const r = await mountReplay(claudeLive)
      const at = await r.pushUntil(isToolUseStart)
      expect(at).toBeGreaterThan(0)
      expectSkippedKnown(r)
      // 草稿里有思考（22 个 thinking_delta 在工具前）与 pending 工具
      const d = r.draft()
      expect(d?.blocks.some((b) => b.kind === 'thinking')).toBe(true)
      expect(d?.blocks.some((b) => b.kind === 'tool')).toBe(true)
      // 思考随流式展开（唯一自动开合）；工具卡恒折叠、pending 标 …
      const ths = [...thinkingButtons(r.container)]
      expect(ths.length).toBeGreaterThan(0)
      expect(ths.every((b) => b.getAttribute('aria-expanded') === 'true')).toBe(true)
      expect(toolButtons(r.container).length).toBeGreaterThan(0)
      expect(r.container.querySelector('pre')).toBeNull()
      expect(r.container.textContent).toContain('…')
    })

    test('终态：归并不变量 + 输出完整捕捉 + 全部折叠归零', async () => {
      const r = await mountReplay(claudeLive)
      await r.pushRest()
      expect(r.droppedKinds()).toEqual(['approval_request', 'approval_resolved', 'moved', 'status'])
      const msgs = r.messages()
      // fixture sanity：2 个工具卡、思考存在（防恒真断言）
      expect(countTools(msgs)).toBe(2)
      expect(countThinking(msgs)).toBeGreaterThan(0)
      expect(modelProblems(msgs)).toEqual([])
      expect(pendingTools(msgs)).toEqual([])
      // Bash 卡的 12 行 tick 输出完整到达（pairing/delta 没漏）
      const bash = msgs.flatMap((m) => m.blocks).find((b) => b.kind === 'tool' && b.name === 'Bash')
      expect(bash?.kind === 'tool' && bash.resultText).toContain('tick-12')
      // DOM 与模型同数、全部默认折叠
      expect(toolButtons(r.container)).toHaveLength(2)
      expect(thinkingButtons(r.container).length).toBe(countThinking(msgs))
      for (const b of thinkingButtons(r.container)) expect(b.getAttribute('aria-expanded')).toBe('false')
      expect(r.container.querySelector('pre')).toBeNull()
    })
  })

  describe('codex 流式工具会话（live 153 事件：reasoning + 12 条 partial tool_result）', () => {
    test('相位：首条 partial 到达时，pending 卡已合并部分输出且保持折叠', async () => {
      const r = await mountReplay(codexLive)
      const at = await r.pushUntil(isPartialResult)
      expect(at).toBeGreaterThan(0)
      expectSkippedKnown(r)
      // 模型：pending 卡带部分结果（partial 合并生效的直接证据）
      const tools = r.messages().flatMap((m) => m.blocks).filter((b) => b.kind === 'tool')
      const pending = tools.find((b) => b.kind === 'tool' && b.pending === true)
      expect(pending?.kind === 'tool' && typeof pending.resultText === 'string' && pending.resultText.length > 0).toBe(true)
      // DOM：运行中标 …、恒折叠（部分输出不外泄——Bug 1 决策的链级回归）
      expect(r.container.textContent).toContain('…')
      expect(r.container.querySelector('pre')).toBeNull()
    })

    test('终态：12 条 partial 全合并、思考/工具计数与折叠不变量', async () => {
      const r = await mountReplay(codexLive)
      await r.pushRest()
      expect(r.droppedKinds()).toEqual(['moved', 'status'])
      const msgs = r.messages()
      expect(countTools(msgs)).toBeGreaterThanOrEqual(3)
      expect(countThinking(msgs)).toBeGreaterThanOrEqual(1)
      expect(modelProblems(msgs)).toEqual([])
      expect(pendingTools(msgs)).toEqual([])
      // 命令输出首行到末行都在——12 条 partial 一条不丢（流式捕捉的端到端证据）
      //（会话有多张 Bash 卡：按 tick 输出定位循环命令那张，而非首张）
      const bash = msgs
        .flatMap((m) => m.blocks)
        .find((b) => b.kind === 'tool' && b.name === 'Bash' && b.resultText?.includes('tick-'))
      expect(bash?.kind === 'tool' && bash.resultText).toContain('tick-1\r')
      expect(bash?.kind === 'tool' && bash.resultText).toContain('tick-12')
      expect(toolButtons(r.container).length).toBe(countTools(msgs))
      expect(thinkingButtons(r.container).length).toBe(countThinking(msgs))
      expect(r.container.querySelector('pre')).toBeNull()
    })
  })

  describe('重进会话（history 水合整链）', () => {
    test('claude：14 条历史全部归位，工具结果配对完整', async () => {
      const r = await mountReplay(claudeReentry)
      expect(r.droppedKinds()).toEqual([])
      const msgs = r.messages()
      // fixture sanity：4 工具 2 思考（录制分析口径）
      expect(countTools(msgs)).toBe(4)
      expect(countThinking(msgs)).toBe(2)
      expect(modelProblems(msgs)).toEqual([])
      expect(pendingTools(msgs)).toEqual([])
      // 历史配对完整：每张工具卡都有结果（孤儿结果不该出现）
      const unpaired = msgs.flatMap((m) => m.blocks).filter((b) => b.kind === 'tool' && b.resultText == null)
      expect(unpaired).toEqual([])
      expect(msgs.filter((m) => m.systemKind === 'info' || m.systemKind === 'error')).toEqual([])
      // DOM：全部默认折叠（重进后无自动展开——Bug 1 决策链级回归）
      expect(toolButtons(r.container)).toHaveLength(4)
      expect(thinkingButtons(r.container)).toHaveLength(2)
      expect(r.container.querySelector('pre')).toBeNull()
    })

    test('codex：思考块去重的链级回归（Bug 2——侧车与 inline 双源不得渲染两遍）', async () => {
      const r = await mountReplay(codexReentry)
      expect(r.droppedKinds()).toEqual([])
      const msgs = r.messages()
      // fixture sanity：6 工具 2 思考（若服务端去重退化，这里会先变成 4 份思考）
      expect(countTools(msgs)).toBe(6)
      expect(countThinking(msgs)).toBe(2)
      expect(modelProblems(msgs)).toEqual([])
      expect(pendingTools(msgs)).toEqual([])
      // 每份思考文本唯一（同一思考渲染两遍的直断）
      const texts = msgs.flatMap((m) => m.blocks).filter((b) => b.kind === 'thinking').map((b) => (b.kind === 'thinking' ? b.text : ''))
      expect(new Set(texts).size).toBe(texts.length)
      expect(toolButtons(r.container)).toHaveLength(6)
      expect(thinkingButtons(r.container)).toHaveLength(2)
      expect(r.container.querySelector('pre')).toBeNull()
    })
  })
})
