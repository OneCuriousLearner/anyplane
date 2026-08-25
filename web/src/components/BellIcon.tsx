// 铃铛图标：描边风格，与 StatusPill/头部按钮的 mono 极简风一致
export function BellIcon(props: { className?: string; active?: boolean }) {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={props.className}
      aria-hidden
    >
      {/* 铃身：圆顶 + 两侧垂壁 + 外撇下沿 */}
      <path d="M8 2.2a4.2 4.2 0 0 0-4.2 4.2v3l-1.2 1.9c-.18.3.06.68.42.68h10c.36 0 .6-.39.42-.68l-1.2-1.9v-3A4.2 4.2 0 0 0 8 2.2Z" />
      {/* 铃舌 */}
      <path d="M6.6 13.6a1.5 1.5 0 0 0 2.8 0" />
      {/* 激活时的振动波纹 */}
      {props.active && (
        <>
          <path d="M1.2 4.5c.5-.9 1.2-1.7 2-2.2" opacity="0.7" />
          <path d="M14.8 4.5c-.5-.9-1.2-1.7-2-2.2" opacity="0.7" />
        </>
      )}
    </svg>
  )
}
