// bunx / npx / npm -g 都会缓存旧包。启动后对照 npm latest，落后就告诉用户怎么刷新。
// 不阻塞启动：调用方 fire-and-forget。网络失败静默。CI / ANYPLANE_NO_UPDATE_CHECK=1 跳过。

import { join } from 'node:path'
import { log } from './log'
import { ccDataDir, readJsonFile, writeJsonFile } from './util'

const REGISTRY_LATEST = 'https://registry.npmjs.org/anyplane/latest'
const FETCH_MS = 1500
const CHECK_EVERY_MS = 6 * 60 * 60 * 1000

export interface UpdateCheckState {
  checkedAt: number
  latest: string
}

export function parseSemver(v: string): [number, number, number] | null {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(v.trim())
  if (!m) return null
  return [Number(m[1]), Number(m[2]), Number(m[3])]
}

/** latest 是否严格新于 current。对不上 x.y.z 的串不当更新。 */
export function isNewerRelease(latest: string, current: string): boolean {
  const a = parseSemver(latest)
  const b = parseSemver(current)
  if (!a || !b) return false
  if (a[0] !== b[0]) return a[0] > b[0]
  if (a[1] !== b[1]) return a[1] > b[1]
  return a[2] > b[2]
}

export function updateHint(current: string, latest: string): string {
  return (
    `[anyplane] 当前 ${current}，npm latest 已是 ${latest}。bunx/npx 会缓存旧包，刷新：\n` +
    `        bunx anyplane@latest`
  )
}

export function shouldSkipUpdateCheck(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.ANYPLANE_NO_UPDATE_CHECK === '1' || env.CI === 'true' || env.CI === '1'
}

export function statePath(): string {
  return join(ccDataDir(), 'update-check.json')
}

async function fetchNpmLatest(timeoutMs = FETCH_MS): Promise<string | null> {
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), timeoutMs)
  try {
    const res = await fetch(REGISTRY_LATEST, { signal: ac.signal })
    if (!res.ok) return null
    const body = (await res.json()) as { version?: unknown }
    return typeof body.version === 'string' && parseSemver(body.version) ? body.version : null
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

export async function checkForNpmUpdate(
  current: string,
  deps: {
    now?: number
    env?: NodeJS.ProcessEnv
    fetchLatest?: () => Promise<string | null>
    loadState?: () => UpdateCheckState | undefined
    saveState?: (s: UpdateCheckState) => void
    warn?: (msg: string) => void
  } = {},
): Promise<void> {
  const env = deps.env ?? process.env
  if (shouldSkipUpdateCheck(env)) return
  const now = deps.now ?? Date.now()
  const warn = deps.warn ?? ((msg) => log.warn(msg))
  const load = deps.loadState ?? (() => readJsonFile<UpdateCheckState>(statePath()))
  const save =
    deps.saveState ??
    ((s: UpdateCheckState) => {
      try {
        writeJsonFile(statePath(), s)
      } catch {
        /* 状态写失败不影响启动 */
      }
    })
  const fetchLatest = deps.fetchLatest ?? fetchNpmLatest

  const cached = load()
  if (cached?.latest && isNewerRelease(cached.latest, current)) {
    warn(updateHint(current, cached.latest))
  }
  if (cached && now - cached.checkedAt < CHECK_EVERY_MS) return

  const latest = await fetchLatest()
  if (!latest) return
  save({ checkedAt: now, latest })
  if (isNewerRelease(latest, current) && latest !== cached?.latest) {
    warn(updateHint(current, latest))
  }
}
