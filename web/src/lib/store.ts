// 极简外部 store（零第三方依赖，useSyncExternalStore 同形自实现）。
// 解决的问题（审计发现六）：WS 回调在 React 渲染外触发，useState 闭包会取到过期值，
// 历史上靠 ref+state 双写逐处手写同步（messagesRef/setMessages、draftRef/setDraft 等）——
// 理由正当但没有统一机制，漏一处即状态撕裂。store 把「读最新值」与「订阅渲染」收进
// 同一对象：渲染外一律 store.get()/store.set()，渲染内 useStore(store)。
//
// 纪律（与 setState 相同）：set 的 next 必须是新引用（Object.is 相等即跳过通知）；
// 渲染外的连续 set 是同步通知订阅者，React 按外部 store 语义调度重渲。
// 注意：updater 与值按 typeof === 'function' 分派（与 React setState 同约定）——
// T 本身是函数类型时，存函数值需 set(() => fn) 包裹，否则会被当 updater 调用。

import { useSyncExternalStore } from 'react'

export interface Store<T> {
  get(): T
  set(next: T | ((prev: T) => T)): void
  subscribe(fn: () => void): () => void
}

export function createStore<T>(initial: T): Store<T> {
  let value = initial
  const listeners = new Set<() => void>()
  return {
    get: () => value,
    set: (next) => {
      const v = typeof next === 'function' ? (next as (prev: T) => T)(value) : next
      if (Object.is(v, value)) return
      value = v
      // 逐个隔离：一个订阅者抛错不得中断其余订阅者的通知（否则该变更对后面的
      // 组件永久丢失，直到下一次无关 set 才自愈）。React 内部的 handleStoreChange
      // 只调度不抛，此防御面向未来的普通函数订阅者（日志/遥测等）。
      for (const fn of listeners) {
        try {
          fn()
        } catch (e) {
          console.error('[store] 订阅者通知异常（已隔离，其余订阅者照常）:', e)
        }
      }
    },
    subscribe: (fn) => {
      listeners.add(fn)
      return () => {
        listeners.delete(fn)
      }
    },
  }
}

/** 订阅 store 的当前值（引用变化即重渲；getServerSnapshot 与客户端同源，SSR 不分叉） */
export function useStore<T>(store: Store<T>): T {
  return useSyncExternalStore(store.subscribe, store.get, store.get)
}
