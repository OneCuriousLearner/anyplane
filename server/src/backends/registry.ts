// 后端注册表：按 sessionKey 前缀分发。codex（x|/xn|）在阶段 2 接入。

import { claudeBackend } from './claude/backend'

export function backendForKey(key: string) {
  if (key.startsWith('x|') || key.startsWith('xn|')) {
    throw new Error('codex 后端尚未接入')
  }
  return claudeBackend
}

export function allBackends() {
  return [claudeBackend]
}
