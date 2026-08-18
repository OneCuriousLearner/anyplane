import { useState } from 'react'

/**
 * Codex 结标（OpenAI knot，6 条 ribbon 按 60° 旋转组成）。
 * - active：整体持续旋转（2.8s/圈）
 * - 空闲：点击逆时针旋转 30°（彩蛋，可累积）
 *
 * busy 状态来自服务端翻译的 session_state_changed（thread/status/changed），
 * 与 Claude 侧的权威信号同级可靠。
 */
export function CodexMark(props: {
  active?: boolean
  className?: string
  size?: number
}) {
  const { active = false, className = '', size = 28 } = props
  const [deg, setDeg] = useState(0)

  return (
    <button
      type="button"
      className={`inline-flex shrink-0 appearance-none border-0 bg-transparent p-0 ${
        active ? 'cursor-default' : 'cursor-pointer'
      } ${className}`}
      style={{ width: size, height: size }}
      disabled={active}
      aria-label={active ? 'Codex 工作中' : 'Codex'}
      title={active ? '工作中' : '点我一下？'}
      onClick={() => {
        if (!active) setDeg((d) => d - 30)
      }}
    >
      <span
        className="block h-full w-full transition-transform duration-500 ease-out"
        style={{ transform: `rotate(${deg}deg)` }}
      >
        <svg
          viewBox="0 0 320 320"
          width="100%"
          height="100%"
          aria-hidden="true"
          className={active ? 'codex-mark--active' : ''}
          style={{ color: '#7dd3fc' }}
        >
          <defs>
            <path
              id="codex-ribbon"
              d="M 0 -23 V -32 L 52.5 -2 Q 55.8 0 56 3.5 V 42.7 A 44 44 0 0 1 -24.4 70.5 H -10 A 33.3 33.3 0 0 0 44 46 V 2.3"
            />
          </defs>
          <g transform="translate(160 160) scale(1.77777777778)" fill="currentColor">
            {[0, 60, 120, 180, 240, 300].map((r) => (
              <use key={r} href="#codex-ribbon" transform={`rotate(${r})`} />
            ))}
          </g>
        </svg>
      </span>
    </button>
  )
}
