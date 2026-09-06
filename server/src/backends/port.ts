// BackendPort：Hub 编排层对后端的唯一能力入口。
// 两后端各一个适配器（claude/port.ts、codex/port.ts），编排层经 portFor(key) 分发，
// 编排层不再出现 isCodexKey 能力分支（key 工具函数除外——key 本身编码后端，属元数据读取）。
//
// 依赖红线：适配器可以 import 具体后端实现（processManager/codexRuntime），
// 但绝不 import hub 编排层（index.ts）的运行时代码——回调经 HubServices 注入（S1.2 起）。
// Hub 目前以 import type 引用（type-only，无运行时环；S2 迁入 hub/types.ts）。
//
// 模块环说明：port.ts ↔ claude/port.ts、codex/port.ts 之间存在 import 环
//（portFor 需要适配器实例，适配器需要 baseStatusOf/类型）。两侧都只在方法体内
//  deferred 使用对方绑定（implements 为 type-only 已擦除），模块求值期无 TDZ 读取。

import type { Hub } from '../index'
import { isCodexKey } from './codex/backend'
import { claudePort } from './claude/port'
import { codexPort } from './codex/port'
import type { ApprovalDecision, BackendName } from './types'

/** 浏览器上传的图片附件（base64）；codex 侧落盘后走 localImage */
export interface ImageAttachment {
  name: string
  mediaType: string
  dataBase64: string
}

/** Hub 可见的最小会话句柄面：ClaudeSession/CodexSession 已结构化同形（契约见 types.ts
 *  末尾注释），两个类文件零改动——TS 结构类型自动兼容本接口。
 *  claude-only 的能力（sideQuestion/generateSessionTitle/notifyExternalGate 等）
 *  不进本接口，由 claude 适配器内部用具体类型承接。 */
export interface SessionHandle {
  readonly sessionId: string | undefined
  readonly exited: boolean
  readonly busy: boolean
  readonly waiting: boolean
  readonly sessionState: string
  readonly connectedClients: number
  readonly tokenUsage: unknown
  readonly contextUsage: unknown
  sendUserText(text: string, sendMode?: 'steer' | 'queue', images?: ImageAttachment[]): void
  sendApproval(requestId: string, decision: ApprovalDecision): void
  sendControl(subtype: string, extra?: Record<string, unknown>): void
  sendControlAndWait(
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

export interface BackendPort {
  readonly name: BackendName
  /** 当前存活（或已退出待回收）的会话句柄；取代编排层散落的 isCodexKey ? codexRuntime.get : processManager.get */
  sessionOf(key: string): SessionHandle | undefined
  /** 存活判定（ws close 的 Hub 回收依据）：claude = 句柄存在；codex = 句柄存在且未退出 */
  hasLiveSession(key: string): boolean
  /** 外部门禁（control.sock 生态）通知：claude 转发句柄方法；codex 无对应物，no-op */
  notifyExternalGate(key: string): void
  /** 会话状态派生（两后端函数体分别在各自适配器内；公共字段走 baseStatusOf） */
  statusOf(key: string, cx: StatusContext): Record<string, unknown>
}

/** 两后端会话状态的公共字段（claude/codex 会话句柄结构化同形，契约见 backends/types.ts 末尾） */
export function baseStatusOf(
  s: SessionHandle | undefined,
  hub: Hub | undefined,
  waiting: boolean,
): Record<string, unknown> {
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
  }
}

export function backendOf(key: string): BackendName {
  return isCodexKey(key) ? 'codex' : 'claude'
}

/** 编排层唯一的后端分支点：全仓库的能力分发都收敛到这一个三元 */
export function portFor(key: string): BackendPort {
  return isCodexKey(key) ? codexPort : claudePort
}
