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

  const selectCls =
    'rounded border border-line bg-surface2 px-1.5 py-1 font-mono text-[11px] text-ink outline-none focus:border-accent/60'

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-line bg-surface px-3 py-1.5">
      <label className="flex items-center gap-1.5 font-mono text-[11px] tracking-wide text-muted">
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

      <label className="flex items-center gap-1.5 font-mono text-[11px] tracking-wide text-muted">
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

      <label className="flex items-center gap-1.5 font-mono text-[11px] tracking-wide text-muted">
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
        className="ml-auto rounded border border-danger/60 px-3 py-1 font-mono text-[11px] text-danger hover:bg-danger/10 disabled:opacity-30"
        disabled={!props.busy}
        onClick={() => sock()?.send({ kind: 'control', subtype: 'interrupt' })}
      >
        ■ 中断
      </button>
    </div>
  )
}
