// 「本会话允许」放行集（C1 进程层权威）的唯一实现：rememberTool 裁决时写入（审批到达时
// 句柄必活），dispose/discard 焚毁——无喂回、无复活。
// 两后端会话类各持一个实例并委托三方法（曾逐字复制两份，语义变更要 4 个点位同步落）。

/** 进程层放行集：写/查/焚毁三件套 */
export class AllowTools {
  private tools: Set<string> | undefined

  /** rememberTool 裁决写入（审批到达时句柄必活，写进本实例的集） */
  remember(toolName: string): void {
    ;(this.tools ??= new Set()).add(toolName)
  }

  /** 命中查询（权威；未记名/已焚毁恒 false——退化为「下次重问」，安全方向） */
  allows(toolName: string): boolean {
    return this.tools?.has(toolName) ?? false
  }

  /** 焚毁（dispose 同步路径与 Hub 失效卡口共用；幂等） */
  discard(): void {
    this.tools = undefined
  }
}
