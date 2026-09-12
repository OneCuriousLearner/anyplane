import { afterEach, describe, expect, test } from 'bun:test'
import { getHub, hubs } from './registry'

const KEY = 'n|%2Ftmp%2Fregistry-test'

afterEach(() => hubs.delete(KEY))

describe('getHub', () => {
  test('同一 key 幂等返回同一个 Hub，且保留已有状态', () => {
    const first = getHub(KEY)
    first.rewindPending = true

    const second = getHub(KEY)

    expect(second).toBe(first)
    expect(second.rewindPending).toBe(true)
    expect(hubs.get(KEY)).toBe(first)
  })
})
