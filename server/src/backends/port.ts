// BackendPort：Hub 编排层对后端的唯一能力入口。
// 两后端各一个适配器（claude/port.ts、codex/port.ts），编排层经 portFor(key)/backendPort(name)
// 分发，编排层不再出现 isCodexKey 能力分支（key 工具函数除外——key 本身编码后端，属元数据读取）。
//
// 依赖红线：适配器可以 import 具体后端实现（processManager/codexRuntime），
// 但绝不 import hub 编排层（index.ts）的运行时代码——回调经 HubServices 注入（S1.2 起）。
// Hub 目前以 import type 引用（type-only，无运行时环；S2 迁入 hub/types.ts）。
//
// 注册表方向（13.3）：本模块是契约叶子——不 import 任何适配器（反向 import 即 port.ts ↔
// 适配器的模块环，环安全性此前只靠注释守护）。适配器实例由装配层（index.ts）
// registerBackend 注入，与 initBackendPorts 同一模式，不依赖 ESM 加载顺序副作用。

import type { Hub } from '../hub/types'
import type { HandoffDetail } from '../handoff'
import { errorMessage } from '../util'
import type {
  ApprovalDecision,
  ArchivedEntry,
  BackendCapabilities,
  BackendName,
  BackgroundTask,
  CodexModelInfo,
  ContextUsageInfo,
  ImageAttachment,
  QueryResultPayload,
  ServerEvent,
  SessionState,
  TokenUsage,
} from '@anyplane/protocol'
import type { SessionCallbacks, SpawnOptions } from './types'

/** 适配器回调编排层的服务面（装配层 initBackendPorts 注入一次；适配器禁止 import index.ts） */
export interface HubServices {
  broadcast(hub: Hub, payload: ServerEvent): void
  broadcastError(hub: Hub, message: string): void
  pushStatus(hub: Hub, extra?: Partial<SessionState>): void
  sessionCallbacks(hub: Hub): SessionCallbacks
  getHub(key: string): Hub
  /** 会话显示名（推送/日志用）；实现在 push 域，由装配层注入 */
  sessionNameOf(key: string): string
  /** 回滚进行中拒绝新操作：返回 true 表示已拒绝（错误已广播） */
  rewindBusy(hub: Hub, message?: string): boolean
}

let services: HubServices | undefined

/** 装配层（index.ts）一次性注入；不依赖 ESM import 顺序副作用 */
export function initBackendPorts(s: HubServices): void {
  services = s
}

/** 适配器取回调服务；未装配即调用是编程错误，fail fast */
export function hubServices(): HubServices {
  if (!services) throw new Error('[port] initBackendPorts 未在装配层调用')
  return services
}

// ---------- 会话句柄面 ----------

/** Hub 可见的最小会话句柄面：ClaudeSession/CodexSession 已结构化同形（契约见 types.ts
 *  末尾注释），两个类文件零改动——TS 结构类型自动兼容本接口。
 *  claude-only 的能力（sideQuestion/generateSessionTitle/notifyExternalGate 等）
 *  不进本接口，由 claude 适配器内部用具体类型承接。 */
export interface SessionHandle {
  readonly sessionId: string | undefined
  readonly exited: boolean
  readonly busy: boolean
  readonly waiting: boolean
  readonly sessionState: 'idle' | 'running' | 'requires_action'
  readonly connectedClients: number
  readonly tokenUsage: TokenUsage | undefined
  readonly contextUsage: ContextUsageInfo | undefined
  /** 会话 cwd（codex 句柄有 getter；claude 缺席——x| key 的 sessionNameOf 反查用，
   *  可选属性使 ClaudeSession 无需改动即结构化兼容） */
  readonly cwd?: string
  /** 后台任务表（claude 专属；codex 缺席——恒空数组会被 hydrateTasks 误读为权威空） */
  readonly activeTaskCount?: number
  readonly backgroundTasks?: BackgroundTask[]
  sendUserText(text: string, sendMode?: 'steer' | 'queue', images?: ImageAttachment[]): void
  sendApproval(requestId: string, decision: ApprovalDecision): void
  sendControl(subtype: string, extra?: Record<string, unknown>): void
  /** 可等待的控制请求通道（claude 专属；codex 的 rewind/查询走专用 RPC，无对应物） */
  sendControlAndWait?(
    subtype: string,
    extra?: Record<string, unknown>,
    timeoutMs?: number,
  ): Promise<unknown>
  write(msg: { type: 'update_environment_variables'; variables: Record<string, string> }): void
  syncClients(count: number): void
  attachClient(): void
  detachClient(): void
}

/** statusOf 的调用上下文：hub 由编排层传入（适配器不反查 hubs 注册表） */
export interface StatusContext {
  hub: Hub | undefined
  /** 调用方（/api/sessions）刚做过 pid 扫描时传入复用，避免每行各扫一次；
   *  显式 null 表示"已知不在线"（跳过扫描），undefined 才现扫。仅 claude 适配器使用。 */
  liveHint?: { status: string; pid: number } | null
  /** 仅单会话 attach/pushStatus 路径开启（离线时读 transcript 尾部补上下文占用）；
   *  列表端点禁止开启（N 行 × 文件读）。 */
  hydrateContext?: boolean
}

/** REST 管理面结果：路由层原样映射为 HTTP 响应（状态码逐字保留） */
export type RouteResult = { ok: true } | { ok: false; error: string; status: number }

export interface BackendPort {
  readonly name: BackendName
  /** 能力声明：能力差异的唯一权威，hub 层按此把关、statusOf 随 SessionState 下发前端 */
  readonly capabilities: BackendCapabilities
  /** 当前存活（或已退出待回收）的会话句柄；取代编排层散落的 isCodexKey ? codexRuntime.get : processManager.get */
  sessionOf(key: string): SessionHandle | undefined
  /** 存活判定（ws close 的 Hub 回收依据）：claude = 句柄存在；codex = 句柄存在且未退出 */
  hasLiveSession(key: string): boolean
  /** 外部门禁（control.sock 生态）通知：claude 转发句柄方法（capabilities.externalGate） */
  notifyExternalGate?(key: string): void
  /** 会话状态派生（两后端函数体分别在各自适配器内；公共字段走 baseStatusOf） */
  statusOf(key: string, cx: StatusContext): SessionState

  /** attach 分流：claude 懒启动（warm/opts 才 spawn）；codex x| 即 resume、xn| 懒启动 */
  onAttach(hub: Hub, msg: Record<string, unknown>): void
  /** 懒启动/续跑会话。时序红线：claude 实现的函数体到 return 前禁止出现 await——
   *  调用方依赖 spawn/stopTailer/syncClients/pendingEnv 写入与调用同拍完成 */
  ensure(hub: Hub, opts?: Partial<SpawnOptions>): Promise<SessionHandle | undefined>
  /** 发送路径的就绪检查：未运行则触发懒启动；未就绪返回 undefined（错误已广播）。
   *  时序红线同 ensure（claude 实现零 await）。 */
  ensureForSend(hub: Hub): Promise<SessionHandle | undefined>
  /** 发送成功后的后端特定跟踪（claude：/goal 出站跟踪 + 标题素材记账） */
  afterUserSent?(hub: Hub, text: string): void
  /** 官方 AI 标题双条件触发（capabilities.aiTitle；claude-only） */
  maybeGenerateTitle?(hub: Hub): void
  /** transcript 实时跟踪（capabilities.tailer；claude-only） */
  startTailer?(hub: Hub, from?: number): void
  stopTailer?(hub: Hub): void
  /** 对话回滚：claude=原地截断重 spawn；codex=thread/revert|fork 双轨 */
  rewindConversation(hub: Hub, userMessageId: string): void
  /** 组合回滚（文件+对话，capabilities.fileCheckpoint；claude-only） */
  rewindBoth?(hub: Hub, userMessageId: string): void

  // ---------- 消息域（model/mode 缓存与 rewindPending 守卫留在 hub 层，此处为后端投递） ----------
  /** 通用控制请求：codex 直接翻译（interrupt/set_model/set_permission_mode/compact）；
   *  claude 未 spawn 时除 set_model/set_permission_mode（有启动参数等价物）外触发懒启动 */
  deliverControl(hub: Hub, subtype: string, extra: Record<string, unknown>): void
  /** 环境变量（effort 已在上层缓存进 spawnOpts）：claude 未 spawn 时并入 pendingEnv；
   *  codex 映射 reasoning effort */
  updateEnv(hub: Hub, variables: Record<string, string>): void
  /** 分叉当前会话（capabilities.branch；claude 懒分叉 b| key；codex 无对应物） */
  branch?(hub: Hub, name: string): void
  /** 侧问：借用当前会话上下文的一次性问答（btw_pending 已由上层先行广播） */
  btw(hub: Hub, question: string): void
  /** 带应答的只读查询/MCP 管理动作；hub 层先按 capabilities.queries 白名单把关，
   *  适配器不再各自做"暂不支持"拒绝 */
  query(
    hub: Hub,
    query: string,
    extra: Record<string, unknown>,
    reply: (payload: QueryResultPayload) => void,
  ): void

  // ---------- handoff（接力） ----------
  /** 接力源解析：cwd（codex x| key 不含，可能缺省）+ 会话 id */
  handoffSource(key: string): { cwd?: string; sourceId?: string }
  /** cwd 的惰性补全：codex 走 thread/read；claude 重查 parseKey */
  handoffCwdOf(key: string, sourceId: string): Promise<string | undefined>
  /** 源会话 fork 自摘要：claude 在线走 side_question、离线一次性 fork spawn；codex ephemeral fork */
  forkBriefForHandoff(
    fromKey: string,
    cwd: string,
    sourceId: string,
    detail: HandoffDetail,
  ): Promise<{ text: string; usage?: Record<string, number> }>
  /** 目标会话播种首条消息，返回目标 sessionId（claude 含 init 前 30s 轮询）；启动失败抛错 */
  seedHandoffTarget(hub: Hub, seed: string): Promise<string | undefined>
  /** 播种拿到真实 id 后的会话重键（n|→s| / xn|→x|）：进程/线程句柄不换，map 键跟随，
   *  并对齐 spawnOpts 里的会话身份（回收重生须续跑当前会话）。由 hub/handoff.ts 在广播
   *  handoff_done 前调用——不同步的话浏览器导航到 resolved key 查不到播种进程，live 事件
   *  进无客户端的旧 Hub，首条用户消息还会再 spawn 一个进程同写一份 transcript。 */
  rekeySession?(hub: Hub, oldKey: string, newKey: string, newSessionId: string): void

  // ---------- REST 管理面（归档/恢复/改名） ----------
  archive(key: string): Promise<RouteResult>
  restore(key: string): Promise<RouteResult>
  rename(key: string, title: string): Promise<RouteResult>
  /** 归档/回收站列表：claude=trash（同步文件读），codex=archived thread/list。
   *  单后端失败降级为空数组（适配器内 log），不拖垮另一后端的列表。 */
  listArchived(): Promise<ArchivedEntry[]>
  /** 新会话 key 构造（n| / xn|；POST /api/sessions 按 backend 名分发，routes 不 import key 构造函数） */
  keyForNew(cwd: string): string
  /** 模型目录（capabilities.modelCatalog；codex model/list RPC） */
  listModels?(): Promise<CodexModelInfo[]>
}

/** 两后端会话状态的公共字段（claude/codex 会话句柄结构化同形，契约见 backends/types.ts 末尾） */
export function baseStatusOf(
  s: SessionHandle | undefined,
  hub: Hub | undefined,
  waiting: boolean,
): SessionState {
  return {
    spawned: !!s && !s.exited,
    busy: (s?.busy ?? false) || waiting,
    waiting,
    sessionState: s?.sessionState ?? 'idle',
    sessionId: s?.sessionId,
    clients: s?.connectedClients ?? hub?.clients.size ?? 0,
    usage: s?.tokenUsage,
    context: s?.contextUsage,
    permissionMode: hub?.spawnOpts?.permissionMode,
    effort: hub?.spawnOpts?.effort,
    // pending 审批快照：客户端 reconcile 的唯一权威（attach 重放的实时同源版）
    pendingApprovalIds: [...(hub?.pendingApprovals.keys() ?? [])],
  }
}

/** key 的零 I/O 纯形状解析（与两后端 keyFor/keyForNew/keyForBranch 构造器一一对应）。
 *  只读 key 本身：不做 listSessions 反查也不做 RPC，故 existing 的 cwd 缺席（要 cwd 走 parseKey）。
 *  未知前缀或编码段损坏（非法 % 转义）返回 null，消费方各自兜底。 */
export interface DescribedKey {
  backend: BackendName
  kind: 'existing' | 'new' | 'branch'
  /** existing：真实会话/线程 id；branch：分叉源 sessionId（b| 内嵌的是源 id，见 keyForBranch） */
  sessionId?: string
  /** existing(claude s|)：slug 段原样（未过字符闸；要校验用 splitExistingKey） */
  slug?: string
  /** new/branch：key 内嵌的 cwd（已解码） */
  cwd?: string
}

export function describeKey(key: string): DescribedKey | null {
  try {
    const parts = key.split('|')
    if (parts[0] === 's' && parts.length === 3) {
      return { backend: 'claude', kind: 'existing', slug: parts[1], sessionId: parts[2] }
    }
    if (parts[0] === 'x' && parts.length === 2) {
      return { backend: 'codex', kind: 'existing', sessionId: parts[1] }
    }
    if (parts[0] === 'n' && parts.length === 2) {
      return { backend: 'claude', kind: 'new', cwd: decodeURIComponent(parts[1]) }
    }
    if (parts[0] === 'xn' && parts.length === 2) {
      return { backend: 'codex', kind: 'new', cwd: decodeURIComponent(parts[1]) }
    }
    if (parts[0] === 'b' && parts.length === 3) {
      return { backend: 'claude', kind: 'branch', cwd: decodeURIComponent(parts[1]), sessionId: parts[2] }
    }
    return null
  } catch {
    return null
  }
}

// ---------- 适配器注册表 ----------
// 本模块是契约叶子（不 import 适配器——反向 import 即模块环）。装配层（index.ts）
// 在 initBackendPorts 旁 registerBackend 两后端，注册前取用即 fail fast（编程错误）。

const registry: Partial<Record<BackendName, BackendPort>> = {}

/** 装配层一次性注册后端适配器；与 initBackendPorts 同一模式，不依赖 ESM 加载顺序副作用 */
export function registerBackend(name: BackendName, port: BackendPort): void {
  registry[name] = port
}

/** 测试复位口：bun test 单进程跨文件共享模块实例，碰注册表的全局状态用例开头显式复位 */
export function resetBackendsForTest(): void {
  const keys = Object.keys(registry) as BackendName[]
  for (const k of keys) delete registry[k]
}

/** 按后端名取适配器；未注册即调用是编程错误，fail fast */
export function backendPort(name: BackendName): BackendPort {
  const p = registry[name]
  if (!p) throw new Error(`[port] 后端 ${name} 未注册（装配层须先 registerBackend）`)
  return p
}

/** 编排层唯一的后端分支点：全仓库的能力分发都收敛到这一个三元。
 *  key 形状判定（x|/xn| 前缀）与 isCodexKey 逐字等价——刻意不做 URI 解码：
 *  损坏的 xn| 编码历史上也归 codex 适配器兜底，行为不变。 */
export function portFor(key: string): BackendPort {
  return backendPort(key.startsWith('x|') || key.startsWith('xn|') ? 'codex' : 'claude')
}

// ---------- /btw 侧问的共享信封（校验失败文案与 btw_result 广播只有一份，双后端不分叉） ----------

/** 无会话可借上下文时的统一拒绝（空问题 / 无 sessionId） */
export function btwRejectNoSession(hub: Hub, question: string): void {
  hubServices().broadcast(hub, {
    kind: 'btw_result',
    ok: false,
    question,
    text: '侧问需要已有会话（先发过至少一条消息）',
  })
}

/** 执行体跑完后统一广播 btw_result；流式增量（btw_delta）由后端在执行体内自行广播 */
export function btwDeliver(hub: Hub, question: string, run: () => Promise<string>): void {
  const { broadcast } = hubServices()
  run()
    .then((text) => broadcast(hub, { kind: 'btw_result', ok: true, question, text }))
    .catch((e) =>
      broadcast(hub, { kind: 'btw_result', ok: false, question, text: `侧问失败: ${errorMessage(e)}` }),
    )
}
