// 斜杠命令面板数据层（纯函数，从 Chat.tsx 抽出以便单测）：
// 清单合并 = cc-remote 自有命令置顶（中文描述优先于 CLI 同名）+ CLI 报告清单去重后按原序追加；
// 提示过滤 = 前缀匹配，且仅在「以 / 开头、还没进参数区（无空格）」时出提示。
// 审计背景见 docs/audits/2026-08-slash-commands.md。

/** cc-remote 自有命令（双后端对齐过的最小集；claude 侧没有的语义由前端拦截实现） */
export const FALLBACK_COMMANDS: readonly string[] = [
  'compact',
  'context',
  'rewind',
  'btw',
  'branch',
  'goal',
  'review',
  'rename',
  'new',
]

export const COMMAND_DESC: Record<string, string> = {
  compact: '压缩上下文',
  context: '查看上下文占用',
  rewind: '回滚到之前的消息',
  btw: '侧问（借上下文一次性问答，不进历史）',
  branch: '分叉当前会话为新分支（原会话不动）',
  goal: '设定目标，agent 持续工作直到达成（/goal clear 清除）',
  review: '审查当前改动',
  rename: '重命名会话',
  new: '新开会话（当前会话保留）',
}

export interface SlashEntry {
  name: string
  desc?: string
}

/**
 * 合并面板清单：自有命令置顶（描述以 COMMAND_DESC 为准），
 * CLI 清单（initialize 握手或 init 消息报告）去掉与自有同名项后按原序追加。
 */
export function mergeSlashCommands(cliCommands: SlashEntry[]): SlashEntry[] {
  const custom = FALLBACK_COMMANDS.map((n) => ({ name: n, desc: COMMAND_DESC[n] }))
  return [...custom, ...cliCommands.filter((c) => !FALLBACK_COMMANDS.includes(c.name))]
}

/** 前缀过滤：输入 '/b' 命中 btw/branch；非斜杠输入或已进入参数区（含空格）不出提示 */
export function filterSlashHints(input: string, entries: SlashEntry[]): SlashEntry[] {
  if (!input.startsWith('/') || input.includes(' ')) return []
  return entries.filter((c) => `/${c.name}`.startsWith(input.trim()))
}
