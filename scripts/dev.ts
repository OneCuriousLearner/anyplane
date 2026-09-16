// 纯 Bun 开发启动器。直接启动 server / Vite，避免 Windows 上
// `bun run --cwd ...` 的多层包装进程吞掉 Ctrl+C。
import { hasSupportedBunVersion } from '../server/src/util'
import { isOwnServerProcess, isOwnViteProcess, takeoverStaleListeners } from '../server/src/portTakeover'

export {}

const bun = process.execPath

if (!hasSupportedBunVersion() && process.env.ANYPLANE_ALLOW_UNSAFE_BUN !== '1') {
  console.error(`[dev] 需要 Bun >= 1.4.0（当前 ${Bun.version}；1.3.x 在 Windows 有监听 socket 继承 bug，门槛已统一收到全平台）。`)
  console.error('[dev] Run `bun upgrade`, restart the terminal, then run `bun run dev` again.')
  process.exit(1)
}

// 端口残留接管：只杀"自己人"（cmdline+cwd 双校验，见 portTakeover.ts），外来占用直接退出，
// 避免旧版"server 悄悄起不来 / Vite 静默换端口而 gateway 还代理旧实例"的半截环境。
//（server 自身在 bind 失败时也会接管重试，这里是提前给出清晰反馈；Windows 不支持探测时静默跳过）
const serverPort = Number(process.env.ANYPLANE_PORT) || 7480
const [tServer, tWeb] = await Promise.all([
  takeoverStaleListeners(serverPort, isOwnServerProcess),
  takeoverStaleListeners(5173, isOwnViteProcess),
])
if (tServer === 'refused' || tWeb === 'refused') {
  console.error('[dev] 端口被外来进程占用，未启动。')
  process.exit(1)
}

const children = [
  {
    name: 'server',
    // 不使用 bun --watch：Windows watcher 会在应用的异步 SIGINT 清理完成前杀掉实际 server。
    proc: Bun.spawn([bun, 'src/index.ts'], {
      cwd: 'server',
      stdout: 'inherit',
      stderr: 'inherit',
      stdin: 'inherit',
    }),
  },
  {
    name: 'web',
    proc: Bun.spawn([bun, 'x', '--bun', 'vite'], {
      cwd: 'web',
      stdout: 'inherit',
      stderr: 'inherit',
      stdin: 'inherit',
    }),
  },
]

console.log(
  `[dev] launcher pid=${process.pid} bun=${Bun.version} children=${children.map(({ name, proc }) => `${name}:${proc.pid}`).join(',')}`,
)

const delay = (ms: number) => new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), ms))
// Bun 对信号杀死的进程 exitCode 恒为 null（退出码只记录正常 exit），
// 必须同时看 signalCode，否则已死的兄弟进程会被误判存活、重复收 SIGTERM。
const isAlive = (proc: (typeof children)[number]['proc']) => proc.exitCode === null && proc.signalCode === null
let stopping = false
let exitCode = 0

async function stop(reason: string, opts?: { killRemaining?: boolean; code?: number }): Promise<void> {
  if (stopping) {
    console.warn(`[dev] shutdown already in progress; repeated=${reason}`)
    return
  }
  stopping = true
  if (opts?.code != null) exitCode = Math.max(exitCode, opts.code)
  const started = performance.now()
  console.log(`[dev] shutdown begin reason=${reason}; waiting up to 5s for graceful child exit`)

  // 子进程被单独 SIGTERM（典型：另一份 bun run start / bun run dev 的 port-takeover
  // 只杀了 :7480）时，控制台不会把信号广播给 Vite，必须主动收掉，否则 Vite 继续
  // 把 /api 与 /ws 打到空端口，刷 ECONNREFUSED。
  // Ctrl+C 仍不立刻 kill：Windows 会把 SIGINT 同时发给同一控制台里的 server 和 Vite，
  // 立刻 proc.kill() 会在 server.stop() 完成前硬杀，并触发 Bun <=1.3.14 的 socket 继承问题。
  if (opts?.killRemaining) {
    const alive = children.filter(({ proc }) => isAlive(proc))
    for (const { name, proc } of alive) {
      console.warn(`[dev] stopping sibling name=${name} pid=${proc.pid}`)
      try {
        proc.kill('SIGTERM')
      } catch {}
    }
  }

  const graceful = Promise.all(exits)
  const result = await Promise.race([graceful, delay(5_000)])

  if (result === 'timeout') {
    const alive = children.filter(({ proc }) => isAlive(proc))
    console.error(`[dev] graceful timeout; force-kill=${alive.map(({ name, proc }) => `${name}:${proc.pid}`).join(',') || 'none'}`)
    for (const { proc } of alive) {
      try {
        proc.kill()
      } catch {}
    }
    await Promise.race([graceful, delay(1_500)])
  }

  console.log(`[dev] shutdown complete elapsedMs=${Math.round(performance.now() - started)}`)
  process.exit(exitCode)
}

const exits = children.map(async ({ name, proc }) => {
  const code = await proc.exited
  console.log(`[dev] child-exit name=${name} pid=${proc.pid} code=${code}`)
  if (!stopping) {
    console.error(`[dev] child stopped unexpectedly name=${name} pid=${proc.pid} code=${code}`)
    void stop(`child-exit:${name}`, { killRemaining: true, code: code === 0 ? 1 : code })
  }
  return code
})

process.on('SIGINT', () => void stop('SIGINT'))
process.on('SIGTERM', () => void stop('SIGTERM'))

const codes = await Promise.all(exits)
if (!stopping) {
  const failed = codes.find((code) => code !== 0)
  console.error(`[dev] child stopped unexpectedly codes=${codes.join(',')}`)
  process.exit(failed ?? 0)
}
