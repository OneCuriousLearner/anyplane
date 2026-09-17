// 原生壳通知状态横幅：权限未授予/桥异常/原生服务缺失时给出可操作出口。
// 实机教训：POST_NOTIFICATIONS 被拒后整条通知链零可见迹象，静默死是最坏形态。
import { useState, useSyncExternalStore } from 'react'
import {
  getNativeBridgeStatus,
  requestNativeNotificationPermission,
  subscribeNativeBridge,
} from '../lib/nativeBridge'

export function NativeNotifyBanner() {
  const status = useSyncExternalStore(subscribeNativeBridge, getNativeBridgeStatus)
  const [working, setWorking] = useState(false)
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
        disabled={working}
        onClick={() => {
          setWorking(true)
          void requestNativeNotificationPermission().finally(() => setWorking(false))
        }}
        className="mx-3 mt-2 block w-[calc(100%-1.5rem)] rounded-[12px] bg-surface2/80 px-3.5 py-2.5 text-left text-[12px] leading-snug text-ink disabled:opacity-60"
      >
        <span className="mr-1.5 inline-block h-1.5 w-1.5 rounded-full bg-accent align-middle" aria-hidden />
        {working ? '正在处理…' : '通知权限未授予：锁屏/切走后收不到审批通知。'}
        {!working && <span className="ml-1 font-medium underline underline-offset-2">去开启</span>}
      </button>
    )
  }

  // 权限已授予但原生常驻服务没起来（configure 失败落兼容模式）：Android 上锁屏通知不可靠
  if (status.platform === 'android' && status.service === 'js-fallback') {
    return (
      <div className="mx-3 mt-2 rounded-[12px] bg-surface2/80 px-3.5 py-2.5 text-[12px] leading-snug text-ink">
        原生常驻服务未启动，已退回兼容模式：锁屏通知可能不可靠。请彻底关闭应用重进一次。
      </div>
    )
  }

  return null
}
