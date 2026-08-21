import { useEffect, useRef, useState } from 'react'
import { PopupPanel } from './PopupPanel'

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
          className="w-full rounded border border-line bg-bg px-2 py-1.5 text-xs text-ink outline-none transition-colors focus:border-accent/60"
          placeholder={props.placeholder}
        />
        <div className="mt-2 flex justify-end gap-2">
          <button
            type="button"
            className="rounded px-2 py-1 text-xs text-muted transition-colors hover:text-ink"
            onClick={props.onClose}
          >
            {props.cancelLabel ?? '取消'}
          </button>
          <button
            type="button"
            className="rounded px-2 py-1 text-xs text-accent-soft transition-colors hover:text-accent"
            onClick={() => props.onConfirm(value)}
          >
            {props.confirmLabel ?? '确定'}
          </button>
        </div>
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
        <div className="flex justify-end gap-2">
          <button
            type="button"
            className="rounded px-2 py-1 text-xs text-muted transition-colors hover:text-ink"
            onClick={props.onClose}
          >
            {props.cancelLabel ?? '取消'}
          </button>
          <button
            type="button"
            className={`rounded px-2 py-1 text-xs transition-colors ${
              props.danger ? 'text-danger hover:text-danger/80' : 'text-accent-soft hover:text-accent'
            }`}
            onClick={props.onConfirm}
          >
            {props.confirmLabel ?? '确定'}
          </button>
        </div>
      </div>
    </PopupPanel>
  )
}
