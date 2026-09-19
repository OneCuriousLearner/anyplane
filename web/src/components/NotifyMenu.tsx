import { createPortal } from 'react-dom'

function NotifyRow(props: { on: boolean; title: string; desc: string; action?: string }) {
  return (
    <>
      <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${props.on ? 'bg-ok' : 'bg-faint'}`} />
      <span className="min-w-0 flex-1">
        <span className="block font-mono text-[11px] text-ink">{props.title}</span>
        <span className="block text-[10px] leading-snug text-faint">{props.desc}</span>
      </span>
      {props.action && <span className="font-mono text-[10px] text-faint">{props.action}</span>}
    </>
  )
}

export function NotifyMenu(props: {
  open: boolean
  onClose: () => void
  notify: boolean
  onToggleNotify: () => void
  pushSupported: boolean
  pushEndpoint: string | null
  pushBusy: boolean
  onTogglePush: () => void
  nativeAndroid: boolean
  onBattery: () => void
  pushWebhooks: number
  pushTestBusy: boolean
  onTestPush: () => void
}) {
  if (!props.open) return null
  return createPortal(
    <>
      <div className="fixed inset-0 z-40" onClick={props.onClose} />
      <div className="fixed left-2 right-2 top-2 z-50 mx-auto max-w-sm rounded-[14px] bg-surface2/85 p-2 shadow-[0_16px_40px_-12px_rgba(0,0,0,0.5)] backdrop-blur-xl">
        <div className="px-1 pb-1.5 font-mono text-[10px] tracking-widest text-faint uppercase">
          通知
        </div>
        <button type="button"
          className="flex w-full items-center gap-2 rounded-[10px] px-1.5 py-1.5 text-left hover:bg-surface"
          onClick={props.onToggleNotify}
        >
          <NotifyRow
            on={props.notify}
            title="页内通知"
            desc="页面在后台时弹桌面通知"
            action={props.notify ? '开' : '关'}
          />
        </button>
        <button type="button"
          className="flex w-full items-center gap-2 rounded-[10px] px-1.5 py-1.5 text-left hover:bg-surface disabled:opacity-50"
          onClick={props.onTogglePush}
          disabled={props.pushBusy || !props.pushSupported}
        >
          <NotifyRow
            on={!!props.pushEndpoint}
            title={props.pushBusy ? '处理中…' : '推送通知'}
            desc={
              props.pushSupported
                ? props.pushEndpoint
                  ? '已订阅：锁屏可达，通知上可直接审批'
                  : '锁屏/杀掉页面也能收到，通知上可直接审批'
                : '当前浏览器不支持（iOS 需先加到主屏幕）'
            }
            action={props.pushSupported ? (props.pushEndpoint ? '退订' : '订阅') : undefined}
          />
        </button>
        {props.nativeAndroid && (
          <button
            type="button"
            className="flex w-full items-center gap-2 rounded-[10px] px-1.5 py-1.5 text-left hover:bg-surface"
            onClick={props.onBattery}
          >
            <NotifyRow
              on={false}
              title="后台保活"
              desc="常驻通知频繁「重连中」时：点此关闭电池优化"
              action="去设置"
            />
          </button>
        )}
        <div className="flex w-full items-center gap-2 rounded-[10px] px-1.5 py-1.5">
          <NotifyRow
            on={props.pushWebhooks > 0}
            title="Webhook 通道"
            desc={
              props.pushWebhooks > 0
                ? `已配置 ${props.pushWebhooks} 个（ntfy/Bark/Server酱）`
                : '国内 Android 无 FCM 的出路，见 README 配置'
            }
            action={props.pushWebhooks > 0 ? `${props.pushWebhooks}` : undefined}
          />
        </div>
        <button type="button"
          className="flex w-full items-center gap-2 rounded-[10px] px-1.5 py-1.5 text-left hover:bg-surface disabled:opacity-50"
          onClick={props.onTestPush}
          disabled={props.pushTestBusy}
        >
          <NotifyRow
            on={false}
            title={props.pushTestBusy ? '发送中…' : '测试通知'}
            desc="向全部订阅与 webhook 通道各发一条"
            action="发送"
          />
        </button>
      </div>
    </>,
    document.body,
  )
}
