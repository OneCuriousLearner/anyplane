// E2E-回滚：串行覆盖三条路径 —— rewind_files 控制请求 → rewind_conversation → rewind_both
// 三条都打到同一个目标消息（幂等：空恢复快照 + 同一截断点），最后发问验证会话可用。
// 用法：bun run server/scripts/e2e-rewind.ts [cwd] [sessionId]
import { sanitizePath } from '../src/util'
import { apiFetch, connect } from './e2e-lib'

const cwd = process.argv[2] ?? process.cwd()
const slug = sanitizePath(cwd)
const sessionId = process.argv[3] ?? 'ee01d38e-b1f9-4c3d-8110-518aa465cdb0'
const key = `s|${slug}|${sessionId}`

// 从 REST 拿一条用户消息 uuid。取最后一条带文本的用户消息：
// 最早的消息通常早于文件检查点（无快照可恢复），最近的消息最可能有 checkpoint。
const histResp = await apiFetch(`/api/history/${slug}/${sessionId}`)
if (!histResp.ok) {
  console.error(`拉取历史失败（HTTP ${histResp.status}）——服务端配置了 authToken 时需 ANYPLANE_TOKEN 环境变量`)
  process.exit(1)
}
const hist = await histResp.json()
// 端点返回 { messages, fileBytes, subagents }（历史响应带子代理水合字段后不再是裸数组）
const candidates = (hist.messages ?? []).filter(
  (m) =>
    m.role === 'user' &&
    m.uuid &&
    m.rewindable !== false &&
    (m.blocks ?? []).some((b) => b.kind === 'text' && typeof b.text === 'string' && b.text.trim()),
)
const target = candidates[candidates.length - 1]
if (!target) {
  console.error('没有可回滚的用户消息（可能都在 compact 边界之前）')
  process.exit(1)
}
const preview = (target.blocks ?? [])
  .filter((b) => b.kind === 'text' && typeof b.text === 'string')
  .map((b) => b.text as string)
  .join(' ')
console.log('回滚目标:', target.uuid, (preview || '(非文本消息)').slice(0, 50))

const { ws, on, send, open } = connect(key)
const timeout = setTimeout(() => {
  console.error('TIMEOUT')
  process.exit(1)
}, 180_000)

const fail = (why: string): never => {
  console.error('❌', why)
  clearTimeout(timeout)
  process.exit(1)
}

// 0=等待 attach → 1=等待 rewind_files 应答 → 2=等待 rewound(conversation)
// → 3=等待 rewound(both) → 4=等待回滚后问答 result
let phase = 0

await open()
send({ kind: 'attach' })
setTimeout(() => {
  if (phase !== 0) return
  phase = 1
  console.log('>> 路径1: rewind_files（通用 control 通道，透传语义）')
  send({ kind: 'control', subtype: 'rewind_files', extra: { user_message_id: target.uuid } })
}, 3000)

on((ev) => {
  if (ev.kind === 'cli') {
    const m = ev.msg as Record<string, any>
    if (m.type === 'control_response') {
      console.log('<< control_response:', JSON.stringify(m.response)?.slice(0, 300))
      if (phase !== 1) return
      if (m.response?.subtype !== 'success') fail(`rewind_files 被拒绝: ${m.response?.error}`)
      phase = 2
      console.log('>> 路径2: rewind_conversation（重生进程截断对话）')
      send({ kind: 'rewind_conversation', userMessageId: target.uuid })
      return
    }
    if (m.type === 'result') {
      if (phase < 4) return
      console.log('<< result', m.subtype)
      console.log('✅ rewind E2E 成功（三条路径全覆盖）')
      clearTimeout(timeout)
      process.exit(0)
    }
    return
  }
  if (ev.kind === 'rewound') {
    console.log('<< rewound 事件:', ev.scope)
    if (phase === 2 && ev.scope === 'conversation') {
      phase = 3
      // 等重生进程站稳再走组合路径
      setTimeout(() => {
        if (phase !== 3) return
        console.log('>> 路径3: rewind_both（先恢复文件，成功后回滚对话）')
        send({ kind: 'rewind_both', userMessageId: target.uuid })
      }, 3000)
      return
    }
    if (phase === 3 && ev.scope === 'both') {
      phase = 4
      // init 是惰性的（首条输入后才发），等待 respawn 后直接发问
      setTimeout(() => {
        if (phase !== 4) return
        console.log('>> 回滚后发问')
        send({ kind: 'user', text: '用两个字回答：2+2等于几？' })
      }, 5000)
      return
    }
    fail(`意外的 rewound: phase=${phase} scope=${String(ev.scope)}`)
    return
  }
  if (ev.kind === 'approval_request') {
    // 回滚目标若是需审批的消息（如写文件），resume-session-at 重生后 CLI 会重放该 turn
    // 并把审批路由回 stdio——不裁决会卡在 requires_action 直到超时。e2e 环境一律放行。
    console.log(`<< approval_request（${String(ev.toolName)}）自动允许`)
    send({ kind: 'approval', requestId: ev.requestId, decision: { behavior: 'allow' } })
    return
  }
  if (ev.kind === 'error') {
    fail(String(ev.message))
  }
})
ws.onerror = (e) => console.error('ws error', e)
