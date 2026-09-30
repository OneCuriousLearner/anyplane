// 浮层 Escape 关闭的唯一实现（PopupPanel/DirPicker/SessionList 菜单/DetailDrawer 同款交互——
// 此前四份手写拷贝在监听器目标与依赖口径上已各自漂移）。

import { useEffect } from 'react'

/** Escape 触发 onClose；active=false 时不监听（条件浮层传开关态，恒开浮层省略） */
export function useEscapeClose(onClose: () => void, active = true): void {
  useEffect(() => {
    if (!active) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, active])
}
