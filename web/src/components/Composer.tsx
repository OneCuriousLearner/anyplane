// 输入区：悬浮磨砂圆角块（斜杠命令面板 / 发送方式切换 / 图片预览 / textarea /
// 模型胶囊 ×2 / 上下文环 / 添加图片 / 发送·中断按钮）。
// F2 从 pages/Chat.tsx 切出——斜杠面板全套状态（slashIdx/滚动跟随/键盘导航）、
// 输入框自适应高度、图片挑选均随 JSX 下沉为组件内部实现；codex 模型目录的派生
//（codexCfg/codexModelId/codexEffortLevels/codexModeOf）也一并内聚进来。

import { useEffect, useRef, useState } from 'react'
import { resolveModel, type CodexModelInfo, type ServerConfigInfo, type TierModelName } from '../lib/api'
import { COMMAND_DESC, filterSlashHints, mergeSlashCommands, type SlashEntry } from '../lib/slashCommands'
import type { SessionState } from '../lib/ws'
import { ContextRing } from './ContextRing'
import { StatusPill } from './StatusPill'

/** claude 权限模式名 → codex 预设档位（显示用） */
function codexModeOf(m?: string): string {
  switch (m) {
    case 'bypassPermissions':
      return 'fullAccess'
    case 'acceptEdits':
    case 'auto':
      return 'workspaceAuto'
    case 'plan':
      return 'readOnly'
    case 'readOnly':
    case 'workspace':
    case 'workspaceAuto':
    case 'fullAccess':
      return m
    default:
      return 'workspace'
  }
}

export interface PendingImage {
  name: string
  mediaType: string
  dataBase64: string
}

/** 预览 src：dataURL 与传输用 base64 本是一份数据，渲染时派生 */
export function imgPreviewSrc(img: { mediaType: string; dataBase64: string }): string {
  return `data:${img.mediaType};base64,${img.dataBase64}`
}

export function Composer(props: {
  input: string
  onInputChange: (v: string) => void
  busy: boolean
  connected: boolean
  sendMode: 'steer' | 'queue'
  onSendModeChange: (m: 'steer' | 'queue') => void
  isCodex: boolean
  pendingImages: PendingImage[]
  onPendingImagesChange: React.Dispatch<React.SetStateAction<PendingImage[]>>
  onSend: () => void
  onInterrupt: () => void
  atBottom: boolean
  onScrollToBottom: () => void
  /** 斜杠命令清单来源：status 的 slashCommands 优先，init 消息的命令名兜底 */
  slashCommands?: SessionState['slashCommands']
  initSlashCommands?: string[]
  // --- claude StatusPill ---
  cfg?: ServerConfigInfo
  claudeModel?: string
  permMode?: string
  effort?: string
  modelNames: Record<string, TierModelName> | null
  onPanelOpen: () => void
  onSetClaudeModel: (m: string) => void
  onSetMode: (m: string) => void
  onSetEffort: (e: string) => void
  // --- codex StatusPill ---
  codexModels?: CodexModelInfo[]
  stateModel?: string
  statePermissionMode?: string
  stateEffort?: string
  onSetCodexModel: (m: string) => void
  // --- ContextRing ---
  context?: SessionState['context']
  usage?: SessionState['usage']
  onOpenFullDetail?: () => void
}) {
  const {
    input,
    onInputChange,
    busy,
    connected,
    sendMode,
    onSendModeChange,
    isCodex,
    pendingImages,
    onPendingImagesChange,
    onSend,
    onInterrupt,
    atBottom,
    onScrollToBottom,
    slashCommands,
    initSlashCommands,
    cfg,
    claudeModel,
    permMode,
    effort,
    modelNames,
    onPanelOpen,
    onSetClaudeModel,
    onSetMode,
    onSetEffort,
    codexModels,
    stateModel,
    statePermissionMode,
    stateEffort,
    onSetCodexModel,
    context,
    usage,
    onOpenFullDetail,
  } = props

  const inputRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  // 优先 initialize 握手返回的命令（含描述），其次 init 消息的命令名，最后空清单（合并层用自有命令兜底）
  const cliEntries: SlashEntry[] = slashCommands?.length
    ? slashCommands.map((c) => ({ name: c.name, desc: c.description }))
    : (initSlashCommands ?? []).map((n) => ({ name: n, desc: COMMAND_DESC[n] }))
  // anyplane 自有命令置顶（中文描述优先于 CLI 同名命令），其后是 CLI 报告的完整清单
  const allEntries = mergeSlashCommands(cliEntries)
  const slashHints = filterSlashHints(input, allEntries)
  // 键盘导航：↑↓ 移动，Tab/Enter 采纳，Esc 关闭（索引随清单变化钳位）
  const [slashIdx, setSlashIdx] = useState(0)
  const slashActive = slashHints.length > 0 ? Math.min(slashIdx, slashHints.length - 1) : 0
  /** 面板滚动容器：键盘导航时保证高亮行在视口内 */
  const slashScrollRef = useRef<HTMLDivElement>(null)

  // 高亮行跟随滚动：只滚面板容器（getBoundingClientRect 相对数学），不动页面滚动条
  useEffect(() => {
    const c = slashScrollRef.current
    if (!c || slashHints.length === 0) return
    const row = c.querySelectorAll('button')[slashActive]
    if (!row) return
    const cRect = c.getBoundingClientRect()
    const rRect = row.getBoundingClientRect()
    if (rRect.top < cRect.top) c.scrollTop -= cRect.top - rRect.top
    else if (rRect.bottom > cRect.bottom) c.scrollTop += rRect.bottom - cRect.bottom
  }, [slashActive, slashHints.length])

  // 输入框自适应高度：随内容增长，超过 200px 后不再扩大、内部滚动。
  // 注意 border-box：style.height 包含边框，需补回上下边框宽，否则单行时内容被裁出滚动条
  useEffect(() => {
    const el = inputRef.current
    if (!el) return
    el.style.height = 'auto'
    const h = el.scrollHeight + (el.offsetHeight - el.clientHeight)
    el.style.height = `${Math.min(h, 200)}px`
    el.style.overflowY = h > 200 ? 'auto' : 'hidden'
  }, [input])

  const pickImages = (files: FileList | null) => {
    if (!files) return
    for (const f of Array.from(files)) {
      if (!f.type.startsWith('image/')) continue
      const reader = new FileReader()
      reader.onload = () => {
        const url = String(reader.result ?? '')
        const comma = url.indexOf(',')
        if (comma < 0) return
        onPendingImagesChange((prev) => [
          ...prev,
          { name: f.name, mediaType: f.type, dataBase64: url.slice(comma + 1) },
        ])
      }
      reader.readAsDataURL(f)
    }
  }

  // codex 模型目录派生（model/list）：模型/effort 档位/默认值
  const codexDefaultModel = codexModels?.find((m) => m.isDefault) ?? codexModels?.[0]
  const codexModelId = stateModel ?? codexDefaultModel?.id
  const codexCurrentModel = codexModels?.find((m) => m.id === codexModelId) ?? codexDefaultModel
  const codexEffortLevels: readonly string[] = codexCurrentModel?.efforts.map((e) => e.value) ?? ['low', 'high', 'max']
  const codexCfg: ServerConfigInfo = {
    permissionPolicy: 'ask',
    permissionModes: ['readOnly', 'workspace', 'workspaceAuto', 'fullAccess'],
    effortLevels: [...codexEffortLevels],
    models: (codexModels ?? []).map((m) => m.id),
  }

  return (
    <div className="absolute inset-x-0 bottom-0 z-30 px-3 pb-3 pt-2">
      <div className="mx-auto max-w-3xl">
        {slashHints.length > 0 && (
          <div className="mb-2 rounded-[14px] bg-surface2/85 p-1 shadow-[0_16px_40px_-12px_rgba(0,0,0,0.5)] backdrop-blur-xl">
            {/* 完整清单可滚动（CLI initialize 握手报告多少就列多少），自有命令置顶；键盘导航时高亮行跟随滚动 */}
            <div ref={slashScrollRef} className="max-h-60 overflow-y-auto">
              {slashHints.map((c, i) => (
                <button
                  key={c.name}
                  className={`flex w-full items-center gap-2 rounded-[10px] px-2.5 py-1.5 text-left ${
                    i === slashActive ? 'bg-surface' : 'hover:bg-surface'
                  }`}
                  onMouseEnter={() => setSlashIdx(i)}
                  onClick={() => {
                    onInputChange(`/${c.name} `)
                    setSlashIdx(0)
                    inputRef.current?.focus()
                  }}
                >
                  <span className="font-mono text-[12px] text-ink">/{c.name}</span>
                  {c.desc && <span className="truncate text-xs text-faint">{c.desc}</span>}
                </button>
              ))}
            </div>
            <div className="px-2.5 py-1 font-mono text-[9px] tracking-wide text-faint">
              {slashHints.length} 个命令 · ↑↓ 移动 · Tab 补全
              {input.trim() === '/' && ' · 继续输入可过滤'}
            </div>
          </div>
        )}
        <div className="relative">
          {/* ↓ 与输入块同列、贴在正上方；不放进磨砂块内，否则 backdrop 只能糊到父级内部 */}
          {!atBottom && (
            <button
              className="absolute bottom-full right-0 z-40 mb-2 grid h-9 w-9 place-items-center rounded-full bg-surface2/85 text-ink shadow-lg backdrop-blur-xl hover:bg-surface2"
              onClick={onScrollToBottom}
              title="回到底部"
              aria-label="回到底部"
            >
              ↓
            </button>
          )}
          <div className="rounded-[14px] bg-surface2/80 px-3 pb-2 pt-2.5 shadow-[0_16px_40px_-12px_rgba(0,0,0,0.5)] backdrop-blur-xl">
          {/* busy 时发送方式：插队（steer，下一边界被模型看到）/ 排队（queue，当前轮结束后） */}
          {busy && (
            <div className="mb-1.5 flex items-center gap-1.5 font-mono text-[10px]">
              <span className="text-faint">工作中，发送：</span>
              {(['steer', 'queue'] as const).map((m) => (
                <button
                  key={m}
                  className={`rounded-full px-2.5 py-0.5 ${
                    sendMode === m ? 'bg-surface text-ink' : 'text-faint hover:text-muted'
                  }`}
                  onClick={() => onSendModeChange(m)}
                >
                  {m === 'steer' ? '插队' : '排队'}
                </button>
              ))}
              <span className="text-faint/70">
                {sendMode === 'steer'
                  ? isCodex
                    ? '追加进当前轮'
                    : '打断当前并立即处理'
                  : '当前轮结束后自动开始'}
              </span>
            </div>
          )}
          {/* 待发送图片预览 */}
          {pendingImages.length > 0 && (
            <div className="mb-2 flex flex-wrap gap-2">
              {pendingImages.map((img, i) => (
                <span key={i} className="relative">
                  <img src={imgPreviewSrc(img)} alt={img.name} className="h-14 w-14 rounded-[10px] object-cover" />
                  <button
                    className="absolute -right-1.5 -top-1.5 grid h-4 w-4 place-items-center rounded-full bg-accent text-[9px] leading-none text-white"
                    onClick={() => onPendingImagesChange((prev) => prev.filter((_, j) => j !== i))}
                  >
                    ✕
                  </button>
                </span>
              ))}
            </div>
          )}
          <input
            ref={fileInputRef}
            type="file"
            accept="image/jpeg,image/png,image/gif,image/webp"
            multiple
            className="hidden"
            onChange={(e) => {
              pickImages(e.target.files)
              e.target.value = ''
            }}
          />
          <textarea
            ref={inputRef}
            className="max-h-[200px] min-h-[1.5rem] w-full resize-none overflow-hidden bg-transparent px-1 text-[15px] leading-snug text-ink outline-none placeholder:text-faint"
            rows={1}
            placeholder={busy ? '工作中…' : 'ᕕ( ◠ڼ◠ )ᕗ'}
            value={input}
            onChange={(e) => {
              onInputChange(e.target.value)
              setSlashIdx(0)
            }}
            onKeyDown={(e) => {
              // 斜杠命令面板打开时的键盘导航
              if (slashHints.length > 0) {
                if (e.key === 'ArrowDown') {
                  e.preventDefault()
                  setSlashIdx((i) => Math.min(i + 1, slashHints.length - 1))
                  return
                }
                if (e.key === 'ArrowUp') {
                  e.preventDefault()
                  setSlashIdx((i) => Math.max(i - 1, 0))
                  return
                }
                if (e.key === 'Tab') {
                  e.preventDefault()
                  onInputChange(`/${slashHints[slashActive].name} `)
                  setSlashIdx(0)
                  return
                }
                if (e.key === 'Escape') {
                  e.preventDefault()
                  onInputChange('')
                  setSlashIdx(0)
                  return
                }
              }
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault()
                // 输入还是高亮命令的真前缀时先补全不发送；完整命令名（如 /compact）才直接发送
                const trimmed = input.trim()
                const active = slashHints[slashActive]
                if (slashHints.length > 0 && active && `/${active.name}` !== trimmed) {
                  onInputChange(`/${active.name} `)
                  setSlashIdx(0)
                  return
                }
                onSend()
              }
            }}
          />
          <div className="mt-1 flex min-w-0 items-center gap-1.5">
            <div className="min-w-0 flex-1">
            {cfg && !isCodex && (
              <StatusPill
                cfg={cfg}
                model={claudeModel}
                permissionMode={permMode}
                effort={effort}
                modelNames={modelNames}
                onPanelOpen={onPanelOpen}
                onSetModel={onSetClaudeModel}
                onSetMode={onSetMode}
                onSetEffort={onSetEffort}
              />
            )}
            {isCodex && codexModels && codexModels.length > 0 && (
              <StatusPill
                cfg={codexCfg}
                model={codexModelId}
                permissionMode={codexModeOf(permMode ?? statePermissionMode)}
                effort={effort ?? stateEffort ?? codexCurrentModel?.defaultEffort}
                effortLevels={codexEffortLevels}
                onSetModel={onSetCodexModel}
                onSetMode={onSetMode}
                onSetEffort={onSetEffort}
              />
            )}
            </div>
            {/* 上下文窗口占用环：首个 API 应答/首个 turn 前（state.context 缺省）不渲染 */}
            <ContextRing
              backend={isCodex ? 'codex' : 'claude'}
              context={context}
              usage={usage}
              modelLabel={
                isCodex
                  ? (codexCurrentModel?.label ?? codexModelId)
                  : claudeModel == null
                    ? undefined
                    : resolveModel(modelNames, claudeModel).label
              }
              onOpenFullDetail={onOpenFullDetail}
            />
            <button
              type="button"
              className="grid h-8 w-8 shrink-0 place-items-center rounded-full text-muted transition-colors hover:bg-surface hover:text-ink"
              title="添加图片（jpg/png/gif/webp，≤5MB）"
              aria-label="添加图片"
              onClick={() => fileInputRef.current?.click()}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4" aria-hidden="true">
                <rect x="3" y="3" width="18" height="18" rx="2" />
                <circle cx="8.5" cy="8.5" r="1.5" />
                <path d="m21 15-5-5L5 21" />
              </svg>
            </button>
            {busy ? (
              <button
                type="button"
                className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-accent text-white transition-opacity hover:opacity-85"
                onClick={onInterrupt}
                title="中断当前回合"
                aria-label="中断当前回合"
              >
                <svg viewBox="0 0 24 24" fill="currentColor" className="h-4 w-4" aria-hidden="true">
                  <rect x="5" y="5" width="14" height="14" rx="3" />
                </svg>
              </button>
            ) : (
              <button
                type="button"
                className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-ink text-bg transition-opacity hover:opacity-85 disabled:pointer-events-none disabled:opacity-25"
                disabled={(!input.trim() && pendingImages.length === 0) || !connected}
                onClick={onSend}
                title="发送"
                aria-label="发送"
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4" aria-hidden="true">
                  <path d="M12 19V5" />
                  <path d="m5 12 7-7 7 7" />
                </svg>
              </button>
            )}
          </div>
          </div>
        </div>
      </div>
    </div>
  )
}
