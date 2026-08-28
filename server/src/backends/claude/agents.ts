// `claude agents --json --all` 的 daemon 视图轮询（TTL 缓存 + 陈旧刷新）。
// 与 pid 文件（~/.claude/sessions/<pid>.json，discovery.readPidFiles）的关系：
// 交互式会话两者同源，**pid 文件优先**；daemon 的独有价值是 `kind:"background"` 的
// 后台 agent（`claude agents` spawn 的托管任务）——它们不写 pid 文件，
// "还在 daemon 手里跑着"这件事只有 agents --json 知道。
// 文档化脚本接口（对照 control.sock 逆向协议的版本锁风险，见 memory/ROADMAP 决策记录）。

import { resolveClaudeCommand } from './processManager'

export interface DaemonAgent {
  sessionId: string
  pid?: number
  cwd?: string
  /** interactive | background（缺省按 interactive 处理） */
  kind?: string
  name?: string
  /** interactive 的实时状态（busy/idle/…，官方新增状态直出） */
  status?: string
  /** background 的生命周期（running/done/error/…） */
  state?: string
  startedAt?: number
}

/** 后台 agent 是否还在 daemon 手里跑（其余终态都不是"活着") */
export function backgroundAlive(state?: string): boolean {
  if (!state) return false
  return !['done', 'error', 'failed', 'killed', 'stopped', 'cancelled'].includes(state)
}

/** 宽松解析 agents --json 输出：只取认识的字段，未知字段/未知 kind 一律跳过该条但不炸整体 */
export function parseAgentsJson(text: string): Map<string, DaemonAgent> {
  const map = new Map<string, DaemonAgent>()
  let arr: unknown
  try {
    arr = JSON.parse(text)
  } catch {
    return map
  }
  if (!Array.isArray(arr)) return map
  for (const raw of arr) {
    if (!raw || typeof raw !== 'object') continue
    const o = raw as Record<string, unknown>
    if (typeof o.sessionId !== 'string' || !o.sessionId) continue
    map.set(o.sessionId, {
      sessionId: o.sessionId,
      pid: typeof o.pid === 'number' ? o.pid : undefined,
      cwd: typeof o.cwd === 'string' ? o.cwd : undefined,
      kind: typeof o.kind === 'string' ? o.kind : undefined,
      name: typeof o.name === 'string' ? o.name : undefined,
      status: typeof o.status === 'string' ? o.status : undefined,
      state: typeof o.state === 'string' ? o.state : undefined,
      startedAt: typeof o.startedAt === 'number' ? o.startedAt : undefined,
    })
  }
  return map
}

const TTL_MS = 15_000
let cache: { at: number; map: Map<string, DaemonAgent> } | undefined
let inflight = false

/** 后台刷新：spawn `claude agents --json --all`，任何失败都静默降级（保持旧缓存） */
function refresh(): void {
  if (inflight) return
  inflight = true
  void (async () => {
    try {
      const { cmd, prefix } = resolveClaudeCommand()
      const proc = Bun.spawn([cmd, ...prefix, 'agents', '--json', '--all'], {
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'ignore',
      })
      const timeout = setTimeout(() => {
        try {
          proc.kill()
        } catch {}
      }, 10_000)
      const [text, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited])
      clearTimeout(timeout)
      if (code !== 0) return
      cache = { at: Date.now(), map: parseAgentsJson(text) }
    } catch {
      // 静默降级：保持旧缓存（daemon 未运行/CLI 缺席都走这里）
    } finally {
      inflight = false
    }
  })()
}

/**
 * 同步取 daemon 视图（listSessions 是同步热路径）：TTL 内直接命中；
 * 过期则返回旧数据并触发后台刷新（stale-while-revalidate），首轮冷启动为空表。
 */
export function daemonAgents(): Map<string, DaemonAgent> {
  const now = Date.now()
  if (cache && now - cache.at < TTL_MS) return cache.map
  refresh()
  return cache?.map ?? new Map()
}
