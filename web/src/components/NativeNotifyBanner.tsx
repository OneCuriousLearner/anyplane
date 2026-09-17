// 原生壳通知状态横幅：权限未授予/桥异常时给出可操作出口。
// 实机教训：POST_NOTIFICATIONS 被拒后整条通知链零可见迹象，静默死是最坏形态。
import { useSyncExternalStore } from 'react'
import {
  getNativeBridgeStatus,
  requestNativeNotificationPermission,
  subscribeNativeBridge,
} from '../lib/nativeBridge'

export function NativeNotifyBanner() {
  const status = useSyncExternalStore(subscribeNativeBridge, getNativeBridgeStatus)
  if (!status.active) return null

  if (status.error) {
    return (
      <div className="mx-3 mt-2 rounded-[12px] bg-surface2/80 px-3.5 py-2.5 text-[12px] leading-snug text-ink">
        {status.error}
      </div>
    )
  }

  if (status.permission !== 'granted') {
    return (
      <button
        type="button"
        onClick={() => void requestNativeNotificationPermission()}
        className="mx-3 mt-2 block w-[calc(100%-1.5rem)] rounded-[12px] bg-surface2/80 px-3.5 py-2.5 text-left text-[12px] leading-snug text-ink"
      >
        <span className="mr-1.5 inline-block h-1.5 w-1.5 rounded-full bg-accent align-middle" aria-hidden />
        通知权限未授予：锁屏/切走后收不到审批通知。
        <span className="ml-1 font-medium underline underline-offset-2">去开启</span>
      </button>
    )
  }

  return null
}
