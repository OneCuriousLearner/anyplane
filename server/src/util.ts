// 服务端通用小助手：错误文案归一化、NDJSON 行泵、平台版本闸。

import { mkdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** cc-remote 运行数据根目录（~/.cc-remote/，约定见 AGENTS.md）；recursive mkdir 幂等 */
export function ccDataDir(): string {
  const dir = join(homedir(), '.cc-remote')
  mkdirSync(dir, { recursive: true })
  return dir
}

/** 读 JSON 文件；不存在或解析失败返回 undefined（调用方决定回退值） */
export function readJsonFile<T>(path: string): T | undefined {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T
  } catch {
    return undefined
  }
}

/** unknown 错误 → 单行文案（broadcast/json 响应用；console.* 请直接传原对象保留堆栈） */
export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/** Bun <=1.3.14 在 Windows 存在监听 socket 被子进程继承的 bug（oven-sh/bun#36936）；
 *  server 与 scripts/dev.ts 启动时都以本判定拒绝启动（CC_REMOTE_ALLOW_UNSAFE_BUN=1 可跳过） */
export function hasWindowsSocketFix(): boolean {
  const [major = 0, minor = 0, patch = 0] = Bun.version.split(/[.-]/).map(Number)
  return (
    process.platform !== 'win32' ||
    major > 1 ||
    minor > 3 ||
    (minor === 3 && patch >= 15) ||
    Bun.version.includes('canary')
  )
}

/**
 * 逐行泵取 NDJSON 流（TextDecoder 增量解码 + \n 切分 + 末尾余量冲刷）。
 * claude 子进程 stdout、codex app-server stdout、接力简报一次性进程共用。
 * 读取异常经 onError 上报（缺省打日志），不会抛出打断调用方。
 */
export async function pumpLines(
  stream: ReadableStream<Uint8Array>,
  onLine: (line: string) => void,
  onError?: (e: unknown) => void,
): Promise<void> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
      let idx: number
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim()
        buf = buf.slice(idx + 1)
        if (line) onLine(line)
      }
    }
    if (buf.trim()) onLine(buf.trim())
  } catch (e) {
    if (onError) onError(e)
    else console.error('[pumpLines] 读取异常:', e)
  }
}
