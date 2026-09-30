import { useState } from 'react'
import type { SessionInfo } from '@anyplane/protocol'
import { removeWorktreeSession, renameSession } from '../lib/api'
import { ConfirmDialog, PromptDialog } from './Dialogs'
import { PopupPanel } from './PopupPanel'

export type SessionMenuAnchor = { session: SessionInfo; anchor: HTMLElement }

export function SessionRowMenu(props: {
  menu: SessionMenuAnchor | null
  onClose: () => void
  onRenamed: () => void
  onArchive: (key: string) => void
  onRemoved: () => void
  showToast: (text: string, kind?: 'ok' | 'err') => void
}) {
  const [renameTarget, setRenameTarget] = useState<SessionMenuAnchor | null>(null)
  const [archiveTarget, setArchiveTarget] = useState<SessionMenuAnchor | null>(null)
  const [wtTarget, setWtTarget] = useState<SessionMenuAnchor | null>(null)
  const [wtDirty, setWtDirty] = useState<{ modified: number; untracked: number } | null>(null)
  const [wtBusy, setWtBusy] = useState(false)

  const doRemoveWorktree = async (cwd: string, force: boolean) => {
    if (wtBusy) return
    setWtBusy(true)
    try {
      const r = await removeWorktreeSession(cwd, force)
      if (r.ok) {
        props.showToast('已移除 worktree（分支保留）', 'ok')
        setWtTarget(null)
        setWtDirty(null)
        props.onRemoved()
        return
      }
      // dirty 两步走：409 附脏区统计 → 同框升级为「确认丢弃」第二步
      if (r.status === 409 && r.dirty) {
        setWtDirty(r.dirty)
      } else {
        props.showToast(r.error)
        setWtTarget(null)
        setWtDirty(null)
      }
    } finally {
      setWtBusy(false)
    }
  }

  return (
    <>
      <PopupPanel
        open={props.menu !== null}
        anchor={props.menu?.anchor ?? null}
        onClose={props.onClose}
        placement="bottom-end"
        offset={4}
        className="w-32"
      >
        <button
          type="button"
          role="menuitem"
          className="flex w-full items-center gap-2 rounded-[10px] px-3 py-2 text-left text-[12px] text-muted transition-colors hover:bg-surface hover:text-ink"
          onClick={() => {
            if (!props.menu) return
            setRenameTarget(props.menu)
            props.onClose()
          }}
        >
          重命名
        </button>
        {props.menu?.session.worktreeOf && props.menu.session.dirExists !== false && (
          <button
            type="button"
            role="menuitem"
            className="flex w-full items-center gap-2 rounded-[10px] px-3 py-2 text-left text-[12px] text-muted transition-colors hover:bg-surface hover:text-accent"
            onClick={() => {
              if (!props.menu) return
              setWtDirty(null)
              setWtTarget(props.menu)
              props.onClose()
            }}
          >
            移除 worktree
          </button>
        )}
        <button
          type="button"
          role="menuitem"
          className="flex w-full items-center gap-2 rounded-[10px] px-3 py-2 text-left text-[12px] text-muted transition-colors hover:bg-surface hover:text-accent"
          onClick={() => {
            if (!props.menu) return
            setArchiveTarget(props.menu)
            props.onClose()
          }}
        >
          回收站
        </button>
      </PopupPanel>

      <PromptDialog
        open={renameTarget !== null}
        anchor={renameTarget?.anchor ?? null}
        title="重命名会话"
        initialValue={renameTarget?.session.title ?? renameTarget?.session.sessionId.slice(0, 8) ?? ''}
        onConfirm={(title) => {
          if (!renameTarget) return
          if (title.trim()) {
            renameSession(renameTarget.session.key, title.trim())
              .then(() => {
                props.onRenamed()
                props.showToast('已重命名', 'ok')
              })
              .catch((err) => props.showToast(String(err)))
          }
          setRenameTarget(null)
        }}
        onClose={() => setRenameTarget(null)}
      />

      <ConfirmDialog
        open={archiveTarget !== null}
        anchor={archiveTarget?.anchor ?? null}
        title="归档会话"
        message={`归档会话「${archiveTarget?.session.title ?? archiveTarget?.session.sessionId.slice(0, 8)}」？\n（进入回收站，随时可恢复）`}
        confirmLabel="归档"
        danger
        onConfirm={() => {
          if (!archiveTarget) return
          props.onArchive(archiveTarget.session.key)
          setArchiveTarget(null)
        }}
        onClose={() => setArchiveTarget(null)}
      />

      <ConfirmDialog
        open={wtTarget !== null}
        anchor={wtTarget?.anchor ?? null}
        title="移除 worktree"
        message={
          wtDirty
            ? `该 worktree 有未提交改动（${wtDirty.modified} 个已修改 / ${wtDirty.untracked} 个未跟踪）。\n丢弃这些改动并强制移除？（分支保留，不删除）`
            : `移除 worktree 目录「${wtTarget?.session.cwd}」？\n（会话进程会被中断，分支保留不删除）`
        }
        confirmLabel={wtDirty ? '丢弃改动并移除' : '移除'}
        danger
        onConfirm={() => {
          if (!wtTarget?.session.cwd) return
          void doRemoveWorktree(wtTarget.session.cwd, wtDirty !== null)
        }}
        onClose={() => {
          if (wtBusy) return
          setWtTarget(null)
          setWtDirty(null)
        }}
      />
    </>
  )
}
