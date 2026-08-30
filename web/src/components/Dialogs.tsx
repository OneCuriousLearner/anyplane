import { useEffect, useRef, useState } from 'react'
import { PopupPanel } from './PopupPanel'

/** 弹窗底部按钮行：取消 + 确认（PromptDialog/ConfirmDialog 共用） */
function DialogButtons(props: {
  confirmLabel?: string
  cancelLabel?: string
  danger?: boolean
  className?: string
  onConfirm: () => void
  onClose: () => void
}) {
  return (
    <div className={`flex justify-end gap-2 ${props.className ?? ''}`}>
      <button
        type="button"
        className="rounded-full px-3 py-1.5 text-xs text-muted transition-colors hover:bg-surface hover:text-ink"
        onClick={props.onClose}
      >
        {props.cancelLabel ?? '取消'}
      </button>
      <button
        type="button"
        className={`rounded-full px-3 py-1.5 text-xs transition-colors ${
          props.danger ? 'text-accent hover:bg-accent/10' : 'bg-ink text-bg'
        }`}
        onClick={props.onConfirm}
      >
        {props.confirmLabel ?? '确定'}
      </button>
    </div>
  )
}

/** 文本输入弹窗：替代浏览器 prompt() */
export function PromptDialog(props: {
  open: boolean
  anchor: HTMLElement | null
  title: string
  initialValue?: string
  placeholder?: string
  confirmLabel?: string
  cancelLabel?: string
  onConfirm: (value: string) => void
  onClose: () => void
}) {
  const [value, setValue] = useState(props.initialValue ?? '')
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (props.open) {
      setValue(props.initialValue ?? '')
      // 下一帧聚焦，确保 input 已挂载
      const t = setTimeout(() => inputRef.current?.focus(), 0)
      return () => clearTimeout(t)
    }
  }, [props.open, props.initialValue])

  return (
    <PopupPanel
      open={props.open}
      anchor={props.anchor}
      onClose={props.onClose}
      placement="bottom-end"
      offset={4}
      className="w-56"
    >
      <div className="px-3 py-2">
        <div className="mb-2 text-xs font-medium text-ink">{props.title}</div>
        <input
          ref={inputRef}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') props.onConfirm(value)
            if (e.key === 'Escape') props.onClose()
          }}
          className="w-full rounded-full bg-bg/60 px-3 py-1.5 text-xs text-ink outline-none transition-colors focus:bg-bg"
          placeholder={props.placeholder}
        />
        <DialogButtons
          className="mt-2"
          confirmLabel={props.confirmLabel}
          cancelLabel={props.cancelLabel}
          onConfirm={() => props.onConfirm(value)}
          onClose={props.onClose}
        />
      </div>
    </PopupPanel>
  )
}

/** 确认弹窗：替代浏览器 confirm() */
export function ConfirmDialog(props: {
  open: boolean
  anchor: HTMLElement | null
  title: string
  message: string
  confirmLabel?: string
  cancelLabel?: string
  danger?: boolean
  onConfirm: () => void
  onClose: () => void
}) {
  return (
    <PopupPanel
      open={props.open}
      anchor={props.anchor}
      onClose={props.onClose}
      placement="bottom-end"
      offset={4}
      className="w-64"
    >
      <div className="px-3 py-2">
        <div className="mb-1 text-xs font-medium text-ink">{props.title}</div>
        <div className="mb-3 whitespace-pre-wrap text-[11px] leading-relaxed text-muted">{props.message}</div>
        <DialogButtons
          confirmLabel={props.confirmLabel}
          cancelLabel={props.cancelLabel}
          danger={props.danger}
          onConfirm={props.onConfirm}
          onClose={props.onClose}
        />
      </div>
    </PopupPanel>
  )
}
