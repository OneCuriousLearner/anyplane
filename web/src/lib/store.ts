// 极简外部 store（零第三方依赖，useSyncExternalStore 同形自实现）。
// 解决的问题（审计发现六）：WS 回调在 React 渲染外触发，useState 闭包会取到过期值，
// 历史上靠 ref+state 双写逐处手写同步（messagesRef/setMessages、draftRef/setDraft 等）——
// 理由正当但没有统一机制，漏一处即状态撕裂。store 把「读最新值」与「订阅渲染」收进
// 同一对象：渲染外一律 store.get()/store.set()，渲染内 useStore(store)。
//
// 纪律（与 setState 相同）：set 的 next 必须是新引用（Object.is 相等即跳过通知）；
// 渲染外的连续 set 是同步通知订阅者，React 按外部 store 语义调度重渲。

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
      for (const fn of listeners) fn()
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
