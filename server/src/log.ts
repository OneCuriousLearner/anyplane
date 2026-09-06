// 结构化日志：薄封装，不引第三方 logger。
//
// 为什么需要：AnyPlane 跑在用户自己机器上、驱动你看不到的子进程、通过你不掌握的网络。
// 用户报「会话突然没反应」时，此前只有一堆散落 console.log，无会话关联、无级别、无法要 log 包。
//
// 默认输出与旧格式保持一致（`[anyplane] xxx` / `[session key] xxx`），肉眼可读、不惊扰现有用户；
// 设 ANYPLANE_LOG_FORMAT=json 时逐行输出 JSON，便于让用户 grep/上传。
// ANYPLANE_LOG_LEVEL=debug|info|warn|error 控制阈值（默认 info）。
//
// 分级口径：
// - debug：预期内的失败与噪声（向已关闭 WS 发送、探测性 RPC 失败）——默认不打，但可开
// - info ：状态变化（spawn/exit/回收/重键）
// - warn ：降级但仍可用（推送投递失败、旧版 app-server 缺能力）
// - error：功能受损（spawn 失败、协议解析失败）

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 }

function envLevel(): LogLevel {
  const v = (process.env.ANYPLANE_LOG_LEVEL ?? '').toLowerCase()
  return v === 'debug' || v === 'info' || v === 'warn' || v === 'error' ? v : 'info'
}

let threshold = ORDER[envLevel()]
let asJson = process.env.ANYPLANE_LOG_FORMAT === 'json'

/** 测试钩子：运行期改级别/格式 */
export function configureLog(opts: { level?: LogLevel; json?: boolean }): void {
  if (opts.level) threshold = ORDER[opts.level]
  if (opts.json !== undefined) asJson = opts.json
}

/** 附加字段：会话 key、pid、错误码等，JSON 模式下平铺，文本模式下 k=v 追加 */
export type Fields = Record<string, unknown>

function fmtFields(f: Fields): string {
  const parts: string[] = []
  for (const [k, v] of Object.entries(f)) {
    if (v === undefined) continue
    // 字符串裸出更好读；含空格/为空时才加引号，否则 k=v 边界会糊掉
    const s = typeof v === 'string' ? (v === '' || /\s/.test(v) ? JSON.stringify(v) : v) : JSON.stringify(v)
    parts.push(`${k}=${s}`)
  }
  return parts.length ? ` ${parts.join(' ')}` : ''
}

function emit(level: LogLevel, scope: string, msg: string, fields?: Fields): void {
  if (ORDER[level] < threshold) return
  const sink = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log
  if (asJson) {
    sink(JSON.stringify({ ts: new Date().toISOString(), level, scope, msg, ...(fields ?? {}) }))
    return
  }
  sink(`[${scope}] ${msg}${fields ? fmtFields(fields) : ''}`)
}

/** 绑定 scope 的 logger。scope 即旧代码方括号里的东西（'anyplane' / `session ${key}` / `codex ${key}`） */
export interface Logger {
  debug(msg: string, fields?: Fields): void
  info(msg: string, fields?: Fields): void
  warn(msg: string, fields?: Fields): void
  error(msg: string, fields?: Fields): void
  /** 派生子 scope，如 logger('codex').child(key) → `codex x|abc` */
  child(suffix: string): Logger
}

/**
 * console 兼容入口：签名与 console.log/warn/error 一致（变参、任意类型），
 * 并把消息里已有的 `[scope] ` 前缀提取为结构化 scope。
 *
 * 存在的理由：仓库里 80+ 处调用早已是 `console.log(\`[session ${key}] xxx\`)` 形态，
 * 前缀即 scope。有了它，迁移是纯文本替换（console.X → log.X），不必逐处重写消息，
 * 却立刻获得级别开关、JSON 模式与统一 sink。新代码优先用 logger(scope) 的结构化 API。
 */
function consoleStyle(level: LogLevel, args: unknown[]): void {
  if (ORDER[level] < threshold) return
  const first = args[0]
  let scope = 'anyplane'
  let head = typeof first === 'string' ? first : String(first ?? '')
  const m = /^\[([^\]]+)\]\s*/.exec(head)
  if (m) {
    scope = m[1]
    head = head.slice(m[0].length)
  }
  const rest = args.slice(1).map((a) => {
    if (typeof a === 'string') return a
    if (a instanceof Error) return a.message
    try {
      return JSON.stringify(a)
    } catch {
      return String(a)
    }
  })
  emit(level, scope, [head, ...rest].filter(Boolean).join(' '))
}

export const log = {
  debug: (...a: unknown[]) => consoleStyle('debug', a),
  info: (...a: unknown[]) => consoleStyle('info', a),
  warn: (...a: unknown[]) => consoleStyle('warn', a),
  error: (...a: unknown[]) => consoleStyle('error', a),
}

export function logger(scope: string): Logger {
  return {
    debug: (m, f) => emit('debug', scope, m, f),
    info: (m, f) => emit('info', scope, m, f),
    warn: (m, f) => emit('warn', scope, m, f),
    error: (m, f) => emit('error', scope, m, f),
    child: (suffix) => logger(`${scope} ${suffix}`),
  }
}

/** 错误对象 → 可记录字段（保留 message 与 code，堆栈仅 debug 级需要时自取） */
export function errFields(e: unknown): Fields {
  if (e instanceof Error) {
    const code = (e as NodeJS.ErrnoException).code
    return code ? { error: e.message, code } : { error: e.message }
  }
  return { error: String(e) }
}
