#!/usr/bin/env bun
/**
 * 公网配方一键脚本：封装 docs/public-access.md 三套配方的最小启动命令。
 * 只做隧道创建与反代，不碰账号体系（tailscale up / cloudflared login / DDNS 均由用户自理）。
 *
 * 安全红线（与 docs/public-access.md 一致）：未配置 authToken 一律拒绝执行——
 * 服务端绑回环时「非回环强制 token」的启动检查保护不到隧道层暴露，token 全靠自觉，
 * 本脚本把这份自觉变成硬门槛，而不是可跳过的警告。
 *
 * 用法见 public-access-lib.ts 的 USAGE，或 `bun run public-access`（无参数时打印）。
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { loadAnyplaneConfigFile } from '../server/src/config'
import { ensurePrivateDir } from '../server/src/util'
import { nextStepsHint, parseArgs, renderCaddyfile, resolvePort, resolveToken, USAGE } from './public-access-lib'

function fail(msg: string): never {
  console.error(`[public-access] ${msg}`)
  process.exit(1)
}

function whichOrFail(bin: string, installHint: string): string {
  const hit = Bun.which(bin)
  if (!hit) fail(`未找到 ${bin}。${installHint}`)
  return hit
}

/** 目标服务可达性预检：隧道起了才发现本地服务没跑是最常见的白忙一场 */
async function assertLocalServerUp(port: number): Promise<void> {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(3000) })
    if (r.status >= 500) throw new Error(`HTTP ${r.status}`)
  } catch {
    fail(`127.0.0.1:${port} 无响应——AnyPlane 服务端未在运行。请先启动（bunx anyplane / bun run start）。`)
  }
}

/** 前台托管子进程：Ctrl+C 自然终结整条进程组（不包 cmd 壳，信号语义与直接运行一致） */
async function runForeground(cmd: string[]): Promise<never> {
  const proc = Bun.spawn(cmd, { stdout: 'inherit', stderr: 'inherit', stdin: 'inherit' })
  const code = await proc.exited
  process.exit(code)
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2)
  if (argv.length === 0 || argv[0] === 'help' || argv[0] === '--help' || argv[0] === '-h') {
    console.log(USAGE)
    process.exit(argv.length === 0 ? 1 : 0)
  }

  let args
  try {
    args = parseArgs(argv)
  } catch (e) {
    fail(e instanceof Error ? e.message : String(e))
  }

  const configFile = loadAnyplaneConfigFile()
  if (!resolveToken(process.env, configFile)) {
    fail(
      '拒绝执行：未配置 authToken。公网暴露时 token 是唯一防线（隧道/反代层在服务端启动检查之外）。\n' +
        '请在 anyplane.config.json 设置 "authToken"（≥32 随机字符）或 ANYPLANE_TOKEN 环境变量后重试。',
    )
  }
  const port = resolvePort(args.port, process.env, configFile)
  await assertLocalServerUp(port)

  switch (args.recipe) {
    case 'funnel': {
      const tailscale = whichOrFail('tailscale', '安装见 https://tailscale.com/download')
      // POSIX 无 TUN 的云容器/沙箱整套不可用，直接 fail 指到方案二（Windows 无此概念）
      if (process.platform !== 'win32' && !existsSync('/dev/net/tun')) {
        fail('无 /dev/net/tun：无特权容器/沙箱跑不了 Tailscale，请改用 cf-quick。')
      }
      console.log(`[public-access] tailscale funnel --bg ${port}`)
      const r = Bun.spawnSync([tailscale, 'funnel', '--bg', String(port)], {
        stdout: 'inherit',
        stderr: 'inherit',
      })
      if (r.exitCode !== 0) fail(`tailscale funnel 退出码 ${r.exitCode}（ACL 未开 funnel 或 tailnet 未 up？）`)
      // funnel 地址 = 机器名.tailnet 名.ts.net，从 status 解析（失败不致命，用户可自查）
      const st = Bun.spawnSync([tailscale, 'status', '--json'], { stdout: 'pipe', stderr: 'pipe' })
      let url = 'https://<机器名>.<tailnet名>.ts.net'
      try {
        const j = JSON.parse(st.stdout.toString()) as { Self?: { DNSName?: string } }
        if (j.Self?.DNSName) url = `https://${j.Self.DNSName.replace(/\.$/, '')}`
      } catch {}
      console.log(nextStepsHint(url))
      console.log('撤销: tailscale funnel --bg ' + port + ' off')
      break
    }
    case 'cf-quick': {
      const cloudflared = whichOrFail(
        'cloudflared',
        '安装见 https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/',
      )
      console.log(`[public-access] cloudflared tunnel --url http://localhost:${port}`)
      console.log('[public-access] 启动后从输出里复制 https://<随机>.trycloudflare.com（Ctrl+C 停止并释放）')
      // 前台托管：URL 由 cloudflared 自己打印，比解析输出再打印一遍更不易漂移
      await runForeground([cloudflared, 'tunnel', '--url', `http://localhost:${port}`])
      break
    }
    case 'caddy': {
      const caddy = whichOrFail('caddy', '安装见 https://caddyserver.com/docs/install')
      const dir = ensurePrivateDir(join(homedir(), '.anyplane', 'caddy'))
      const file = join(dir, 'Caddyfile')
      await Bun.write(file, renderCaddyfile(args.domain!, port, args.httpsPort))
      console.log(`[public-access] Caddyfile 已写入 ${file}`)
      console.log(`[public-access] caddy run（前台；Ctrl+C 停止）。入站 :${args.httpsPort} 需在路由器/防火墙放行`)
      console.log(nextStepsHint(`https://${args.domain}:${args.httpsPort}`))
      await runForeground([caddy, 'run', '--config', file])
      break
    }
  }
  process.exit(0)
}

await main()
