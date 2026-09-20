// 启动后打开默认浏览器。默认只在交互 TTY 下动手：
// Docker / CI / 管道 / 服务管理器里弹浏览器既打不开也扰民。
// --no-open 与 ANYPLANE_NO_OPEN=1 显式关闭。

import { existsSync } from 'node:fs'

export function shouldOpenBrowser(input: {
  argv?: readonly string[]
  env?: NodeJS.ProcessEnv
  isTTY?: boolean
  inDocker?: boolean
} = {}): boolean {
  const argv = input.argv ?? process.argv
  const env = input.env ?? process.env
  const isTTY = input.isTTY ?? Boolean(process.stdout.isTTY)
  const inDocker = input.inDocker ?? existsSync('/.dockerenv')
  if (!isTTY) return false
  if (inDocker) return false
  if (argv.includes('--no-open')) return false
  if (env.ANYPLANE_NO_OPEN === '1' || env.ANYPLANE_OPEN === '0') return false
  if (env.CI === 'true' || env.CI === '1') return false
  return true
}

/** 各平台「用默认浏览器打开 URL」的 argv。Windows 的空标题是 start 的坑：第一个引号参数会被当成窗口标题。 */
export function browserOpenArgs(url: string, platform = process.platform): string[] {
  if (platform === 'win32') return ['cmd', '/c', 'start', '""', '/b', url]
  if (platform === 'darwin') return ['open', url]
  return ['xdg-open', url]
}

export function openDefaultBrowser(url: string): { opened: boolean; error?: string } {
  try {
    const proc = Bun.spawn(browserOpenArgs(url), { stdout: 'ignore', stderr: 'ignore', stdin: 'ignore' })
    proc.unref()
    return { opened: true }
  } catch (e) {
    return { opened: false, error: e instanceof Error ? e.message : String(e) }
  }
}
