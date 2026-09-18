// 双后端登录状态探测：会话列表页的「该去登录哪个」指引数据源。
// Claude 走官方 `claude auth status --json`（轻量子命令，不起会话）；
// Codex 走 app-server `account/read` RPC（协议正本，覆盖自定义 provider 场景）。
// 探测有成本（spawn 子命令/子进程），模块级 TTL 缓存 + single-flight；
// **懒 spawn 红线**：探测绝不留下常驻进程（见 probeCodex）。
// 契约类型（BackendLoginState/BackendStatus/BackendsStatus）正本在 @anyplane/protocol。

import type { BackendStatus, BackendsStatus } from '@anyplane/protocol'
import { childEnv } from '../util'
import { resolveClaudeCommand } from './claude/processManager'
import { RpcClient } from './codex/rpc'
import { codexRuntime, handshakeAppServer } from './codex/runtime'

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
 *  输出可解析为 JSON 一律以 JSON 为准；不可解析才是真失败（老版本无此子命令等）。
 *  stderrTail 仅用于给 unknown 留现场（升级通知等 stderr 噪音已正常消费，不会堵管道）。 */
export function parseClaudeAuthStatusOutput(code: number, out: string, stderrTail = ''): BackendStatus {
  try {
    const parsed = JSON.parse(out) as { loggedIn?: boolean; authMethod?: string; apiProvider?: string }
    return classifyClaudeAuth(parsed)
  } catch {
    const detail = (out.trim() || stderrTail.trim()).slice(0, 200) || '无输出'
    return { state: 'unknown', error: `exit ${code}: ${detail}` }
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
    const stderr = proc.stderr
    // stderr 必须同步消费：持而不读时子进程写满 OS 管道缓冲（Linux ~64KB）即阻塞，
    // stdout 读不完挂到超时被杀 → 健康后端被误报 unknown
    const [code, out, errText] = await Promise.all([
      proc.exited,
      new Response(stdout).text(),
      typeof stderr === 'number' || !stderr ? Promise.resolve('') : new Response(stderr).text(),
    ])
    return parseClaudeAuthStatusOutput(code, out, errText)
  } catch (e) {
    return { state: 'unknown', error: e instanceof Error ? e.message : String(e) }
  } finally {
    clearTimeout(timer)
  }
}

async function probeCodex(): Promise<BackendStatus> {
  // 先查二进制再碰 RPC：未安装时连一次性 spawn 都省掉。
  // Windows 的 npm 全局布局只有 .cmd shim（cli/anyplane.ts whichAny 同款探测）
  const codexBin =
    Bun.which('codex') ??
    (process.platform === 'win32' ? (Bun.which('codex.cmd') ?? Bun.which('codex.exe')) : null)
  if (!codexBin) return { state: 'not-installed' }

  // 会话在跑 → 复用共享连接，零成本
  const live = codexRuntime.peekRpc()
  if (live) {
    try {
      const res = (await live.request('account/read', {}, { timeoutMs: PROBE_TIMEOUT_MS })) as {
        account: CodexAccount | null
        requiresOpenaiAuth: boolean
      }
      return classifyCodexAccount(res)
    } catch (e) {
      return { state: 'unknown', error: e instanceof Error ? e.message : String(e) }
    }
  }

  // 会话没跑 → 一次性 spawn：握手 → account/read → kill。
  // 不能走 codexRuntime.ensureRpc()——那会永久拉起共享 app-server，
  // 只装不用的 Claude 用户打开列表页就白背一个常驻进程（懒 spawn 红线）。
  let rpc: RpcClient | undefined
  try {
    rpc = RpcClient.spawn(['codex', 'app-server', '--stdio'])
    // 无主请求（探测期间不应出现）拒绝掉避免悬挂，与 runtime.demuxRequest 同款兜底
    rpc.onServerRequest = (r) => {
      try {
        rpc?.respond(r.id, { decision: 'decline' })
      } catch {}
    }
    await handshakeAppServer(rpc, PROBE_TIMEOUT_MS)
    const res = (await rpc.request('account/read', {}, { timeoutMs: PROBE_TIMEOUT_MS })) as {
      account: CodexAccount | null
      requiresOpenaiAuth: boolean
    }
    return classifyCodexAccount(res)
  } catch (e) {
    return { state: 'unknown', error: e instanceof Error ? e.message : String(e) }
  } finally {
    rpc?.kill()
  }
}

// ---------- 缓存 + single-flight ----------

// 与前端轮询（60s）同频：unknown 同规则入缓存——不缓存会让「app-server 启动即崩」
// 演变成每个标签页每 30s 一次的 spawn 崩溃重试循环；60s 的恢复延迟对登录指引场景可接受
const CACHE_TTL_MS = 60_000
let cached: BackendsStatus | undefined
let inflight: Promise<BackendsStatus> | undefined

export type ProbeDeps = { probeClaude: () => Promise<BackendStatus>; probeCodex: () => Promise<BackendStatus> }
const defaultDeps: ProbeDeps = { probeClaude, probeCodex }

/** 双后端并行探测；TTL 内重复调用走缓存（列表页轮询不会放大成子进程风暴） */
export async function getBackendsStatus(deps: ProbeDeps = defaultDeps): Promise<BackendsStatus> {
  if (cached && Date.now() - cached.checkedAt < CACHE_TTL_MS) return cached
  if (inflight) return inflight
  inflight = (async () => {
    const [claude, codex] = await Promise.all([
      deps.probeClaude().catch((e) => ({ state: 'unknown', error: String(e) }) as BackendStatus),
      deps.probeCodex().catch((e) => ({ state: 'unknown', error: String(e) }) as BackendStatus),
    ])
    const result: BackendsStatus = { checkedAt: Date.now(), claude, codex }
    cached = result
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
