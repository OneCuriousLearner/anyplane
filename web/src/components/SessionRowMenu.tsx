import { useState } from 'react'
import type { SessionInfo } from '@anyplane/protocol'
import { renameSession } from '../lib/api'
import { ConfirmDialog, PromptDialog } from './Dialogs'
import { PopupPanel } from './PopupPanel'

export type SessionMenuAnchor = { session: SessionInfo; anchor: HTMLElement }

export function SessionRowMenu(props: {
  menu: SessionMenuAnchor | null
  onClose: () => void
  onRenamed: () => void
  onArchive: (key: string) => void
  showToast: (text: string, kind?: 'ok' | 'err') => void
}) {
  const [renameTarget, setRenameTarget] = useState<SessionMenuAnchor | null>(null)
  const [archiveTarget, setArchiveTarget] = useState<SessionMenuAnchor | null>(null)

  return (
    <>
      <PopupPanel
        open={props.menu !== null}
        anchor={props.menu?.anchor ?? null}
        onClose={props.onClose}
        placement="bottom-end"
        offset={4}
        className="w-24"
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
    </>
  )
}
