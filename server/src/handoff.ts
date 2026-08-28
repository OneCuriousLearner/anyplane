// 接力（handoff）：源会话 fork 自摘要 → 目标会话播种简报 → 血缘记录。
// 已在 handoff-lab 实验验证：两家的"对话内隐藏设计"可经简报无损传递（见 docs/PLAN 附录）。

import { spawn } from 'bun'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { resolveClaudeCommand } from './backends/claude/processManager'
import { codexRuntime } from './backends/codex/runtime'
import type { BackendName } from './backends/types'
import { ensurePrivateDir, pumpLines } from './util'

export type HandoffDetail = 'brief' | 'standard' | 'detailed'

const BRIEF_LIMITS: Record<HandoffDetail, number> = { brief: 300, standard: 500, detailed: 800 }

export const BACKEND_LABEL: Record<BackendName, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
}

/** 两个后端共用的简报提示词（与实验验证过的措辞一致） */
export function briefPrompt(detail: HandoffDetail): string {
  return `假设你要把这个项目交接给另一个 coding agent（它看不到我们的对话，只能看到文件系统和 git 历史）继续开发。请写一份交接简报，包含：项目目标、当前进度、关键架构决策（尤其是只存在于我们对话里、没写进任何文件的决定）、文件清单与状态、明确的下一步任务。${BRIEF_LIMITS[detail]}字以内，直接输出简报正文，不要客套话。`
}

/** 目标会话的首条消息：简报 + 现场确认指令（实验验证的关键一环） */
export function seedMessage(cwd: string, sourceBackend: BackendName, brief: string): string {
  return `你在 ${cwd} 接替另一个 agent（${BACKEND_LABEL[sourceBackend]}）继续开发这个项目。以下是它写的交接简报：

${brief}

请先确认现场（git log --oneline、读关键文件验证简报属实），然后继续接手工作。`
}

// ---------- Claude 侧简报：fork-session 一次性问答（源会话不在线时的路径） ----------

export async function generateClaudeBrief(
  cwd: string,
  sessionId: string,
  detail: HandoffDetail,
  timeoutMs = 180_000,
): Promise<{ text: string; usage?: Record<string, number> }> {
  const { cmd, prefix } = resolveClaudeCommand()
  const question = briefPrompt(detail)
  const proc = spawn(
    [
      cmd,
      ...prefix,
      '-p',
      question,
      '--fork-session',
      '--resume',
      sessionId,
      '-n',
      'FORK: 交接简报',
      '--output-format',
      'stream-json',
      '--verbose',
      // --bare（2.1.220 实测与 fork-session 兼容）：跳过 hooks/LSP/plugin 同步/CLAUDE.md
      // 自动发现等，一次性 spawn 提速约 46%（5.6s→3.0s）。简报内容来自对话历史，
      // CLAUDE.md 缺席对简报质量影响可忽略；用户 hooks 在临时 fork 上本就不该触发。
      '--bare',
    ],
    { cwd, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', env: { ...process.env } },
  )
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      try {
        proc.kill()
      } catch {}
      reject(new Error('简报生成超时'))
    }, timeoutMs)
    let finalText = ''
    let isError = false
    let usage: Record<string, number> | undefined
    void (async () => {
      try {
        await pumpLines(
          proc.stdout as ReadableStream<Uint8Array>,
          (line) => {
            if (!line.startsWith('{')) return
            let obj: Record<string, unknown>
            try {
              obj = JSON.parse(line)
            } catch {
              return
            }
            if (obj.type === 'result') {
              finalText = String(obj.result ?? '')
              isError = obj.is_error === true
              usage = (obj.usage as Record<string, number> | undefined) ?? undefined
            }
          },
          (e) => {
            throw e // 交外层 catch 统一 reject
          },
        )
        const code = await proc.exited
        clearTimeout(timer)
        if (isError || code !== 0 || !finalText.trim()) {
          reject(new Error(`简报生成失败: ${finalText || `exit ${code}`}`))
        } else {
          resolve({ text: finalText.trim(), usage })
        }
      } catch (e) {
        clearTimeout(timer)
        reject(e instanceof Error ? e : new Error(String(e)))
      }
    })()
  })
}

// ---------- Codex 侧简报：ephemeral fork（纯内存，只读沙箱） ----------

export async function generateCodexBrief(
  threadId: string,
  detail: HandoffDetail,
): Promise<{ text: string; usage?: Record<string, number> }> {
  return codexRuntime.runEphemeralQuestion(threadId, briefPrompt(detail))
}

// ---------- 血缘 ----------

export interface LineageRecord {
  id: string
  at: string
  fromKey: string
  toKey: string
  /** 解析后的真实会话 key（s|slug|sid / x|threadId）；目标 sessionId 就绪后回填 */
  fromResolvedKey?: string
  toResolvedKey?: string
  fromBackend: BackendName
  toBackend: BackendName
  cwd: string
  detail: HandoffDetail
  brief: string
  briefUsage?: Record<string, number>
}

function lineageDir(): string {
  return ensurePrivateDir(join(homedir(), '.cc-remote'))
}

function lineagePath(): string {
  return join(lineageDir(), 'lineage.json')
}

export function appendLineage(rec: LineageRecord): void {
  const path = lineagePath()
  let all: LineageRecord[] = []
  if (existsSync(path)) {
    try {
      all = JSON.parse(readFileSync(path, 'utf8')) as LineageRecord[]
    } catch {
      all = []
    }
  }
  all.push(rec)
  writeFileSync(path, JSON.stringify(all, null, 2))
}

export function lineageFor(key: string): LineageRecord[] {
  const path = lineagePath()
  if (!existsSync(path)) return []
  try {
    const all = JSON.parse(readFileSync(path, 'utf8')) as LineageRecord[]
    return all.filter(
      (r) =>
        r.fromKey === key ||
        r.toKey === key ||
        r.fromResolvedKey === key ||
        r.toResolvedKey === key,
    )
  } catch {
    return []
  }
}
