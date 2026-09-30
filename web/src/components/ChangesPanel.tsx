// 改动摘要页签（E2）：会话 cwd 的 `git status --porcelain` 渲染——
// 分支摘要 + 改动文件清单按 修改/新增/删除/未跟踪 分组；不渲染真 diff（读 diff 是将来动作）。
// 数据 5s 轮询（与侧栏打开期间同生命周期）；非 git 目录 → available:false，页签隐藏入口。

import { useEffect, useMemo, useState } from 'react'
import { fetchGitStatus, type GitStatusFile, type GitStatusResult } from '../lib/api'

const KIND_META: Record<GitStatusFile['kind'], { label: string; cls: string; order: number }> = {
  modified: { label: '修改', cls: 'text-busy', order: 0 },
  added: { label: '新增', cls: 'text-ok', order: 1 },
  deleted: { label: '删除', cls: 'text-accent', order: 2 },
  untracked: { label: '未跟踪', cls: 'text-faint', order: 3 },
}

function FileRow(props: { f: GitStatusFile }) {
  const m = KIND_META[props.f.kind]
  return (
    <div className="flex items-center gap-2 py-0.5">
      <span className={`w-8 shrink-0 font-mono text-[10px] font-medium ${m.cls}`}>{m.label}</span>
      <span className="truncate font-mono text-[11px] text-muted" title={props.f.path}>
        {props.f.path}
      </span>
    </div>
  )
}

export function ChangesPanel(props: { sessionKey: string }) {
  const [result, setResult] = useState<GitStatusResult | null>(null)
  const [err, setErr] = useState('')

  useEffect(() => {
    let alive = true
    // review 轮：sessionKey 变化先清旧数据——新会话第一帧不闪上一个会话的改动清单
    setResult(null)
    setErr('')
    const load = () => {
      fetchGitStatus(props.sessionKey)
        .then((r) => {
          if (!alive) return
          setResult(r)
          setErr('')
        })
        .catch((e) => alive && setErr(String(e)))
    }
    load()
    const t = setInterval(load, 5_000)
    return () => {
      alive = false
      clearInterval(t)
    }
  }, [props.sessionKey])

  const groups = useMemo(() => {
    if (!result?.available) return []
    const byKind = new Map<GitStatusFile['kind'], GitStatusFile[]>()
    for (const f of result.files) {
      const list = byKind.get(f.kind)
      if (list) list.push(f)
      else byKind.set(f.kind, [f])
    }
    return [...byKind.entries()].sort((a, b) => KIND_META[a[0]].order - KIND_META[b[0]].order)
  }, [result])

  if (err) return <div className="py-8 text-center font-mono text-[11px] text-faint">改动摘要不可用：{err}</div>
  if (!result) return <div className="py-8 text-center font-mono text-[11px] text-faint">读取中…</div>
  if (!result.available) return <div className="py-8 text-center font-mono text-[11px] text-faint">本会话目录不是 git 仓库</div>

  const total = result.files.length
  return (
    <div className="flex flex-1 flex-col gap-2 overflow-y-auto px-3 pb-3">
      <div className="flex items-center gap-2 font-mono text-[11px] text-muted">
        <span className="text-ink">{result.branch ?? '（detached）'}</span>
        <span className="text-faint">·</span>
        <span>
          {total === 0
            ? '工作区干净'
            : `${result.counts.modified} 修改 · ${result.counts.deleted} 删除 · ${result.counts.untracked} 未跟踪`}
        </span>
      </div>
      {total === 0 && <div className="py-8 text-center font-mono text-[11px] text-faint">没有未提交的改动</div>}
      {groups.map(([kind, files]) => (
        <section key={kind}>
          <div className={`mt-1 mb-0.5 font-mono text-[10px] font-medium tracking-wider ${KIND_META[kind].cls}`}>
            {KIND_META[kind].label}（{files.length}）
          </div>
          {files.map((f) => (
            <FileRow key={`${f.xy}:${f.path}`} f={f} />
          ))}
        </section>
      ))}
    </div>
  )
}
