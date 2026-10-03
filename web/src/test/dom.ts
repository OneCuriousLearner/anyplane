// DOM 组件测试共享脚手架（happy-dom + react-dom/client）。
//
// 纪律（AGENTS.md「测试不得依赖文件间执行顺序」的 DOM 版）：
// bun test 单进程跨文件共享全局，GlobalRegistrator.register() 会覆盖
// window/document/WebSocket/MouseEvent 等全局——泄漏即污染其他测试文件
// （ws/nativeBridge 等用例读全局判环境）。因此 register/unregister 必须经
// setupDom() 成对出现在每个 DOM 测试文件的 beforeAll/afterAll，
// 本模块模块级绝不注册，也不建 root bunfig preload（会污染 server 测试）。

import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { expect, spyOn } from 'bun:test'
import { act, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'

// React 的 act 在非 jest 环境需要显式声明（react-dom 渲染时会检查该全局）
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/** 注册 happy-dom 全局，返回还原函数——在测试文件 beforeAll/afterAll 成对调用 */
export function setupDom(): () => void {
  GlobalRegistrator.register()
  return () => {
    GlobalRegistrator.unregister()
  }
}

export interface Rendered {
  container: HTMLElement
  /** 同 root 重渲染（props 更新/落地路径，组件 React key 不变则本地 state 保留） */
  rerender: (ui: ReactElement) => Promise<void>
  /** 幂等且自我注销（从 unmountAll 的清单摘除）——显式 unmount 与 afterEach 兜底混用安全 */
  unmount: () => Promise<void>
}

const live: Rendered[] = []

/** 挂载到 document.body 下的新容器并渲染（act 包裹，effect/状态一并刷新） */
export async function render(ui: ReactElement): Promise<Rendered> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root: Root = createRoot(container)
  let unmounted = false
  const r: Rendered = {
    container,
    rerender: async (next) => {
      await act(async () => {
        root.render(next)
      })
    },
    unmount: async () => {
      if (unmounted) return
      unmounted = true
      const i = live.indexOf(r)
      if (i >= 0) live.splice(i, 1)
      await act(async () => {
        root.unmount()
      })
      container.remove()
    },
  }
  await act(async () => {
    root.render(ui)
  })
  live.push(r)
  return r
}

/** 卸载所有未手动 unmount 的 root——测试文件 afterEach 调用，失败用例也不留挂载残留 */
export async function unmountAll(): Promise<void> {
  while (live.length > 0) {
    await live[live.length - 1]!.unmount()
  }
}

/** 触发 React 合成事件（委托监听挂在 root 容器上，必须 bubbles） */
export async function click(el: Element): Promise<void> {
  await act(async () => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  })
}

/** 两种卡片的正向把手：组件在按钮上声明 data-card（ToolCard/Thinking 各一张）。
 *  不要用 aria-expanded 有无之类的偶然差异做负向选择——第三种按钮出现时计数会无声失真。 */
export const thinkingButtons = (c: HTMLElement) => c.querySelectorAll('button[data-card="thinking"]')
export const toolButtons = (c: HTMLElement) => c.querySelectorAll('button[data-card="tool"]')

/** console.error 中 React key 警告的统一过滤口径（重复元素的通用探测器）。
 *  单进程共享 console，监听必须经 watchConsoleError 成对 restore——泄漏会让后续用例断言错位。 */
export const isKeyWarning = (args: unknown[]): boolean => String(args[0]).includes('key')

export type ConsoleErrorSpy = ReturnType<typeof spyOn>

/** 监听 console.error（用例 beforeEach 建、afterEach 经 restoreConsoleError 还原） */
export function watchConsoleError(): ConsoleErrorSpy {
  return spyOn(console, 'error')
}

/** 还原 spy 前断言零 key 警告——「每条回放/渲染都无 key 碰撞」是通用不变量，放 afterEach 最贴语义 */
export function restoreConsoleError(spy: ConsoleErrorSpy, opts?: { allowKeyWarnings?: boolean }): void {
  try {
    if (!opts?.allowKeyWarnings) expect(spy.mock.calls.filter(isKeyWarning)).toEqual([])
  } finally {
    spy.mockRestore()
  }
}
