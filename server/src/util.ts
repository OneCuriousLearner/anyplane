// 服务端通用小助手：错误文案归一化、NDJSON 行泵、平台版本闸。

import { chmodSync, mkdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** anyplane 运行数据根目录（~/.anyplane/，约定见 AGENTS.md）；权限收紧由 ensurePrivateDir 完成 */
export function ccDataDir(): string {
  return ensurePrivateDir(join(homedir(), '.anyplane'))
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

/**
 * ~/.anyplane 下的私有数据目录：递归创建并把 .anyplane 根到目标的每层收紧为 700
 *（vapid 私钥、推送订阅注册表、接力血缘简报、reasoning 侧车、网关 TLS 私钥都落在这里）。
 * mkdir 的 mode 只对新建目录生效，旧版本已建出的 755 目录靠 chmod 逐段兜底；
 * chmod 在 Windows 上语义有限，失败静默（NTFS 另有权限模型）。
 */
export function ensurePrivateDir(dir: string): string {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const parts = dir.split(/[\\/]/)
  const base = parts.lastIndexOf('.anyplane')
  const targets: string[] = []
  if (base >= 0) {
    for (let i = base; i < parts.length; i++) targets.push(parts.slice(0, i + 1).join('/'))
  } else {
    targets.push(dir)
  }
  for (const p of targets) {
    try {
      chmodSync(p, 0o700)
    } catch {}
  }
  return dir
}

/** Bun <=1.3.14 在 Windows 存在监听 socket 被子进程继承的 bug（oven-sh/bun#36936）；
 *  server 与 scripts/dev.ts 启动时都以本判定拒绝启动（ANYPLANE_ALLOW_UNSAFE_BUN=1 可跳过） */
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
