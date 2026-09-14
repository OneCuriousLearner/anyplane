// 双后端登录状态探测：会话列表页的「该去登录哪个」指引数据源。
// Claude 走官方 `claude auth status --json`（轻量子命令，不起会话）；
// Codex 走 app-server `account/read` RPC（协议正本，覆盖自定义 provider 场景）。
// 两侧探测都有成本（spawn 子命令 / 冷启动 app-server），模块级 TTL 缓存 + single-flight。

import { childEnv } from '../util'
import { resolveClaudeCommand } from './claude/processManager'
import { codexRuntime } from './codex/runtime'

/** 宏观登录态：列表页按此渲染徽标与指引 */
export type BackendLoginState =
  | 'subscription' // claude.ai 订阅 / codex ChatGPT
  | 'api-key' // 显式 API key
  | 'token' // OAuth token（env / setup-token，auth status 不再细分来源）
  | 'third-party' // Bedrock / Vertex / Foundry
  | 'custom-provider' // codex 自定义 model_provider（API-key 组织用户的典型形态）
  | 'not-logged-in'
  | 'not-installed'
  | 'unknown' // 探测失败（超时/输出不可解析），不等于未登录

export interface BackendStatus {
  state: BackendLoginState
  /** 补充信息：codex ChatGPT 的 email/planType、third-party 的 provider 名 */
  detail?: string
  /** 探测失败时的错误摘要（state=unknown） */
  error?: string
}

export interface BackendsStatus {
  checkedAt: number
  claude: BackendStatus
  codex: BackendStatus
}

// ---------- 分类（纯函数，单测锚点） ----------

/** claude auth status --json 的 authMethod 取值见 CLI 源码 authStatus()：
 *  none / claude.ai / api_key_helper / oauth_token / api_key / third_party。
 *  oauth_token 同时覆盖 ANTHROPIC_AUTH_TOKEN（网关 token）与 setup-token/钥匙串 OAuth，
 *  JSON 输出不含 tokenSource，无法再分——统一归 token，由用户自知。 */
export function classifyClaudeAuth(s: {
  loggedIn?: boolean
  authMethod?: string
  apiProvider?: string
}): BackendStatus {
  if (s.loggedIn !== true) return { state: 'not-logged-in' }
  switch (s.authMethod) {
    case 'claude.ai':
      return { state: 'subscription' }
    case 'api_key':
    case 'api_key_helper':
      return { state: 'api-key' }
    case 'third_party':
      return { state: 'third-party', detail: s.apiProvider }
    case 'oauth_token':
      return { state: 'token' }
    default:
      // loggedIn=true 但 method 未知（新版新增来源）：有凭据可用，归 token 并留原文
      return { state: 'token', detail: s.authMethod }
  }
}

type CodexAccount =
  | { type: 'apiKey' }
  | { type: 'chatgpt'; email: string | null; planType: string }
  | { type: 'amazonBedrock'; usesCodexManagedCredentials: boolean }

/** account/read 语义（codex app-server 源码 get_account_response）：
 *  account=null 且 requiresOpenaiAuth=false → 配置了自定义 provider，不需要 OpenAI 登录；
 *  account=null 且 requiresOpenaiAuth=true → 默认 provider 且无凭据，必须 login。 */
export function classifyCodexAccount(r: {
  account: CodexAccount | null
  requiresOpenaiAuth: boolean
}): BackendStatus {
  const a = r.account
  if (!a) return { state: r.requiresOpenaiAuth ? 'not-logged-in' : 'custom-provider' }
  switch (a.type) {
    case 'chatgpt':
      return { state: 'subscription', detail: [a.email, a.planType].filter(Boolean).join(' · ') }
    case 'apiKey':
      return { state: 'api-key' }
    case 'amazonBedrock':
      return { state: 'third-party', detail: 'Amazon Bedrock' }
  }
}

// ---------- 探针（子进程 / RPC，带超时） ----------

const PROBE_TIMEOUT_MS = 20_000

/** auth status 退出码语义（CLI 源码 authStatus 末行）：loggedIn ? 0 : 1——
 *  未登录也退出 1 且仍输出合法 JSON，因此非零退出 ≠ 探测失败：
 *  输出可解析为 JSON 一律以 JSON 为准；不可解析才是真失败（老版本无此子命令等）。 */
export function parseClaudeAuthStatusOutput(code: number, out: string): BackendStatus {
  try {
    const parsed = JSON.parse(out) as { loggedIn?: boolean; authMethod?: string; apiProvider?: string }
    return classifyClaudeAuth(parsed)
  } catch {
    return { state: 'unknown', error: `exit ${code}: ${out.trim().slice(0, 200) || '无输出'}` }
  }
}

async function probeClaude(): Promise<BackendStatus> {
  const { cmd, prefix } = resolveClaudeCommand()
  let proc: ReturnType<typeof Bun.spawn>
  try {
    proc = Bun.spawn([cmd, ...prefix, 'auth', 'status', '--json'], {
      stdout: 'pipe',
      stderr: 'pipe',
      // 与 spawn 会话一致的 env（ANTHROPIC_* 透传，ANYPLANE_TOKEN 剔除）
      env: childEnv(),
    })
  } catch {
    return { state: 'not-installed' }
  }
  const timer = setTimeout(() => proc.kill(), PROBE_TIMEOUT_MS)
  try {
    const stdout = proc.stdout
    if (typeof stdout === 'number' || !stdout) return { state: 'unknown', error: 'stdout 不可用' }
    const [code, out] = await Promise.all([proc.exited, new Response(stdout).text()])
    return parseClaudeAuthStatusOutput(code, out)
  } catch (e) {
    return { state: 'unknown', error: e instanceof Error ? e.message : String(e) }
  } finally {
    clearTimeout(timer)
  }
}

async function probeCodex(): Promise<BackendStatus> {
  // 先查二进制再碰 RPC：未安装时 ensureRpc 的 spawn 失败路径又慢又吵
  if (!Bun.which('codex')) return { state: 'not-installed' }
  try {
    const res = (await codexRuntime.rpcRequest('account/read', {}, PROBE_TIMEOUT_MS)) as {
      account: CodexAccount | null
      requiresOpenaiAuth: boolean
    }
    return classifyCodexAccount(res)
  } catch (e) {
    return { state: 'unknown', error: e instanceof Error ? e.message : String(e) }
  }
}

// ---------- 缓存 + single-flight ----------

const CACHE_TTL_MS = 30_000
let cached: BackendsStatus | undefined
let inflight: Promise<BackendsStatus> | undefined

export type ProbeDeps = { probeClaude: () => Promise<BackendStatus>; probeCodex: () => Promise<BackendStatus> }
const defaultDeps: ProbeDeps = { probeClaude, probeCodex }

/** 双后端并行探测；30s 内重复调用走缓存（列表页 10s 轮询不会放大成子进程风暴） */
export async function getBackendsStatus(deps: ProbeDeps = defaultDeps): Promise<BackendsStatus> {
  if (cached && Date.now() - cached.checkedAt < CACHE_TTL_MS) return cached
  if (inflight) return inflight
  inflight = (async () => {
    const [claude, codex] = await Promise.all([
      deps.probeClaude().catch((e) => ({ state: 'unknown', error: String(e) }) as BackendStatus),
      deps.probeCodex().catch((e) => ({ state: 'unknown', error: String(e) }) as BackendStatus),
    ])
    const result: BackendsStatus = { checkedAt: Date.now(), claude, codex }
    // unknown 不入缓存：探测失败应允许下次立即重试，缓存会放大瞬时故障
    if (claude.state !== 'unknown' && codex.state !== 'unknown') cached = result
    return result
  })()
  try {
    return await inflight
  } finally {
    inflight = undefined
  }
}

/** 测试用：清空缓存与在途 Promise */
export function resetBackendsStatusCache(): void {
  cached = undefined
  inflight = undefined
}
