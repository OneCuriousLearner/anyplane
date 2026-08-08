import type { ServerConfigInfo } from '../lib/api'
import type { SessionSocket } from '../lib/ws'

const MODE_LABEL: Record<string, string> = {
  default: '默认',
  acceptEdits: '接受编辑',
  plan: '计划',
  bypassPermissions: '跳过审批',
}

export function ControlsBar(props: {
  cfg: ServerConfigInfo
  sock: () => SessionSocket | undefined
  busy: boolean
}) {
  const { cfg, sock } = props

  const selectCls = 'rounded bg-zinc-800 px-2 py-1 text-xs text-zinc-200 outline-none'

  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-zinc-800 px-3 py-2">
      <label className="flex items-center gap-1 text-xs text-zinc-400">
        模型
        <select
          className={selectCls}
          defaultValue=""
          onChange={(e) => {
            if (e.target.value) sock()?.send({ kind: 'control', subtype: 'set_model', extra: { model: e.target.value } })
          }}
        >
          <option value="" disabled>
            切换…
          </option>
          {cfg.models.map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </select>
      </label>

      <label className="flex items-center gap-1 text-xs text-zinc-400">
        模式
        <select
          className={selectCls}
          defaultValue=""
          onChange={(e) => {
            if (e.target.value)
              sock()?.send({ kind: 'control', subtype: 'set_permission_mode', extra: { mode: e.target.value } })
          }}
        >
          <option value="" disabled>
            切换…
          </option>
          {cfg.permissionModes.map((m) => (
            <option key={m} value={m}>
              {MODE_LABEL[m] ?? m}
            </option>
          ))}
        </select>
      </label>

      <label className="flex items-center gap-1 text-xs text-zinc-400">
        effort
        <select
          className={selectCls}
          defaultValue=""
          onChange={(e) => {
            if (e.target.value)
              sock()?.send({ kind: 'update_env', variables: { CLAUDE_CODE_EFFORT_LEVEL: e.target.value } })
          }}
        >
          <option value="" disabled>
            切换…
          </option>
          {cfg.effortLevels.map((l) => (
            <option key={l} value={l}>
              {l}
            </option>
          ))}
        </select>
      </label>

      <button
        className="ml-auto rounded bg-red-700 px-3 py-1 text-xs hover:bg-red-600 disabled:opacity-40"
        disabled={!props.busy}
        onClick={() => sock()?.send({ kind: 'control', subtype: 'interrupt' })}
      >
        ■ 中断
      </button>
    </div>
  )
}
