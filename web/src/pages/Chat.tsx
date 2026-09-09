import { useEffect, useMemo, useRef, useState } from 'react'
import { createSession, fetchClaudeModelNames, fetchCodexHistory, fetchCodexModels, fetchConfig, fetchHistory, fetchLineage, makeSessionInfo, startHandoff, type CodexModelInfo, type LineageResponse, type ServerConfigInfo, type SessionInfo, type TierModelName } from '../lib/api'
import { SessionSocket } from '../lib/ws'
import { ApprovalCard } from '../components/ApprovalCard'
import { ChatHeader } from '../components/ChatHeader'
import { Composer, imgPreviewSrc } from '../components/Composer'
import { DetailDrawer, type ContextDataLite, type McpServerInfo, type SettingsDataLite } from '../components/DetailDrawer'
import { RewindPicker } from '../components/RewindPicker'
import { Transcript } from '../components/Transcript'
import { TasksPanel } from '../components/TasksPanel'
import { ClaudeStar } from '../components/ClaudeStar'
import { CodexMark } from '../components/CodexMark'
import { buildTranscriptRows, nextId, rewindPreview, usageSummary, type Block, type ChatMsg } from '../lib/blocks'
import { statusLineOf } from '../lib/chatText'
import { interceptSlash, type SlashAction } from '../lib/slashIntercept'
import { isCodexKey, isExistingKey } from '../lib/key'
import { useTaskBuckets } from '../hooks/useTaskBuckets'
import { useTranscriptIngest } from '../hooks/useTranscriptIngest'
import { useSessionSocket, type QueryResultEvent } from '../hooks/useSessionSocket'
import { useTranscriptScroll } from '../hooks/useTranscriptScroll'

export function Chat(props: { session: SessionInfo; onBack: () => void; onNavigate?: (s: SessionInfo) => void }) {
  const { session } = props
  const isCodex = isCodexKey(session.key)
  const isExisting = isExistingKey(session.key)
  const [input, setInput] = useState('')
  const [cfg, setCfg] = useState<ServerConfigInfo>()
  const [showRewind, setShowRewind] = useState(false)
  const [codexModels, setCodexModels] = useState<CodexModelInfo[]>()
  const [lineage, setLineage] = useState<LineageResponse>()
  const [handoffBusy, setHandoffBusy] = useState(false)
  const [sendMode, setSendMode] = useState<'steer' | 'queue'>('steer')
  /** 待发送的图片附件（预览 src 由 mediaType+dataBase64 派生，不单独存储） */
  const [pendingImages, setPendingImages] = useState<
    Array<{ name: string; mediaType: string; dataBase64: string }>
  >([])
  const [detailOpen, setDetailOpen] = useState(false)
  const [detailTitle, setDetailTitle] = useState('')
  const [detailContent, setDetailContent] = useState('加载中…')
  /** claude MCP 面板：mcp_status 的结构化结果（null = 未加载/加载失败，此时看 detailContent） */
  const [mcpServers, setMcpServers] = useState<McpServerInfo[] | null>(null)
  /** claude context 用量结构化结果（get_context_usage） */
  const [contextData, setContextData] = useState<ContextDataLite | null>(null)
  /** claude 设置结构化结果（get_settings） */
  const [settingsData, setSettingsData] = useState<SettingsDataLite | null>(null)
  /** MCP 动作进行中：`${serverName}:${action}` */
  const [mcpBusy, setMcpBusy] = useState<string | null>(null)
  /** 在途 MCP 动作的 query id（query_result 按 id 辨认动作应答与普通查询应答） */
  const pendingMcpActionRef = useRef<string | null>(null)
  const [goalOpen, setGoalOpen] = useState(false)
  const [goalDraft, setGoalDraft] = useState('')
  const [moreOpen, setMoreOpen] = useState(false)
  const querySeq = useRef(0)
  const sockRef = useRef<SessionSocket | undefined>(undefined)
  const scrollRef = useRef<HTMLDivElement>(null)

  // ---------- 后台任务（与主线并行的 agent/task/shell，右侧拉栏展示；task_type 全类型入桶） ----------
  // 桶状态与辅助群已下沉 hooks/useTaskBuckets.ts（F3）：api 为每渲染重建的普通对象——
  // 内部全走 ref/稳定 setState/isCodex（会话内不变），与此前过期闭包语义等价
  const { tasks, tasksOpen, setTasksOpen, api: taskApi } = useTaskBuckets({ isCodex })

  // ---------- 主抄本 ingest（消息/流式草稿/配对索引 + cli 流驱动的会话元数据；F4/F5 下沉 hooks/useTranscriptIngest.ts） ----------
  // api 为每渲染重建的普通对象：内部全走 ref/稳定 setState，过期闭包语义等价
  const { messages, draft, phase, initInfo, permMode, effort, api: ingestApi } = useTranscriptIngest({
    isCodex,
    sockRef,
    taskApi,
  })

  const loadSessionHistory = () =>
    isCodex ? fetchCodexHistory(session.sessionId) : fetchHistory(session.slug, session.sessionId)

  // ---------- 详情查询（query 通道；应答的详情域分发留组合层） ----------
  const runQuery = (query: string, title: string) => {
    querySeq.current += 1
    setDetailTitle(title)
    setDetailContent('加载中…')
    sockRef.current?.send({ kind: 'query', id: `q-${querySeq.current}`, query })
  }

  /** query_result 详情域分发：MCP 动作应答辨认 + 结构化面板（F5 从 WS 分发切出，语义逐字） */
  const onQueryResult = (ev: QueryResultEvent) => {
    // MCP 管理动作应答（按 query id 辨认）：清忙态、给反馈、成功后刷新清单
    if (pendingMcpActionRef.current && ev.id === pendingMcpActionRef.current) {
      pendingMcpActionRef.current = null
      setMcpBusy(null)
      if (ev.ok) {
        ingestApi.pushSystem('✓ MCP 操作完成')
        runQuery('mcp_status', 'MCP 状态')
      } else {
        ingestApi.pushSystem(`⚠ MCP 操作失败: ${ev.error ?? '未知错误'}`, 'error')
      }
      return
    }
    // 始终保留原始 JSON（非结构化 tab 的主视图 + 设置面板的折叠原件）
    const raw = ev.ok
      ? JSON.stringify(ev.data, null, 2).slice(0, 8000)
      : `⚠ ${ev.error ?? '查询失败'}`
    setDetailContent(raw)
    // 按应答形状分发到结构化面板（claude 专属；codex 一律 JSON 直出）。
    // 形状不匹配的 tab 清空对应结构化态，渲染链自然落回 <pre>
    const d = ev.ok && !isCodex ? (ev.data as Record<string, unknown>) : undefined
    setMcpServers(Array.isArray(d?.mcpServers) ? (d.mcpServers as McpServerInfo[]) : null)
    setContextData(
      d && Array.isArray(d.categories) && typeof d.totalTokens === 'number'
        ? (d as unknown as ContextDataLite)
        : null,
    )
    setSettingsData(d && d.applied && Array.isArray(d.sources) ? (d as unknown as SettingsDataLite) : null)
  }

  // codex 模型目录（model/list）：模型/effort 档位/默认值
  useEffect(() => {
    if (!isCodex) return
    fetchCodexModels()
      .then((r) => setCodexModels(r.models))
      .catch(() => {})
  }, [isCodex])

  // 接力链：当前会话参与的血缘记录（仅在链上时显示导航条）
  useEffect(() => {
    setMoreOpen(false)
    setGoalOpen(false)
    setDetailOpen(false)
    setLineage(undefined)
    fetchLineage(session.key)
      // 记录按时间排序一次到位（渲染期不再重复排序）
      .then((r) =>
        setLineage(
          r.records.length > 0
            ? { ...r, records: [...r.records].sort((a, b) => a.at.localeCompare(b.at)) }
            : undefined,
        ),
      )
      .catch(() => {})
  }, [session.key])

  // ---------- 历史加载（切换会话时取消过期请求，避免「卡住不出对话」） ----------
  useEffect(() => {
    let cancelled = false
    ingestApi.reset()
    // Chat 组件在 session 切换时会复用，清掉上一会话的运行时/待启动配置。
    // 新会话的缓存选择会由随后到达的 status 恢复。
    ingestApi.setInitInfo({})
    ingestApi.setPermMode(undefined)
    ingestApi.setEffort(undefined)
    setApprovals([])
    ingestApi.setPhase(undefined)
    taskApi.clear()
    if (!isExisting) return
    loadSessionHistory()
      .then((resp) => {
        if (cancelled) return
        ingestApi.applyHistory(resp)
      })
      .catch((e) => {
        if (!cancelled) ingestApi.pushSystem(`⚠ 加载历史失败: ${e}`, 'error')
      })
    return () => {
      cancelled = true
    }
  }, [session.key])

  // ---------- 会话 WS（连接生命周期 + ServerEvent 分发；F5 下沉 hooks/useSessionSocket.ts） ----------
  // 调用位置即 effect 注册顺序：E3 历史加载（reset 先于建连）必须在 WS effect 之前注册，
  // 故本调用放在 E3 之后——顺序纪律钉死，勿上移。
  const { state, connected, approvals, setApprovals } = useSessionSocket({
    session,
    sockRef,
    ingestApi,
    taskApi,
    loadSessionHistory,
    onNavigate: props.onNavigate,
    onCloseRewind: () => setShowRewind(false),
    onQueryResult,
  })

  /** 当前会话权威 ID：spawn 后以 status 广播为准（/clear 重键、b| 分叉首条消息后的真实 id）；
   *  未 spawn 时只有 s|/x| key 内嵌的才是本会话 id——b| 嵌的是源会话 id，不能误显示 */
  const currentSessionId =
    state.sessionId ??
    (session.key.startsWith('s|') || session.key.startsWith('x|') ? session.sessionId : undefined)

  // ---------- 服务配置（Composer StatusPill 用；与 socket 生命周期无关——原与建连同 effect 同步先后执行，独立后同 commit 按序执行，行为等价） ----------
  useEffect(() => {
    fetchConfig().then(setCfg).catch(() => {})
  }, [session.key])

  // ---------- 发送 ----------

  /** 各档实际配置的模型名（StatusPill 打开时实时拉取；null = 未拉取/失败 → 降级 tier 名） */
  const [modelNames, setModelNames] = useState<Record<string, TierModelName> | null>(null)
  /** claude 专属：开 StatusPill 面板即查当前设置（配置改动即刻反映，无需等会话重启） */
  const loadModelNames = () => {
    if (isCodex) return
    void fetchClaudeModelNames(session.cwd)
      .then(setModelNames)
      .catch(() => {})
  }

  /** MCP 管理动作（claude）：reconnect / toggle。复用 query 通道（带 extra 的带应答控制请求） */
  const mcpAction = (serverName: string, action: 'mcp_reconnect' | 'mcp_toggle', enabled?: boolean) => {
    if (mcpBusy) return
    setMcpBusy(`${serverName}:${action}`)
    querySeq.current += 1
    const id = `q-${querySeq.current}`
    pendingMcpActionRef.current = id
    sockRef.current?.send({
      kind: 'query',
      id,
      query: action,
      extra: { serverName, ...(enabled === undefined ? {} : { enabled }) },
    })
  }

  // ---------- goal 设定/清除：claude 走 /goal 斜杠命令（本地命令，不进模型上下文），codex 走 thread/goal RPC ----------
  const sendGoal = (condition?: string) => {
    if (isCodex) {
      sockRef.current?.send(
        condition
          ? { kind: 'control', subtype: 'set_goal', extra: { objective: condition } }
          : { kind: 'control', subtype: 'clear_goal' },
      )
    } else {
      sockRef.current?.send({ kind: 'user', text: condition ? `/goal ${condition}` : '/goal clear' })
    }
    ingestApi.pushSystem(condition ? `◎ 已设定目标：${condition}` : '◎ 已清除目标')
  }

  // ---------- StatusPill 共享处理器（claude/codex 两个胶囊的 mode/effort 同构；model 因本地回显差异分开） ----------
  const handleSetMode = (m: string) => {
    ingestApi.setPermMode(m)
    sockRef.current?.send({ kind: 'control', subtype: 'set_permission_mode', extra: { mode: m } })
  }
  const handleSetEffort = (e: string) => {
    ingestApi.setEffort(e)
    sockRef.current?.send({ kind: 'update_env', variables: { CLAUDE_CODE_EFFORT_LEVEL: e } })
  }

  /** 斜杠拦截动作的副作用执行器（拦截表本身已数据化下沉 lib/slashIntercept.ts，含判例注释） */
  const runSlashAction = (a: SlashAction) => {
    const sock = sockRef.current
    switch (a.type) {
      case 'openRewind':
        setShowRewind(true)
        return
      case 'btw':
        if (a.question) sock?.send({ kind: 'btw', question: a.question })
        else ingestApi.pushSystem('用法：/btw <问题>')
        return
      case 'branch':
        if (isCodex) ingestApi.pushSystem('Codex 请用「回滚」面板的从此处分叉')
        else sock?.send({ kind: 'branch', ...(a.name ? { name: a.name } : {}) })
        return
      case 'exitHint':
        ingestApi.pushSystem('此命令会终止 CLI 进程。要结束会话请回列表页归档（⌄ 按钮），进程回收由服务端空闲策略处理')
        return
      case 'compact':
        sock?.send({ kind: 'control', subtype: 'compact' })
        return
      case 'context': {
        // codex 无 get_context_usage 对应物；用状态里的累计 token 用量顶一句
        const u = state.usage
        ingestApi.pushSystem(
          u
            ? `◈ 线程累计：in ${u.inputTokens} / out ${u.outputTokens}${u.reasoningTokens ? ` / reasoning ${u.reasoningTokens}` : ''}（窗口占用明细请开「详情」）`
            : '◈ 暂无用量数据（先跑一轮）',
        )
        return
      }
      case 'goal':
        if (a.clear) sendGoal()
        else if (a.condition) sendGoal(a.condition)
        else ingestApi.pushSystem(state.goal ? `◎ 当前目标：${state.goal.condition}` : '用法：/goal <条件>，/goal clear 清除')
        return
      case 'review':
        sock?.send({ kind: 'control', subtype: 'review', ...(a.instructions ? { extra: { instructions: a.instructions } } : {}) })
        ingestApi.pushSystem(a.instructions ? `◈ 审查中：${a.instructions}` : '◈ 审查未提交的改动中…')
        return
      case 'rename':
        if (!a.name) {
          ingestApi.pushSystem('用法：/rename <新名字>')
          return
        }
        sock?.send({ kind: 'control', subtype: 'rename', extra: { name: a.name } })
        ingestApi.pushSystem(`✎ 重命名线程为「${a.name}」`)
        return
      case 'newThread': {
        const cwd = session.cwd
        if (cwd) {
          void createSession(cwd, 'codex').then(({ key }) =>
            props.onNavigate?.(
              makeSessionInfo({ key, slug: 'codex', sessionId: 'new', cwd, backend: 'codex', status: 'offline' }),
            ),
          )
        } else {
          ingestApi.pushSystem('⚠ 未知当前目录，无法新建线程', 'error')
        }
        return
      }
    }
  }

  const send = () => {
    const text = input.trim()
    const sock = sockRef.current
    if ((!text && pendingImages.length === 0) || !sock) return

    // 斜杠命令拦截：表与判例在 lib/slashIntercept.ts（顺序即优先级），命中即拦截并清空输入框。
    // codex 的斜杠命令不会被 app-server 解释（原样进模型上下文），有对应物的必须前端拦截。
    const action = interceptSlash(text, { isCodex })
    if (action) {
      runSlashAction(action)
      setInput('')
      return
    }

    const echoBlocks: Block[] = [
      ...pendingImages.map((img) => ({ kind: 'image' as const, src: imgPreviewSrc(img) })),
      ...(text ? [{ kind: 'text' as const, text }] : []),
    ]
    ingestApi.pushMsg({ id: nextId(), role: 'user', blocks: echoBlocks })
    sock.send({
      kind: 'user',
      text,
      ...(busy ? { sendMode } : {}),
      ...(pendingImages.length > 0 ? { attachments: pendingImages } : {}),
    })
    setInput('')
    setPendingImages([])
  }

  // rewindPreview 会对每条用户消息跑正则解析，只有选择器打开时才计算
  const rewindTargets = useMemo(() => {
    if (!showRewind) return []
    return messages
      .filter((m) => m.role === 'user' && m.id.includes('-') && m.rewindable !== false)
      .map((m) => {
        const rawText = m.blocks
          .filter((block): block is Extract<Block, { kind: 'text' }> => block.kind === 'text')
          .map((block) => block.text)
          .join('\n\n')
        return { uuid: m.id, timestamp: m.timestamp, ...rewindPreview(rawText) }
      })
  }, [showRewind, messages])

  // 渲染行在 Chat 层算：Transcript 保持纯展示，重进/重渲时不重复摊平
  const transcriptRows = useMemo(() => buildTranscriptRows(messages, draft), [messages, draft])

  // 抄本滚动与尾部窗口化（初始定位/门控扩窗/锚定补偿全在 hook 内，约束见文件头注释）
  const { windowStart, atBottom, onScroll, jumpToBottom, expandWindow } = useTranscriptScroll({
    scrollRef,
    rowCount: transcriptRows.length,
    resetKey: session.key,
    followDeps: [messages, approvals, draft],
    streaming: Boolean(draft),
  })
  const visibleRows = useMemo(
    () => transcriptRows.slice(windowStart),
    [transcriptRows, windowStart],
  )

  const busy = state.busy
  const waiting = state.waiting || approvals.length > 0
  const usageLine = usageSummary(state.usage, 'tok ')
  const statusLine = statusLineOf(state, { connected, phase, waiting })

  return (
    <div className="flex h-full min-h-0 bg-bg text-ink">
      <div className="relative min-h-0 min-w-0 flex-1 overflow-clip">
      {/* 消息抄本：占满整个视口，上下各留 ~100px 空区避让悬浮栏 */}
      <div ref={scrollRef} onScroll={onScroll} className="h-full overflow-y-auto">
        <div className="mx-auto max-w-3xl px-[17px] pb-[300px] pt-[84px] md:px-[29px]">
          {/* 窗口化顶部哨兵：还有未挂载的更早行时的入口提示（点击=等价于上翻到顶的扩窗） */}
          {windowStart > 0 && (
            <button
              type="button"
              onClick={expandWindow}
              className="mb-3 w-full rounded-[14px] bg-surface/60 py-2 font-mono text-[11px] tracking-wide text-faint transition-colors hover:bg-surface2 hover:text-muted"
            >
              向上滚动或点此加载更早的消息
            </button>
          )}
          <Transcript rows={visibleRows} draft={draft} />

          {approvals.map((a) => (
            <ApprovalCard
              key={a.requestId}
              approval={a}
              onDecision={(decision) => sockRef.current?.send({ kind: 'approval', requestId: a.requestId, decision })}
            />
          ))}

          {/* 底部 100px 空位上方：后端徽标（忙碌旋转 / 空闲可点彩蛋） */}
          <div className="mt-4 ml-[10px] flex items-center gap-2.5">
            {isCodex ? (
              <CodexMark active={busy || Boolean(draft) || Boolean(phase)} size={28} />
            ) : (
              <ClaudeStar active={busy || Boolean(draft) || Boolean(phase)} size={28} />
            )}
          </div>
        </div>
      </div>

      {/* 顶栏：悬浮磨砂横带 */}
      <ChatHeader
        session={session}
        connected={connected}
        statusLine={statusLine}
        busy={busy}
        phase={phase}
        onBack={props.onBack}
        tasks={tasks}
        tasksOpen={tasksOpen}
        onToggleTasks={() => setTasksOpen((v) => !v)}
        isExisting={isExisting}
        isCodex={isCodex}
        sessionId={state.sessionId}
        currentSessionId={currentSessionId}
        goal={state.goal}
        usageLine={usageLine}
        moreOpen={moreOpen}
        setMoreOpen={setMoreOpen}
        onSystemMessage={ingestApi.pushSystem}
        onToggleDetail={() => {
          setDetailOpen((v) => !v)
          // codex 无 get_context_usage 对应物，默认落在 MCP 状态上
          if (!detailOpen) runQuery(isCodex ? 'mcp_status' : 'get_context_usage', isCodex ? 'MCP 状态' : 'context 用量')
        }}
        goalOpen={goalOpen}
        onToggleGoal={() => {
          setGoalDraft(state.goal?.condition ?? '')
          setGoalOpen((v) => !v)
        }}
        onCloseGoal={() => setGoalOpen(false)}
        goalDraft={goalDraft}
        onGoalDraftChange={setGoalDraft}
        onSendGoal={sendGoal}
        onBranch={() => sockRef.current?.send({ kind: 'branch' })}
        handoffBusy={handoffBusy}
        onHandoff={() => {
          const toBackend = isCodex ? 'claude' : 'codex'
          setHandoffBusy(true)
          startHandoff(session.key, toBackend)
            .catch((e) => ingestApi.pushSystem(`⚠ 接力失败: ${e instanceof Error ? e.message : e}`, 'error'))
            .finally(() => setHandoffBusy(false))
        }}
        lineage={lineage}
        onNavigate={props.onNavigate}
      >
        {/* 会话详情抽屉 */}
        {detailOpen && (
          <DetailDrawer
            detailTitle={detailTitle}
            detailContent={detailContent}
            isCodex={isCodex}
            mcpServers={mcpServers}
            mcpBusy={mcpBusy}
            onMcpAction={mcpAction}
            contextData={contextData}
            settingsData={settingsData}
            modelNames={modelNames}
            onRunQuery={runQuery}
            onClose={() => setDetailOpen(false)}
          />
        )}
      </ChatHeader>

      {showRewind && (
        <RewindPicker
          targets={rewindTargets}
          mode={isCodex ? 'codex' : 'claude'}
          historyMode={state.historyMode}
          onClose={() => setShowRewind(false)}
          onRewindFiles={(uuid) => {
            sockRef.current?.send({ kind: 'control', subtype: 'rewind_files', extra: { user_message_id: uuid } })
            ingestApi.pushSystem('↩ 已请求回滚文件')
            setShowRewind(false)
          }}
          onRewindConversation={(uuid) => {
            sockRef.current?.send({ kind: 'rewind_conversation', userMessageId: uuid })
            setShowRewind(false)
          }}
          onRewindBoth={(uuid) => {
            sockRef.current?.send({ kind: 'rewind_both', userMessageId: uuid })
            setShowRewind(false)
          }}
        />
      )}

      {/* 输入区：悬浮磨砂圆角块；模型胶囊 / 图片 / 发送全收进块内 */}
      <Composer
        input={input}
        onInputChange={setInput}
        busy={busy}
        connected={connected}
        sendMode={sendMode}
        onSendModeChange={setSendMode}
        isCodex={isCodex}
        pendingImages={pendingImages}
        onPendingImagesChange={setPendingImages}
        onSend={send}
        onInterrupt={() => sockRef.current?.send({ kind: 'control', subtype: 'interrupt' })}
        atBottom={atBottom}
        onScrollToBottom={jumpToBottom}
        slashCommands={state.slashCommands}
        initSlashCommands={initInfo.slashCommands}
        cfg={cfg}
        claudeModel={initInfo.model}
        permMode={permMode}
        effort={effort}
        modelNames={modelNames}
        onPanelOpen={loadModelNames}
        onSetClaudeModel={(m) => {
          ingestApi.setInitInfo((prev) => ({ ...prev, model: m }))
          sockRef.current?.send({ kind: 'control', subtype: 'set_model', extra: { model: m } })
        }}
        onSetMode={handleSetMode}
        onSetEffort={handleSetEffort}
        codexModels={codexModels}
        stateModel={state.model}
        statePermissionMode={state.permissionMode}
        stateEffort={state.effort}
        onSetCodexModel={(m) => {
          sockRef.current?.send({ kind: 'control', subtype: 'set_model', extra: { model: m } })
        }}
        context={state.context}
        usage={state.usage}
        onOpenFullDetail={
          !isCodex && isExisting
            ? () => {
                setDetailOpen(true)
                runQuery('get_context_usage', 'context 用量')
              }
            : undefined
        }
      />
      </div>
      <TasksPanel
        open={tasksOpen}
        onClose={() => setTasksOpen(false)}
        tasks={tasks}
        onStop={
          // codex app-server 没有 stop_task 对应物（sendControl 落 default 报错卡），不显示停止按钮
          isCodex
            ? undefined
            : (taskId) => sockRef.current?.send({ kind: 'control', subtype: 'stop_task', extra: { task_id: taskId } })
        }
      />
    </div>
  )
}
