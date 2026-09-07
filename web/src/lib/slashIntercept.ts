// 斜杠命令拦截表（数据化）：match 顺序即优先级，与原 Chat.tsx send() 内联表逐字一致。
// 命中后返回动作联合，副作用执行（send/pushSystem/导航）留在 Chat 组合层——
// 本模块纯函数，bun:test 直接钉住匹配与参数提取。
//
// 设计约束（见 AGENTS.md「斜杠命令」）：
// - claude 尽量透传，CLI 是命令仲裁者；codex app-server 对斜杠文本零解析，
//   凡有 RPC 对应物的命令必须前端拦截（双后端命令不分叉的代价）。
// - /btw 官方 headless 是空操作 → side_question 控制通道；/branch headless 写孤立 fork
//   不切换 → 全形拦截；/exit /quit headless 真杀进程 → 拦下提示归档。

/** 拦截动作联合：执行器（Chat.tsx runSlashAction）按 type 分发副作用 */
export type SlashAction =
  /** /rewind 及其官方别名 /checkpoint /undo：打开回滚面板 */
  | { type: 'openRewind' }
  /** /btw <问题>：侧问（question 空串 = 缺参数，执行器给用法提示） */
  | { type: 'btw'; question: string }
  /** /branch|/fork [名字]：分叉（codex 命中时执行器给引导提示，不发送） */
  | { type: 'branch'; name?: string }
  /** /exit|/quit：headless 会真杀进程，拦下给替代指引 */
  | { type: 'exitHint' }
  /** codex /compact → control compact */
  | { type: 'compact' }
  /** codex /context：无 get_context_usage 对应物，执行器用 state.usage 顶一句 */
  | { type: 'context' }
  /** codex /goal [条件]：condition 设定；clear 清除；皆无 = 查询，执行器读 state.goal 给提示 */
  | { type: 'goal'; condition?: string; clear?: boolean }
  /** codex /review [说明]：无参审未提交改动，带参按自定义说明审（inline 在本线程跑） */
  | { type: 'review'; instructions?: string }
  /** codex /rename <新名字>（name 缺省 = 缺参数，执行器给用法提示） */
  | { type: 'rename'; name?: string }
  /** codex /new 与 /clear 同为 thread/start 新线程：导航到 xn| 新会话页（懒启动） */
  | { type: 'newThread' }

interface InterceptRule {
  match: (t: string, isCodex: boolean) => boolean
  action: (t: string) => SlashAction
}

/** 拦截表：数组顺序 = 判定优先级（逐字对齐原 send() 内联表） */
const INTERCEPT_TABLE: InterceptRule[] = [
  {
    // /rewind 及其官方别名 /checkpoint /undo
    match: (t) => t === '/rewind' || t === '/checkpoint' || t === '/undo',
    action: () => ({ type: 'openRewind' }),
  },
  {
    match: (t) => /^\/btw(\s|$)/.test(t),
    action: (t) => ({ type: 'btw', question: t.slice(4).trim() }),
  },
  {
    // 内建 /branch（有参时）会在 headless 下写孤立 fork 会话文件却不切换（context.resume 缺席），
    // 必须全形拦截（含参数）；名字透传给分叉 spawn 的 -n
    match: (t) => /^\/(branch|fork)(\s|$)/.test(t),
    action: (t) => ({ type: 'branch', name: t.match(/^\/(?:branch|fork)(?:\s+(.*))?$/)?.[1]?.trim() || undefined }),
  },
  {
    // /exit /quit headless 下会真的杀掉 CLI 进程——web 场景下多半是误触，拦下给替代指引
    match: (t) => t === '/exit' || t === '/quit',
    action: () => ({ type: 'exitHint' }),
  },
  {
    match: (t, isCodex) => isCodex && t === '/compact',
    action: () => ({ type: 'compact' }),
  },
  {
    match: (t, isCodex) => isCodex && t === '/context',
    action: () => ({ type: 'context' }),
  },
  {
    match: (t, isCodex) => isCodex && /^\/goal(\s|$)/.test(t),
    action: (t) => {
      const arg = t.slice(5).trim()
      if (!arg) return { type: 'goal' }
      if (/^(clear|stop|off|reset|none|cancel)$/i.test(arg)) return { type: 'goal', clear: true }
      return { type: 'goal', condition: arg }
    },
  },
  {
    match: (t, isCodex) => isCodex && /^\/review(\s|$)/.test(t),
    action: (t) => ({ type: 'review', instructions: t.slice(7).trim() || undefined }),
  },
  {
    match: (t, isCodex) => isCodex && /^\/rename(\s|$)/.test(t),
    action: (t) => ({ type: 'rename', name: t.slice(7).trim() || undefined }),
  },
  {
    // codex /new 与 /clear 同为 thread/start 新线程：导航到 xn| 新会话页（懒启动）
    match: (t, isCodex) => isCodex && (t === '/new' || t === '/clear'),
    action: () => ({ type: 'newThread' }),
  },
]

/** 命中返回动作（调用方随后清空输入框并 return）；未命中返回 null（透传给 CLI） */
export function interceptSlash(text: string, opts: { isCodex: boolean }): SlashAction | null {
  for (const rule of INTERCEPT_TABLE) {
    if (rule.match(text, opts.isCodex)) return rule.action(text)
  }
  return null
}
