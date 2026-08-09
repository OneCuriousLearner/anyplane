// 并行拉起 server + web；Windows 上 `a & b` 不会后台执行，会卡死在 server。
// 端口固定由 server 配置 / CC_REMOTE_PORT 决定，此处不做自动切换。

const procs = [
  Bun.spawn(['bun', 'run', '--cwd', 'server', 'dev'], {
    stdout: 'inherit',
    stderr: 'inherit',
    stdin: 'inherit',
  }),
  Bun.spawn(['bun', 'run', '--cwd', 'web', 'dev'], {
    stdout: 'inherit',
    stderr: 'inherit',
    stdin: 'inherit',
  }),
]

const stop = () => {
  for (const p of procs) {
    try {
      p.kill()
    } catch {}
  }
  process.exit(0)
}
process.on('SIGINT', stop)
process.on('SIGTERM', stop)

const codes = await Promise.all(procs.map((p) => p.exited))
process.exit(codes.find((c) => c !== 0) ?? 0)
