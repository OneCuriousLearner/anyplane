import { useEffect, useState } from 'react'
import type { BackendStatus, BackendsStatus } from '@anyplane/protocol'
import { fetchBackendsStatus } from '../lib/api'
import { ClaudeMark } from './ClaudeMark'
import { CodexMark } from './CodexMark'

/** 未装/未登录的修复指引：状态卡 metaOf 与 DirPicker 警示共用唯一文案源（改指引只改这里） */
export function backendFixHint(s: BackendStatus, backend: 'claude' | 'codex'): string | undefined {
  if (s.state === 'not-installed') {
    return backend === 'claude' ? 'npm i -g @anthropic-ai/claude-code' : 'npm i -g @openai/codex'
  }
  if (s.state === 'not-logged-in') {
    return backend === 'claude'
      ? '终端运行 claude auth login，或配置 ANTHROPIC_API_KEY / 网关 token'
      : '终端运行 codex login，或在 ~/.codex/config.toml 配置自定义 provider'
  }
  return undefined
}

/** 各登录态的展示：点色、主文案、（可选）修复指引 */
function metaOf(s: BackendStatus, backend: 'claude' | 'codex'): {
  dot: string
  label: string
  hint?: string
} {
  switch (s.state) {
    case 'subscription':
      return { dot: 'bg-ok', label: `已登录（订阅）${s.detail ? ` · ${s.detail}` : ''}` }
    case 'api-key':
      return { dot: 'bg-ok', label: '已登录（API key）' }
    case 'token':
      return { dot: 'bg-ok', label: `已登录（Token）${s.detail ? ` · ${s.detail}` : ''}` }
    case 'third-party':
      return { dot: 'bg-ok', label: `已登录（${s.detail ?? '三方通道'}）` }
    case 'custom-provider':
      return { dot: 'bg-ok', label: '自定义 Provider（API-key 组织用户）' }
    case 'not-logged-in':
      return { dot: 'bg-accent', label: '未登录', hint: backendFixHint(s, backend) }
    case 'not-installed':
      return { dot: 'bg-faint', label: '未安装', hint: backendFixHint(s, backend) }
    case 'unknown':
      return { dot: 'bg-faint', label: '状态未知', hint: s.error }
  }
}

function BackendRow(props: { backend: 'claude' | 'codex'; status: BackendStatus }) {
  const m = metaOf(props.status, props.backend)
  return (
    <div className="flex items-start gap-2.5 py-1.5">
      <span className="mt-0.5 flex h-[15px] w-[15px] shrink-0 items-center justify-center overflow-hidden" aria-hidden>
        {props.backend === 'codex' ? <CodexMark size={15} static /> : <ClaudeMark className="h-[15px] w-[15px]" />}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="text-[13px] font-medium">{props.backend === 'codex' ? 'Codex' : 'Claude'}</span>
          <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${m.dot}`} aria-hidden />
          <span className="truncate font-mono text-[11px] text-muted">{m.label}</span>
        </div>
        {m.hint && <div className="mt-0.5 font-mono text-[10px] leading-snug text-faint">{m.hint}</div>}
      </div>
    </div>
  )
}

/**
 * 双后端登录状态卡（会话列表顶部）：首次上手时回答「该去登录哪个」。
 * 数据 60s 服务端缓存；组件 60s 轮询 + 窗口聚焦时重取（在另一终端登录后回来即刷新）。
 *
 * 自决可见性：双后端都可用时不占版面（alwaysShow 除外——空列表的首次上手场景）；
 * 数据到达前不渲染，避免「探测中…」占位闪烁与布局跳动。
 */
export function BackendStatusCard(props: { alwaysShow?: boolean }) {
  const [status, setStatus] = useState<BackendsStatus | null>(null)

  useEffect(() => {
    let alive = true
    const load = () => {
      fetchBackendsStatus()
        .then((s) => alive && setStatus(s))
        .catch(() => {}) // 401 由令牌门接管；瞬时失败等下一轮
    }
    load()
    const t = setInterval(load, 60_000)
    const onFocus = () => load()
    window.addEventListener('focus', onFocus)
    return () => {
      alive = false
      clearInterval(t)
      window.removeEventListener('focus', onFocus)
    }
  }, [])

  if (!status) return null
  const attention = backendNeedsAttention(status.claude) || backendNeedsAttention(status.codex)
  if (!attention && !props.alwaysShow) return null
  return (
    <div className="mx-1 mb-2 rounded-[14px] bg-surface px-3 py-1.5">
      <BackendRow backend="claude" status={status.claude} />
      <div className="border-t border-line" aria-hidden />
      <BackendRow backend="codex" status={status.codex} />
    </div>
  )
}

/** 某后端是否需要用户介入（未装/未登录）——卡片可见性与 DirPicker 警示共用同一口径 */
export function backendNeedsAttention(s: BackendStatus | undefined): boolean {
  return s?.state === 'not-logged-in' || s?.state === 'not-installed'
}
