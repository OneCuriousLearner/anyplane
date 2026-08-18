// 后端注册表：按 sessionKey 前缀分发。

import { claudeBackend } from './claude/backend'
import { codexBackend, isCodexKey } from './codex/backend'

export function backendForKey(key: string) {
  if (isCodexKey(key)) return codexBackend
  return claudeBackend
}

export function allBackends() {
  return [claudeBackend, codexBackend]
}
