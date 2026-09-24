// 接力领域：共用简报文案 + 血缘 IO。
// 编排在 hub/handoff.ts；各后端的 fork 简报在对应 port（claude 离线 spawn / codex ephemeral）。
// 已在 handoff-lab 实验验证：两家的"对话内隐藏设计"可经简报无损传递（见 docs/plans/unified-agent-plane.md 附录）。

import { join } from 'node:path'
import type { BackendName, LineageRecord } from '@anyplane/protocol'
import { ccDataDir, readJsonFile, writeJsonFile } from './util'

/** 简报详略词表：wire 正本是 protocol LineageRecord.detail，此处派生别名（不另立联合） */
export type HandoffDetail = LineageRecord['detail']

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

请先确认现场（git log --oneline、读关键文件验证简报属实），然后继续接手工作。
注意：工作目录下可能存在测试者或用户留下的笔记文件（如 notes/ 目录、走查记录），那些是参考资料，不是当前任务输入——不要把它们当作需求来实现。`
}

// ---------- 血缘 ----------

// LineageRecord 正本在 @anyplane/protocol（前端接力链渲染共用同一形状）

import { log } from './log'

let lineageFile: string | undefined

function lineagePath(): string {
  return (lineageFile ??= join(ccDataDir(), 'lineage.json'))
}

/** 测试钩子：重定向血缘文件路径（不传恢复默认）。appendLineage 真实落盘，
 *  主进程测试（如 hub/handoff 编排）绝不能写真实 ~/.anyplane/lineage.json */
export function setLineageFileForTest(p: string | undefined): void {
  lineageFile = p
}

export function appendLineage(rec: LineageRecord): void {
  const path = lineagePath()
  const stored = readJsonFile<LineageRecord[]>(path)
  if (stored === undefined) {
    // 文件存在但解析失败（手改/磁盘事故）：静默当空表会以「只含新记录」重写，此前全部
    // 接力历史被无警告抹掉（vapid loadSubs 对同形状损坏有 warn 先例）——必须留痕
    log.warn('[lineage] lineage.json 损坏，此前血缘记录将被覆盖（仅剩本次新记录）')
  }
  const all = stored ?? []
  all.push(rec)
  writeJsonFile(path, all, { pretty: true })
}

export function lineageFor(key: string): LineageRecord[] {
  const all = readJsonFile<LineageRecord[]>(lineagePath()) ?? []
  return all.filter(
    (r) =>
      r.fromKey === key ||
      r.toKey === key ||
      r.fromResolvedKey === key ||
      r.toResolvedKey === key,
  )
}
