import { describe, expect, test } from 'bun:test'
import { createStore } from './store'

describe('createStore（渲染外可变状态的统一容器）', () => {
  test('get/set 与函数 updater', () => {
    const s = createStore(0)
    expect(s.get()).toBe(0)
    s.set(1)
    expect(s.get()).toBe(1)
    s.set((prev) => prev + 10)
    expect(s.get()).toBe(11)
  })

  test('set 通知订阅者；同引用跳过通知（Object.is 守卫）', () => {
    const arr = [1, 2]
    const s = createStore<number[]>(arr)
    let calls = 0
    const un = s.subscribe(() => calls++)
    s.set(arr) // 同引用
    expect(calls).toBe(0)
    s.set([...arr])
    expect(calls).toBe(1)
    expect(s.get()).not.toBe(arr)
    un()
    s.set([...arr, 9])
    expect(calls).toBe(1) // 退订后不再通知
  })

  test('updater 返回同引用同样跳过（等价 setState bailout 语义）', () => {
    const s = createStore({ n: 1 })
    let calls = 0
    s.subscribe(() => calls++)
    s.set((prev) => prev)
    expect(calls).toBe(0)
  })

  test('渲染外连续 set 按序同步通知（WS 回调场景）', () => {
    const s = createStore<string[]>([])
    const seen: number[] = []
    s.subscribe(() => seen.push(s.get().length))
    s.set((p) => [...p, 'a'])
    s.set((p) => [...p, 'b'])
    s.set((p) => [...p, 'c'])
    expect(seen).toEqual([1, 2, 3])
    expect(s.get()).toEqual(['a', 'b', 'c'])
  })
})
