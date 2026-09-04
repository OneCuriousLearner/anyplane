// 端口残留接管：server(:7480) 与 Vite(:5173) 启动时解除"自己人"残留进程的占用。
// 安全红线：cmdline（已知入口）与 cwd（本仓库对应子目录）双条件都命中才算自己人，
// 任一不明一律拒绝并打印手动指引——宁可启动失败，绝不误杀外来进程。
// 平台：Linux(ss+/proc) 与 macOS(lsof+ps) 支持自动接管；Windows 首版仅提示手动命令
//（Bun socket 继承 bug 的历史雷区，自动杀不值当）。
// ANYPLANE_PORT_TAKEOVER=0 可整体关闭（回退为旧行为：端口被占直接报错）。

import { readFileSync, readlinkSync, realpathSync } from 'node:fs'
import { resolve } from 'node:path'

export interface PidDesc {
  /** 原始 cmdline（Linux /proc 的 \0 分隔未清洗，用 normCmd 后再匹配） */
  cmdline: string
  /** 进程工作目录；读不到为 null（→ 匹配一律判 false） */
  cwd: string | null
}

function realpathSafe(p: string): string {
  try {
    return realpathSync(p)
  } catch {
    return p
  }
}

const repoRoot = resolve(import.meta.dir, '../..')
const SERVER_DIR = realpathSafe(resolve(repoRoot, 'server'))
const WEB_DIR = realpathSafe(resolve(repoRoot, 'web'))

/** \0 分隔的 cmdline 清洗成空格分隔再匹配 */
function normCmd(cmdline: string): string {
  return cmdline.replace(/\0/g, ' ')
}

function sameDir(a: string | null, b: string): boolean {
  if (!a) return false
  return realpathSafe(a) === b
}

/** server 残留：cmdline 含 src/index.ts 且 cwd 是本仓库 server/ */
export function isOwnServerProcess(desc: PidDesc, serverDir: string = SERVER_DIR): boolean {
  return /[\/\s]src\/index\.ts(\s|$)/.test(normCmd(desc.cmdline)) && sameDir(desc.cwd, serverDir)
}

/** vite 残留：cmdline 含 vite 且 cwd 是本仓库 web/ */
export function isOwnViteProcess(desc: PidDesc, webDir: string = WEB_DIR): boolean {
  return /\bvite\b/.test(normCmd(desc.cmdline)) && sameDir(desc.cwd, webDir)
}

/** 从 `ss -tlnp` 文本里抽出监听指定 TCP 端口的 pid（:8080 不误伤 :80）。scripts/gateway-lib 也复用本函数 */
export function parseSsListenPids(ssOut: string, port: number): number[] {
  const pids = new Set<number>()
  const portRe = new RegExp(`(?:[:\\]])${port}(?:\\s|$)`)
  for (const line of ssOut.split('\n')) {
    if (!/\bLISTEN\b/.test(line) || !portRe.test(line)) continue
    for (const m of line.matchAll(/pid=(\d+)/g)) pids.add(Number(m[1]))
  }
  return [...pids]
}

/** 从 `lsof -t` 输出抽出 pid（每行一个数字） */
export function parseLsofPids(out: string): number[] {
  return [
    ...new Set(
      out
        .split('\n')
        .map((l) => Number(l.trim()))
        .filter((n) => Number.isInteger(n) && n > 0),
    ),
  ]
}

async function run(cmd: string[]): Promise<string | null> {
  try {
    const proc = Bun.spawn(cmd, { stdout: 'pipe', stderr: 'ignore', stdin: 'ignore' })
    const out = await new Response(proc.stdout).text()
    await proc.exited
    return out
  } catch {
    return null
  }
}

/** 监听指定 TCP 端口的 pid 列表；命令不可用或 Windows 返回 null（调用方按"拒绝接管"处理） */
export async function listListenPids(port: number): Promise<number[] | null> {
  if (process.platform === 'win32') return null
  if (process.platform === 'darwin') {
    const out = await run(['lsof', '-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'])
    return out === null ? null : parseLsofPids(out)
  }
  const out = await run(['ss', '-tlnp'])
  return out === null ? null : parseSsListenPids(out, port)
}

/** 进程 cmdline + cwd；进程已退出或无权读取返回 null */
export async function describePid(pid: number): Promise<PidDesc | null> {
  if (process.platform === 'win32') return null
  if (process.platform === 'darwin') {
    const cmdline = await run(['ps', '-p', String(pid), '-o', 'command='])
    if (cmdline === null || !cmdline.trim()) return null
    const lsof = await run(['lsof', '-a', '-p', String(pid), '-d', 'cwd', '-Fn'])
    const m = lsof?.match(/^n(.+)$/m)
    return { cmdline: cmdline.trim(), cwd: m?.[1] ?? null }
  }
  try {
    const cmdline = readFileSync(`/proc/${pid}/cmdline`, 'utf8')
    let cwd: string | null = null
    try {
      cwd = readlinkSync(`/proc/${pid}/cwd`)
    } catch {}
    return { cmdline, cwd }
  } catch {
    return null
  }
}

export type TakeoverResult = 'noop' | 'freed' | 'refused' | 'unsupported'

/** 在 deadlineMs 内轮询等待端口释放；释放返回 true */
async function waitForPortFree(port: number, deadlineMs: number): Promise<boolean> {
  const deadline = Date.now() + deadlineMs
  while (Date.now() < deadline) {
    if ((await listListenPids(port))?.length === 0) return true
    await Bun.sleep(50)
  }
  return false
}

/**
 * 解除 port 上"自己人"残留进程的占用。
 * - 无占用 / 已禁用 → noop
 * - 全部占用者通过 isOurs 校验 → SIGTERM，2s 内端口释放即 freed；未退 → SIGKILL 再等 1s
 * - 任一占用者校验不过（含读不到进程信息）→ 打印手动指引，refused，一个都不杀
 * - 平台不支持（Windows/无 ss/lsof）→ unsupported（同样不杀）
 */
export async function takeoverStaleListeners(
  port: number,
  isOurs: (desc: PidDesc) => boolean,
): Promise<TakeoverResult> {
  if (process.env.ANYPLANE_PORT_TAKEOVER === '0') return 'noop'
  const pids = await listListenPids(port)
  // 平台不支持时静默返回：dev.ts 是启动前预防性调用（端口可能根本没被占），不该产生噪音；
  // index.ts 只在 EADDRINUSE 后调用，走到原报错路径即可（Windows 指引已有）。
  if (pids === null) return 'unsupported'
  const holders = pids.filter((p) => p !== process.pid)
  if (!holders.length) return 'noop'

  const own: number[] = []
  const foreign: Array<{ pid: number; desc: PidDesc | null }> = []
  for (const pid of holders) {
    const desc = await describePid(pid)
    if (desc && isOurs(desc)) own.push(pid)
    else foreign.push({ pid, desc })
  }
  if (foreign.length) {
    for (const f of foreign) {
      const cmd = f.desc ? normCmd(f.desc.cmdline).trim() || '(unknown)' : '(无法读取进程信息)'
      console.error(`[port-takeover] :${port} 被 pid=${f.pid} 占用，不是本仓库进程：${cmd}`)
    }
    console.error('[port-takeover] 拒绝覆盖。确认后请手动结束该进程。')
    return 'refused'
  }

  for (const pid of own) {
    console.warn(`[port-takeover] :${port} 结束残留进程 pid=${pid}`)
    try {
      process.kill(pid, 'SIGTERM')
    } catch {}
  }
  if (await waitForPortFree(port, 2000)) return 'freed'
  for (const pid of own) {
    try {
      process.kill(pid, 'SIGKILL')
      console.warn(`[port-takeover] pid=${pid} 未退出，已 SIGKILL`)
    } catch {}
  }
  if (await waitForPortFree(port, 1000)) return 'freed'
  console.error(`[port-takeover] :${port} SIGKILL 后仍被占用，接管失败`)
  return 'refused'
}
