#!/usr/bin/env bun
/**
 * 公网配方一键脚本：封装 docs/public-access.md 三套配方的最小启动命令。
 * 只做隧道创建与反代，不碰账号体系（tailscale up / cloudflared login / DDNS 均由用户自理）。
 *
 * 安全红线（与 docs/public-access.md 一致）：未配置 authToken 一律拒绝执行——
 * 服务端绑回环时「非回环强制 token」的启动检查保护不到隧道层暴露，token 全靠自觉，
 * 本脚本把这份自觉变成硬门槛，而不是可跳过的警告。
 *
 * 本文件只是薄包装：全部逻辑在 public-access-lib.ts 的 run()（副作用经 RunDeps 注入，
 * 测试在进程内覆盖，不经由此文件）。用法见 USAGE 或 `bun run public-access --help`。
 */

import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { loadAnyplaneConfigFile } from '../server/src/config'
import { ensurePrivateDir, errorMessage } from '../server/src/util'
import { run, type RunDeps } from './public-access-lib'

const deps: RunDeps = {
  loadConfig: loadAnyplaneConfigFile,
  env: process.env,
  platform: process.platform,
  which: (bin) => Bun.which(bin),
  exists: existsSync,
  serverUp: async (port) => {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(3000) })
      return r.status < 500
    } catch {
      return false
    }
  },
  // 无凭据探测：fetch 不带 Origin → 无 token 模式 originAllowed 缺失放行、返回 200；
  // token 模式 isAuthorized 一票否决返回 401。redirect manual 防尾随跳转到登录页误读为 200。
  apiStatus: async (port) => {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/sessions`, {
        signal: AbortSignal.timeout(3000),
        redirect: 'manual',
      })
      return r.status
    } catch {
      return null
    }
  },
  stateDir: () => ensurePrivateDir(join(homedir(), '.anyplane', 'caddy')),
  writeFile: (path, content) => Bun.write(path, content),
  foreground: async (cmd) => {
    // 前台托管：Ctrl+C 自然终结整条进程组（不包 cmd 壳，信号语义与直接运行一致）
    const proc = Bun.spawn(cmd, { stdout: 'inherit', stderr: 'inherit', stdin: 'inherit' })
    return proc.exited
  },
  spawnSync: (cmd, echo) => {
    const r = Bun.spawnSync(cmd, {
      stdout: echo ? 'inherit' : 'pipe',
      stderr: 'inherit',
      stdin: 'ignore',
    })
    return { exitCode: r.exitCode, stdout: echo ? '' : (r.stdout?.toString() ?? '') }
  },
  out: (msg) => console.log(msg),
  err: (msg) => console.error(msg),
}

try {
  process.exit(await run(process.argv.slice(2), deps))
} catch (e) {
  // 顶层兜底：配置解析错误（坏 approvalRules 刻意 fail-fast）、写盘失败等，
  // 统一成一行可读报错，而不是 unhandled rejection 堆栈
  const msg = errorMessage(e)
  console.error(`[public-access] ${msg}`)
  process.exit(1)
}
