#!/usr/bin/env node
/**
 * npm 包的 bin 入口。存在的唯一理由：npm 生态装的是 Node，而本项目跑在 Bun 上。
 *
 * 直接把 bin 指向 `#!/usr/bin/env bun` 的 .ts 时，没装 Bun 的机器上 npm shim 会抛
 * 「'"bun"' 不是内部或外部命令」——既不说缺什么也不说怎么装，用户只能放弃。
 * 目标用户多是 npm 装的 claude / codex CLI 过来的，没装 Bun 是常态而非例外。
 *
 * 已在 Bun 里跑时（bunx / bun 全局安装）直接 import，不套子进程——
 * 多一层包装进程会吞 Ctrl+C，绕过 server.stop(true) 的子进程树清理（见 AGENTS.md）。
 */
import { existsSync, readFileSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'

const isWin = process.platform === 'win32'

/** PATH 逐项查找 + Bun 官方安装位置兜底（装完没重开终端时 PATH 还没生效） */
function findBun() {
  const names = isWin ? ['bun.exe', 'bun.cmd', 'bun'] : ['bun']
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (!dir) continue
    for (const name of names) {
      const p = join(dir, name)
      if (existsSync(p)) return p
    }
  }
  const fallback = isWin ? join(homedir(), '.bun', 'bin', 'bun.exe') : join(homedir(), '.bun', 'bin', 'bun')
  return existsSync(fallback) ? fallback : null
}

function missingBunMessage() {
  // 首推 npm：能跑到这里说明 npm 一定可用，比让用户自己去挑官方安装脚本少一步判断
  const official = isWin
    ? 'powershell -c "irm bun.sh/install.ps1 | iex"'
    : 'curl -fsSL https://bun.sh/install | bash'
  return [
    '',
    'AnyPlane 需要 Bun 运行时（>= 1.4.0），当前没有找到。',
    '',
    '安装（任选其一）：',
    '  npm install -g bun',
    `  ${official}`,
    '',
    '装好后重新运行本命令即可。已装却仍报这个错，多半是终端 PATH 还没刷新——重开一个终端再试。',
    '',
    '说明：AnyPlane 服务端跑在 Bun 上（无框架，直接 Bun.serve）。这不影响你用 npm 装的',
    'claude / codex CLI——AnyPlane 以子进程方式驱动它们，两者各用各的运行时。',
    '',
  ].join('\n')
}

if (typeof globalThis.Bun !== 'undefined') {
  // 已在 Bun 运行时：直接交棒，行为与改造前逐字节一致（无子进程、无信号中转）
  await import('./anyplane.ts')
} else {
  const args = process.argv.slice(2)

  // 版本查询不需要 Bun：npx 探活很常见，不该因为缺 Bun 就问不出版本
  if (args[0] === 'version' || args[0] === '--version' || args[0] === '-v') {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
    console.log(`anyplane ${pkg.version}`)
    process.exit(0)
  }

  const bun = findBun()
  if (!bun) {
    process.stderr.write(missingBunMessage())
    process.exit(1)
  }

  const { spawn } = await import('node:child_process')
  const entry = fileURLToPath(new URL('./anyplane.ts', import.meta.url))
  const child = spawn(bun, [entry, ...args], { stdio: 'inherit', windowsHide: false })

  // Ctrl+C 由终端直接送达子进程（共享 stdio）。父进程按住信号不退，
  // 等子进程跑完自己的优雅关闭再跟随退出——抢先退出会让终端以为命令已经结束。
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(sig, () => {})
  }
  child.on('error', (err) => {
    process.stderr.write(`[anyplane] 无法启动 Bun（${bun}）：${err.message}\n`)
    process.exit(1)
  })
  child.on('exit', (code, signal) => {
    process.exit(code ?? (signal ? 1 : 0))
  })
}
