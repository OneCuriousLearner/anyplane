// model → 上下文窗口大小的习得表：**仅供离线水合**（无活进程可问时）的最后已知值。
// 权威来源始终是官方 get_context_usage 控制请求的 maxTokens，live 会话每次都重新问。
//
// 为什么需要：[1m] 后缀启发式在**默认部署下是准的**（claude 就按 200K/1M 映射），但它看不见
// CLI 进程内的覆盖——CLAUDE_CODE_MAX_CONTEXT_TOKENS、自定义 model catalog、网关型号等。
// 实测（Kimi 网关）两个方向都会偏：k3-256k 无后缀被算成 200k（实为 256k）；k3[1M] 有后缀被
// 算成 1M，而 env 上限把它压到 256k——虚高 3.9 倍，环形的压缩预警永不触发。
//
// 为什么按 model 而非 sessionId 存：同模型同配置下窗口不变，一次习得可惠及该模型的所有离线
// 会话。**刻意不做长期缓存语义**：live 会话不读这张表，配置改动下个会话即自愈。
// 落 ~/.anyplane/context-windows.json。

import { jsonTableStore } from '../../util'

const store = jsonTableStore<number>('context-windows.json')

/** 登记权威窗口大小（get_context_usage 应答时调用）。值不变则不写盘 */
export function rememberContextWindow(model: string, windowSize: number): void {
  if (!model || !Number.isFinite(windowSize) || windowSize <= 0) return
  store.remember(model, windowSize)
}

/** 查已习得的权威窗口；未见过返回 undefined，由调用方回退启发式 */
export function learnedContextWindow(model: string | undefined): number | undefined {
  if (!model) return undefined
  return store.get(model)
}

/** 测试钩子：重定向存储文件并重置内存缓存（不传则恢复默认路径） */
export const setContextWindowStoreForTest = store.setStoreFileForTest
