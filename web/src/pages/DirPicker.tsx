import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { fetchDirList, type DirEntry, type SessionInfo } from '../lib/api'

type NodeState =
  | { status: 'loading' }
  | { status: 'loaded'; entries: DirEntry[] }
  | { status: 'error'; message: string }

/** 根集合在 tree Map 中的 key（与服务端空 path 约定一致） */
const ROOT = ''

const norm = (p: string) => p.replace(/[\\/]+$/, '').toLowerCase()

function baseName(cwd: string): string {
  const parts = cwd.split(/[\\/]/).filter(Boolean)
  return parts[parts.length - 1] ?? cwd
}

export function DirPicker(props: {
  sessions: SessionInfo[]
  onStart: (cwd: string, backend: 'claude' | 'codex') => Promise<void>
  onClose: () => void
}) {
  const [tree, setTree] = useState<Map<string, NodeState>>(new Map())
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [selected, setSelected] = useState('')
  const [backend, setBackend] = useState<'claude' | 'codex'>('claude')
  const [starting, setStarting] = useState(false)
  const [revealing, setRevealing] = useState(false)
  const [notice, setNotice] = useState('')
  const [manualOpen, setManualOpen] = useState(false)
  const [manualCwd, setManualCwd] = useState('')

  const treeRef = useRef(tree)
  treeRef.current = tree
  const scrollRef = useRef<HTMLDivElement>(null)
  /** revealPath 选中后置位，等目标行渲染出来再滚动居中 */
  const needScroll = useRef(false)

  // 最近 5 个目录：按 cwd 分组取最新 mtime，降序
  const recentCwds = useMemo(() => {
    const latest = new Map<string, number>()
    for (const s of props.sessions) {
      if (!s.cwd) continue
      latest.set(s.cwd, Math.max(latest.get(s.cwd) ?? 0, s.mtime))
    }
    return [...latest.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([cwd]) => cwd)
  }, [props.sessions])

  const loadLevel = useCallback(async (path: string): Promise<NodeState> => {
    const cached = treeRef.current.get(path)
    if (cached?.status === 'loaded') return cached
    setTree((prev) => new Map(prev).set(path, { status: 'loading' }))
    let st: NodeState
    try {
      const r = await fetchDirList(path)
      st = { status: 'loaded', entries: r.entries }
    } catch (e) {
      st = { status: 'error', message: e instanceof Error ? e.message : String(e) }
    }
    setTree((prev) => new Map(prev).set(path, st))
    return st
  }, [])

  // 打开即加载根集合
  useEffect(() => {
    loadLevel(ROOT)
  }, [loadLevel])

  // 覆盖层打开期间锁定背景滚动
  useEffect(() => {
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = prev
    }
  }, [])

  // Esc 关闭
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') props.onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // onClose 由父组件内联传入，挂载时注册一次即可
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // revealPath 选中后：树随逐级展开异步渲染，目标行出现即滚动居中
  useEffect(() => {
    if (!needScroll.current || !selected) return
    const el = scrollRef.current?.querySelector(`[data-path="${CSS.escape(selected)}"]`)
    if (el) {
      el.scrollIntoView({ block: 'center' })
      needScroll.current = false
    }
  })

  const toggle = (path: string) => {
    if (!expanded.has(path)) loadLevel(path)
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }

  // 点击最近目录：从根集合逐级前缀匹配、展开并选中目标
  const revealPath = async (cwd: string) => {
    if (revealing) return
    setRevealing(true)
    setNotice('定位中…')
    try {
      const target = norm(cwd)
      let current = ROOT
      for (let depth = 0; depth < 64; depth++) {
        const st = await loadLevel(current)
        if (st.status !== 'loaded') break
        const hit = st.entries.find((e) => {
          const ep = norm(e.path)
          return target === ep || target.startsWith(`${ep}/`) || target.startsWith(`${ep}\\`)
        })
        if (!hit) break
        setExpanded((prev) => new Set(prev).add(hit.path))
        if (norm(hit.path) === target) {
          needScroll.current = true
          setSelected(hit.path)
          setNotice('')
          return
        }
        current = hit.path
      }
      // 目标已删除/无权限：停在最深可达层级
      setNotice('目标目录不可达，已定位到最近可用层级')
      if (current !== ROOT) {
        needScroll.current = true
        setSelected(current)
      }
    } finally {
      setRevealing(false)
    }
  }

  const start = async (cwd: string) => {
    if (!cwd || starting) return
    setStarting(true)
    try {
      await props.onStart(cwd, backend)
    } finally {
      setStarting(false)
    }
  }

  const renderLevel = (path: string, depth: number): ReactNode => {
    const st = tree.get(path)
    const indent = 8 + depth * 16 + 24
    if (!st || st.status === 'loading') {
      return (
        <div className="py-1.5 font-mono text-[11px] text-faint" style={{ paddingLeft: indent }}>
          读取中…
        </div>
      )
    }
    if (st.status === 'error') {
      return (
        <div
          className="flex items-center gap-2 py-1.5 font-mono text-[11px] text-danger"
          style={{ paddingLeft: indent }}
        >
          <span className="truncate">{st.message}</span>
          <button className="shrink-0 text-accent-soft underline" onClick={() => loadLevel(path)}>
            重试
          </button>
        </div>
      )
    }
    if (st.entries.length === 0) {
      return (
        <div className="py-1.5 font-mono text-[11px] text-faint" style={{ paddingLeft: indent }}>
          （无子目录）
        </div>
      )
    }
    return st.entries.map((e) => renderRow(e, depth))
  }

  const renderRow = (e: DirEntry, depth: number): ReactNode => {
    const isOpen = expanded.has(e.path)
    const isSel = selected === e.path
    return (
      <div key={e.path}>
        <div
          data-path={e.path}
          onClick={() => setSelected(e.path)}
          className={`flex cursor-pointer items-center gap-1 border-b border-line/40 py-2 pr-3 text-sm transition-colors hover:bg-surface2/60 ${
            isSel ? 'bg-surface2/80 shadow-[inset_2px_0_0_var(--color-accent)]' : ''
          }`}
          style={{ paddingLeft: 8 + depth * 16 }}
        >
          <button
            className="w-5 shrink-0 text-center font-mono text-xs text-faint hover:text-ink"
            onClick={(ev) => {
              ev.stopPropagation()
              toggle(e.path)
            }}
          >
            {isOpen ? '▾' : '▸'}
          </button>
          <span className="truncate">{e.name}</span>
          {/* 根层快捷项（如 ~）补一行实际路径，盘符名即路径不重复 */}
          {depth === 0 && e.name !== e.path && (
            <span className="truncate font-mono text-[10px] text-faint">{e.path}</span>
          )}
          {isSel && <span className="ml-auto shrink-0 pl-2 text-accent">✓</span>}
        </div>
        {isOpen && renderLevel(e.path, depth + 1)}
      </div>
    )
  }

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-bg text-ink">
      {/* 报头 */}
      <div className="flex items-center justify-between border-b border-line px-4 py-3">
        <h2 className="font-mono text-sm tracking-widest text-muted uppercase">选择项目目录</h2>
        <button
          className="rounded border border-line px-2 py-0.5 font-mono text-xs text-faint hover:text-ink"
          onClick={props.onClose}
        >
          ✕
        </button>
      </div>

      {notice && (
        <div className="border-b border-line bg-surface2/50 px-4 py-2 text-xs text-busy">{notice}</div>
      )}

      {/* 最近目录 */}
      {recentCwds.length > 0 && (
        <div className="border-b border-line px-4 py-3">
          <div className="mb-2 font-mono text-[11px] tracking-wide text-faint">最近目录</div>
          <div className="flex flex-wrap gap-2">
            {recentCwds.map((cwd) => (
              <button
                key={cwd}
                disabled={revealing}
                onClick={() => revealPath(cwd)}
                className="max-w-full rounded border border-line bg-surface px-2.5 py-1.5 text-left hover:border-accent/60 disabled:opacity-50"
              >
                <div className="text-sm">{baseName(cwd)}</div>
                <div className="max-w-56 truncate font-mono text-[10px] text-faint">{cwd}</div>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* 目录树 */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto">
        {renderLevel(ROOT, 0)}
      </div>

      {/* 手动输入兜底 */}
      <div className="border-t border-line">
        <button
          className="flex w-full items-center gap-1 px-4 py-2 font-mono text-[11px] text-faint hover:text-muted"
          onClick={() => setManualOpen(!manualOpen)}
        >
          <span>{manualOpen ? '▾' : '▸'}</span> 手动输入路径
        </button>
        {manualOpen && (
          <div className="flex gap-2 px-4 pb-3">
            <input
              className="flex-1 rounded border border-line bg-bg px-3 py-2 font-mono text-xs outline-none placeholder:text-faint focus:border-accent/60"
              placeholder="项目目录，如 /home/you/proj 或 D:\proj"
              value={manualCwd}
              onChange={(e) => setManualCwd(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && start(manualCwd.trim())}
            />
            <button
              className="rounded bg-accent px-3 text-sm text-bg hover:bg-accent-soft disabled:opacity-40"
              disabled={!manualCwd.trim() || starting}
              onClick={() => start(manualCwd.trim())}
            >
              开始
            </button>
          </div>
        )}
      </div>

      {/* 底部确认栏 */}
      <div className="border-t border-line bg-surface px-4 py-3">
        <div className="mb-2 flex items-center justify-between gap-2">
          <div className="truncate font-mono text-xs text-muted">{selected || '未选择目录'}</div>
          <div className="flex shrink-0 overflow-hidden rounded border border-line font-mono text-[11px]">
            {(['claude', 'codex'] as const).map((b) => (
              <button
                key={b}
                className={`px-2.5 py-1 ${backend === b ? 'bg-accent text-bg' : 'text-faint hover:text-muted'}`}
                onClick={() => setBackend(b)}
              >
                {b === 'claude' ? 'Claude' : 'Codex'}
              </button>
            ))}
          </div>
        </div>
        <button
          className="w-full rounded bg-accent py-2 text-sm font-medium text-bg hover:bg-accent-soft disabled:opacity-40"
          disabled={!selected || starting || revealing}
          onClick={() => start(selected)}
        >
          {starting ? '启动中…' : '在此目录开始'}
        </button>
      </div>
    </div>
  )
}
