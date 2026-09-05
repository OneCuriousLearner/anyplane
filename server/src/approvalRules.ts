// 审批规则引擎：把「每条都问人 / 全部放行」升级为按规则分流。
// 设计见 docs/PLAN-drift-guard-and-approval-engine.md 第二节。
//
// 规则有序、首条命中生效、兜底走人工（ask）。匹配字段按工具分发：
//   Bash → input.command（正则）；Write/Edit/Read 等 → input.file_path（glob）；
//   WebFetch → input.url 的域名（后缀匹配）。
// 未知字段 / 坏正则在配置加载时即报错（fail fast），不静默吞掉。

import type { ApprovalDecision } from './backends/types'

// ---------- 配置形状（anyplane.config.json 的 approvalRules 数组元素） ----------

export interface ApprovalRule {
  /** 匹配条件（全部 AND）。至少给一个。 */
  match: {
    /** 工具名，`|` 分隔多值（如 "Bash"、"Write|Edit"） */
    tool?: string
    /** Bash 命令正则（对 input.command 匹配） */
    command?: string
    /** 文件路径 glob（对 input.file_path 匹配，如 "src/**"，或任意层级的 "*.test.ts"） */
    path?: string
    /** 域名后缀匹配（对 input.url 的 hostname，如 "*.anthropic.com"、"github.com"） */
    domain?: string
  }
  /** 命中后的动作 */
  action: 'allow' | 'deny'
  /** 可选备注：UI 留痕卡上显示规则来源 */
  note?: string
}

export interface RuleMatchResult {
  rule: ApprovalRule
  index: number
}

// ---------- 解析与校验（启动/热重载时调用，坏规则直接抛错） ----------

export function parseApprovalRules(raw: unknown): ApprovalRule[] {
  if (raw === undefined || raw === null) return []
  if (!Array.isArray(raw)) {
    throw new Error('approvalRules 必须是数组')
  }
  return raw.map((item, i) => {
    const r = item as ApprovalRule
    if (!r || typeof r !== 'object') throw new Error(`approvalRules[${i}] 不是对象`)
    if (r.action !== 'allow' && r.action !== 'deny') {
      throw new Error(`approvalRules[${i}].action 必须是 "allow" 或 "deny"（收到 ${JSON.stringify(r.action)}）`)
    }
    const m = r.match
    if (!m || typeof m !== 'object') throw new Error(`approvalRules[${i}].match 缺失`)
    if (m.command !== undefined) {
      try {
        new RegExp(m.command)
      } catch (e) {
        throw new Error(`approvalRules[${i}].match.command 正则无效: ${m.command}（${(e as Error).message}）`)
      }
    }
    if (m.tool === undefined && m.command === undefined && m.path === undefined && m.domain === undefined) {
      throw new Error(`approvalRules[${i}].match 至少要有一个匹配字段（tool/command/path/domain）`)
    }
    return r
  })
}

// ---------- 匹配 ----------

/** 工具输入字段提取（与 index.ts summarizeInput 的按工具分发对齐，不另起一套） */
function extractField(toolName: string, input: unknown, field: 'command' | 'path' | 'domain'): string | null {
  if (!input || typeof input !== 'object') return null
  const obj = input as Record<string, unknown>
  switch (field) {
    case 'command':
      return typeof obj.command === 'string' ? obj.command : null
    case 'path':
      // claude Write/Edit/Read → file_path；codex Edit 重塑后也可能带 file_path 或 grantRoot
      return typeof obj.file_path === 'string' ? obj.file_path : null
    case 'domain': {
      if (typeof obj.url !== 'string') return null
      try {
        return new URL(obj.url).hostname
      } catch {
        return null
      }
    }
  }
}

/** 极简 glob（两端锚定，与 minimatch 惯例一致）：`**\/` 跨零或多路径段，`**` 任意，`*` 段内任意。
 *  大小写不敏感、`\` 归一为 `/`（Windows 路径）。想匹配任意位置的文件写 `**\/*.test.ts`。 */
export function globMatch(pattern: string, value: string): boolean {
  const norm = (s: string) => s.replace(/\\/g, '/')
  const p = norm(pattern)
  const v = norm(value)
  let re = ''
  for (let i = 0; i < p.length; i++) {
    const ch = p[i]!
    if (ch === '*') {
      if (p[i + 1] === '*') {
        if (p[i + 2] === '/') {
          re += '(?:[^/]+/)*' // **/ → 零或多段
          i += 2
        } else {
          re += '.*'
          i += 1
        }
      } else {
        re += '[^/]*'
      }
    } else {
      re += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&')
    }
  }
  return new RegExp(`^${re}$`, 'i').test(v)
}

/** 域名后缀匹配：*.example.com 匹配 a.b.example.com 与 example.com；裸域名只匹配自身与子域 */
export function domainMatch(pattern: string, hostname: string): boolean {
  const p = pattern.toLowerCase()
  const h = hostname.toLowerCase()
  if (p.startsWith('*.')) {
    const suffix = p.slice(1) // ".example.com"
    return h.endsWith(suffix) || h === p.slice(2)
  }
  return h === p || h.endsWith('.' + p)
}

function toolMatches(ruleTool: string, toolName: string): boolean {
  return ruleTool
    .split('|')
    .map((t) => t.trim())
    .some((t) => t === toolName)
}

/** 按序匹配，返回首条命中规则；无命中返回 null（走人工 ask）。 */
export function matchApprovalRule(
  rules: ApprovalRule[],
  toolName: string,
  input: unknown,
): RuleMatchResult | null {
  for (let i = 0; i < rules.length; i++) {
    const rule = rules[i]!
    const m = rule.match
    if (m.tool !== undefined && !toolMatches(m.tool, toolName)) continue
    if (m.command !== undefined) {
      const cmd = extractField(toolName, input, 'command')
      if (cmd === null || !new RegExp(m.command).test(cmd)) continue
    }
    if (m.path !== undefined) {
      const p = extractField(toolName, input, 'path')
      if (p === null || !globMatch(m.path, p)) continue
    }
    if (m.domain !== undefined) {
      const d = extractField(toolName, input, 'domain')
      if (d === null || !domainMatch(m.domain, d)) continue
    }
    return { rule, index: i }
  }
  return null
}

/** 规则裁决 → 统一决策形状（allow 带 updatedInput 原样透传，与审批卡人工允许同形） */
export function decisionOfRule(rule: ApprovalRule, input: unknown): ApprovalDecision {
  return rule.action === 'allow'
    ? { behavior: 'allow', updatedInput: input }
    : { behavior: 'deny', message: rule.note ? `规则拒绝：${rule.note}` : '已被审批规则自动拒绝' }
}
