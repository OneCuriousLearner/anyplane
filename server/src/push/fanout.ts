// Web Push / webhook 的通知载荷组装与扇出；会话显示名、审批摘要、审批确认页 HTML 的唯一正本。
// 依赖方向：push → hub（registry）允许，反向禁止（hub 经 hub/broadcast 的 InboxSink 出口）。

import { parseKey } from '../backends/claude/backend'
import { portFor } from '../backends/port'
import { log } from '../log'
import { pushToAll, pushWebhooksToAll, subscriptionCount, webhookCount, type PushPayload } from '../push'
import { escapeHtml } from '../util'
import { hubs } from '../hub/registry'
import type { InboxEvent, PendingApproval } from '../hub/types'

/** 会话显示名：项目目录 basename（approval 只在 spawn 后发生，spawnOpts.cwd 必有）。
 *  s| 未 spawn 时经 parseKey 反查真实 cwd——每 Hub 至多一次（缓存在 hub.nameCwd，
 *  避免推送事件触发反复 listSessions 全盘扫描）；b|/n|/xn| 的 cwd 内嵌在 key 里直接取。
 *  parseKey 也查不到（slug 目录已删）时以 slug 末段近似。 */
export function sessionNameOf(key: string): string {
  const base = (cwd: string) => cwd.replace(/\/+$/, '').split('/').pop() ?? cwd
  const hub = hubs.get(key)
  if (hub?.spawnOpts?.cwd) return base(hub.spawnOpts.cwd)
  const parts = key.split('|')
  try {
    if ((parts[0] === 'b' || parts[0] === 'n' || parts[0] === 'xn') && parts[1]) {
      return base(decodeURIComponent(parts[1]))
    }
  } catch {
    // key 内嵌 cwd 不是合法 URI 编码（状态损坏/构造输入）：落 key 截断，不影响推送分发
    return key.slice(0, 18)
  }
  if (parts[0] === 's') {
    if (hub && hub.nameCwd === undefined) hub.nameCwd = parseKey(key)?.cwd ?? ''
    if (hub?.nameCwd) return base(hub.nameCwd)
    // slug 是 sanitizePath(cwd)：末段即目录名（近似，仅推送显示用）
    if (parts[1]) return parts[1].split('-').pop() ?? key.slice(0, 18)
  }
  // x|：cwd 不在 key 里，取已加载会话句柄的 cwd（thread/read 解析后即有；
  // 推送/审批页恰好在会话存活期触发）。取不到时落 key 截断，不做同步 RPC
  if (parts[0] === 'x') {
    if (hub && hub.nameCwd === undefined) hub.nameCwd = portFor(key).sessionOf(key)?.cwd ?? ''
    if (hub?.nameCwd) return base(hub.nameCwd)
  }
  return key.slice(0, 18)
}

/** 审批输入摘要（推送通知/审批页）：按工具挑裁决所需的关键字段，其余给 JSON 截断。
 *  与 web 端 toolSummary 同族但取舍不同——审批场景 Bash 必须给 command 本体
 *  （description 是作者给的说明文字，不能作为裁决依据；web 卡片下方另有详情区才可用它打头）。 */
export function summarizeInput(toolName: string, input: unknown): string {
  const obj = (input ?? {}) as Record<string, unknown>
  if (toolName === 'Bash') return String(obj.command ?? '').slice(0, 400)
  if (toolName === 'Glob' || toolName === 'Grep') return String(obj.pattern ?? '')
  if (toolName === 'WebSearch') return String(obj.query ?? '')
  if (toolName === 'WebFetch') return String(obj.url ?? '')
  if (toolName === 'Agent') return String(obj.description ?? obj.prompt ?? '').slice(0, 300)
  if (obj.file_path) return String(obj.file_path)
  if (obj.path) return String(obj.path)
  if (obj.grantRoot) return String(obj.grantRoot)
  const json = JSON.stringify(input ?? {})
  return json.length > 300 ? json.slice(0, 300) + '…' : json
}

/**
 * webhook 审批确认页（GET /api/approval-page 的 HTML）。
 * 故意零依赖零外链（微信内置浏览器可达性）；k/r/s 由页面 JS 从自身 URL 读取，
 * 服务端只注入已转义的工具名与摘要，不把 secret 写进 HTML。
 */
export function approvalPageHtml(key: string, pending?: PendingApproval): string {
  const session = escapeHtml(sessionNameOf(key))
  const tool = pending ? escapeHtml(pending.toolName) : ''
  const summary = pending ? escapeHtml(summarizeInput(pending.toolName, pending.input)) : ''
  const inner = pending
    ? `<p class="meta">${session}</p>
  <h1>需要审批 · ${tool}</h1>
  <pre>${summary}</pre>
  <div class="row">
    <button class="ok" onclick="act('allow')">允许</button>
    <button class="no" onclick="act('deny')">拒绝</button>
  </div>
  <p id="st" class="meta"></p>`
    : `<h1>审批已处理</h1>
  <p class="meta">${session} · 该请求已被裁决或不存在，无需操作</p>`
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<title>审批 · AnyPlane</title>
<style>
  body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#16130f;color:#e8e2d9;font:14px/1.6 ui-monospace,SFMono-Regular,Menlo,monospace}
  .card{box-sizing:border-box;width:100%;max-width:26rem;margin:1rem;padding:1.25rem;border:1px solid #3a332a;border-radius:.5rem;background:#1e1a15}
  h1{font-size:1rem;margin:.25rem 0 .75rem}
  .meta{color:#8a8175;font-size:.75rem;word-break:break-all}
  pre{white-space:pre-wrap;word-break:break-all;background:#16130f;border:1px solid #3a332a;border-radius:.375rem;padding:.625rem;font-size:.75rem;max-height:40vh;overflow:auto}
  .row{display:flex;gap:.625rem;margin-top:1rem}
  button{flex:1;padding:.75rem;border-radius:.375rem;border:1px solid;font-size:.875rem;cursor:pointer;background:transparent;color:inherit}
  button:disabled{opacity:.4;cursor:default}
  .ok{border-color:#6f9f6f;color:#9fce9f}
  .no{border-color:#9f6f6f;color:#ce9f9f}
</style>
</head>
<body>
<div class="card">${inner}</div>
<script>
async function act(d){
  document.querySelectorAll('button').forEach(function(b){b.disabled=true})
  var st=document.getElementById('st')
  st.textContent='提交中…'
  var p=new URL(location.href).searchParams
  try{
    var resp=await fetch('/api/approval-action?k='+encodeURIComponent(p.get('k')||'')+'&r='+encodeURIComponent(p.get('r')||'')+'&d='+d+'&s='+encodeURIComponent(p.get('s')||''),{method:'POST'})
    var j=await resp.json()
    st.textContent=j.ok?(d==='allow'?'✓ 已允许':'✓ 已拒绝'):('失败：'+(j.error||resp.status))
    if(!j.ok)document.querySelectorAll('button').forEach(function(b){b.disabled=false})
  }catch(e){
    st.textContent='网络错误，请重试'
    document.querySelectorAll('button').forEach(function(b){b.disabled=false})
  }
}
</script>
</body>
</html>`
}

export function fanoutPush(ev: InboxEvent): void {
  if (subscriptionCount() === 0 && webhookCount() === 0) return
  if (ev.type === 'approval_resolved') return // 审批已处理，无需推送（通知 tag 替换语义下保留现状即可）
  const session = sessionNameOf(ev.key)
  let payload: PushPayload
  if (ev.type === 'approval') {
    payload = {
      type: 'approval',
      title: `需要审批 · ${ev.toolName}`,
      body: `${session}｜${summarizeInput(ev.toolName, ev.input)}`,
      key: ev.key,
      session,
      requestId: ev.requestId,
      // 能力 URL：secret 由 pushToAll 按订阅逐个补全（每个订阅一个能力密钥）
      actions: {
        allow: `/api/approval-action?k=${encodeURIComponent(ev.key)}&r=${encodeURIComponent(ev.requestId)}&d=allow&s=`,
        deny: `/api/approval-action?k=${encodeURIComponent(ev.key)}&r=${encodeURIComponent(ev.requestId)}&d=deny&s=`,
      },
      tag: `ccr-a-${ev.requestId}`,
    }
  } else if (ev.type === 'done') {
    payload = {
      type: 'done',
      title: `${ev.ok ? '✓ 完成' : '✗ 结束（有错）'} · ${session}`,
      body: '会话已空闲，点击查看结果',
      key: ev.key,
      session,
      tag: `ccr-d-${ev.key}`,
    }
  } else {
    payload = {
      type: 'error',
      title: `⚠ 出错 · ${session}`,
      body: ev.message.slice(0, 300),
      key: ev.key,
      session,
      tag: `ccr-e-${ev.key}`,
    }
  }
  void pushToAll(payload).catch((e) => log.warn('[push] fanout 异常:', e))
  void pushWebhooksToAll(payload).catch((e) => log.warn('[push] webhook fanout 异常:', e))
}
