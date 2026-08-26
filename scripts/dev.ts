// 纯 Bun 开发启动器。直接启动 server / Vite，避免 Windows 上
// `bun run --cwd ...` 的多层包装进程吞掉 Ctrl+C。
import { hasWindowsSocketFix } from '../server/src/util'

export {}

const bun = process.execPath

if (!hasWindowsSocketFix() && process.env.CC_REMOTE_ALLOW_UNSAFE_BUN !== '1') {
  console.error(
    `[dev] Bun ${Bun.version} on Windows has a known inherited-listener bug (oven-sh/bun#36936).`,
  )
  console.error('[dev] Run `bun upgrade --canary`, restart the terminal, then run `bun run dev` again.')
  console.error('[dev] Refusing to start because another forced exit can create an unrecoverable stale port.')
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

const exits = children.map(async ({ name, proc }) => {
  const code = await proc.exited
  console.log(`[dev] child-exit name=${name} pid=${proc.pid} code=${code}`)
  return code
})

const delay = (ms: number) => new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), ms))
let stopping = false

async function stop(reason: string): Promise<void> {
  if (stopping) {
    console.warn(`[dev] shutdown already in progress; repeated=${reason}`)
    return
  }
  stopping = true
  const started = performance.now()
  console.log(`[dev] shutdown begin reason=${reason}; waiting up to 5s for graceful child exit`)

  // Ctrl+C 是控制台事件，Windows 会同时发给同一控制台中的 server 和 Vite。
  // 不要立刻 proc.kill()/process.exit()：那会在 server.stop() 完成前硬杀 server，
  // 并触发 Bun <=1.3.14 的监听 socket 继承问题。
  const graceful = Promise.all(exits)
  const result = await Promise.race([graceful, delay(5_000)])

  if (result === 'timeout') {
    const alive = children.filter(({ proc }) => proc.exitCode === null)
    console.error(`[dev] graceful timeout; force-kill=${alive.map(({ name, proc }) => `${name}:${proc.pid}`).join(',') || 'none'}`)
    for (const { proc } of alive) {
      try {
        proc.kill()
      } catch {}
    }
    await Promise.race([graceful, delay(1_500)])
  }

  console.log(`[dev] shutdown complete elapsedMs=${Math.round(performance.now() - started)}`)
  process.exit(0)
}

process.on('SIGINT', () => void stop('SIGINT'))
process.on('SIGTERM', () => void stop('SIGTERM'))

const codes = await Promise.all(exits)
if (!stopping) {
  const failed = codes.find((code) => code !== 0)
  console.error(`[dev] child stopped unexpectedly codes=${codes.join(',')}`)
  process.exit(failed ?? 0)
}
