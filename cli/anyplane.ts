#!/usr/bin/env bun
/**
 * anyplane CLI 入口（npm 包的 bin，要求 Bun 运行时）。
 * 包内保持仓库相对结构（cli/、server/src/、web/dist/、scripts/），
 * server 以 import.meta.dir 解析 ../../web/dist，全局安装布局下依然成立。
 */
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'

const pkg = (await Bun.file(new URL('../package.json', import.meta.url)).json()) as {
  version: string
}

const HELP = `AnyPlane — self-hosted control plane for your local coding agents (Claude Code, Codex)

Usage:
  anyplane [start]     启动服务端（默认 :7480，托管 API + WebSocket + 前端）
  anyplane gateway     启动 80/443 网关（按 ?mode=dev|prod 反代，需配置）
  anyplane version     打印版本
  anyplane help        本帮助

Config:
  ./anyplane.config.json → ~/.anyplane/config.json → 环境变量
  ANYPLANE_PORT / ANYPLANE_HOST / ANYPLANE_TOKEN / CLAUDE_CONFIG_DIR

Docs: https://github.com/OneCuriousLearner/anyplane
`

/** 后端 CLI 探测（仅用于缺失时的提示，不阻断启动；Windows 需考虑 .cmd/.exe/.bat） */
function whichAny(names: string[]): string | null {
  for (const n of names) {
    const hit =
      Bun.which(n) ??
      (process.platform === 'win32'
        ? (Bun.which(`${n}.cmd`) ?? Bun.which(`${n}.exe`) ?? Bun.which(`${n}.bat`))
        : null)
    if (hit) return hit
  }
  return null
}

const cmd = process.argv[2] ?? 'start'

switch (cmd) {
  case 'start': {
    if (!existsSync(resolve(import.meta.dir, '../web/dist/index.html'))) {
      console.error('[anyplane] 缺少 web/dist（前端未构建）。源码运行请先执行 bun install && bun run build。')
      process.exit(1)
    }
    if (!whichAny(['claude']) && !whichAny(['codex'])) {
      console.warn('[anyplane] 未在 PATH 找到 claude 或 codex CLI——请先安装并登录至少一个后端再使用。')
    }
    await import('../server/src/index.ts')
    break
  }
  case 'gateway':
    await import('../scripts/gateway.ts')
    break
  case 'version':
  case '--version':
  case '-v':
    console.log(`anyplane ${pkg.version}`)
    break
  case 'help':
  case '--help':
  case '-h':
    process.stdout.write(HELP)
    break
  default:
    console.error(`[anyplane] 未知命令: ${cmd}\n`)
    process.stdout.write(HELP)
    process.exit(1)
}
