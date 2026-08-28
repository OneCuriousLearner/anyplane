# 第二梯队方案侦察报告（2026-08-20）

> 每条都经过源码分析 + 实际测试确认，标注了证据。讨论后再落地。
> 2026-08-20 更新：折入 claude-code 源码快照的细则（见各节"快照确认"）。

## 1. 图片/附件输入 —— 可行，两个后端路径都已实测通过

| 后端 | 可用路径 | 实测 |
|---|---|---|
| claude | stream-json user 消息 `content: [{type:'image', source:{type:'base64', media_type, data}}, {type:'text', ...}]`（Anthropic API 原生形状） | ✅ 直接 spawn 实测：模型正确答出测试图颜色（"红"）。浏览器 base64 直传，无需落盘 |
| codex | `turn/start` input 加 `{type:'localImage', path}` | ✅ 实测通过（模型答"红"）。注意：`{type:'image', url:'data:...'}` 在 DeepSeek provider 下模型声称看不到图（供应商/通道不支持），**codex 侧一律走 localImage**：浏览器上传 → 服务端写临时文件 → 传路径 |

实现要点：
- WS `user` 消息扩展 `attachments: [{name, mediaType, dataBase64}]`；claude 直接并进 content blocks；codex 服务端写 `~/.cc-remote/uploads/<uuid>.<ext>` 后用 localImage，引用计数/定期清理
- 前端：输入区加附件按钮（手机相册/拍照），消息块渲染图片缩略（HistoryBlock 加 image 类型；历史里 claude 有 base64 原文、codex 只有路径——缩略图渲染要分别处理，v1 历史里显示 `[图片]` 占位即可）
- 模型能力检测：codex `model/list` 的 `inputModalities` 有 image 时才显示按钮（deepseek-v4-flash 标称支持但 dataURL 实测失效，localImage 兜底）

**快照确认（claude 侧细节）**：
- `media_type` 必须是 snake_case——stdin 路径不做 camelCase 转换（`normalizeControlMessageKeys` 只转 requestId）
- base64 上限 5MB（`API_IMAGE_MAX_BASE64_SIZE`），客户端自动缩放到 2000x2000；media_type 限 jpeg/png/gif/webp
- 不支持 `source:{type:'file'}`；但 text 里 `@路径` 会被附件系统读成 image/document（零成本的本地文件引用路径）
- SDK schema 对 content 是 `z.unknown()` 宽松透传，结构在下游处理时才校验

## 2. 协议漂移防护 —— 推荐做，两件小事

**claude 侧**：写 `scripts/check-claude-protocol.ts`，从快照仓库（/data/workspace/claude-code，或后续刷新）grep 出：
- `controlSchemas.ts` 的 control_request subtype 清单（当前 20 个：initialize/interrupt/can_use_tool/set_permission_mode/set_model/set_max_thinking_tokens/mcp_status/get_context_usage/hook_callback/mcp_message/rewind_files/cancel_async_message/seed_read_state/mcp_set_servers/reload_plugins/mcp_reconnect/mcp_toggle/stop_task/apply_flag_settings/get_settings）
- `coreSchemas.ts` 的 stdout type/subtype 清单
与本仓库 `protocol.ts` 的已知集合 diff，新增项打印出来人工评估。CLI 升级后跑一次。

**codex 侧**：`codex app-server generate-ts --experimental` 输出与入库的基线 diff（我们已经实测撞上两次 wire 枚举漂移：sandbox kebab/camel 双轨、0.147 vs 快照差异）。版本升级先跑 diff 再放量。

**回放 harness**：`scripts/replay-fixture.ts` 把录制的 NDJSON（如 handoff-lab 的 claude-turn1.jsonl）喂给 ClaudeSession 的假 stdout，断言 translate/busy/审批状态机输出——把单测从"必须真起 CLI"解耦。

## 3. 双后端登录状态页 —— 修正：信号比初判强

- **initialize 响应的 `account` 字段就是现成账号信息**（email / organization / subscriptionType / tokenSource / apiProvider，print.ts:4470）——我们 spawn 时已发 initialize 并捕获响应，直接透传到 UI 即可，零新机制
- `auth_status` 只管 AWS/GCP 云凭证刷新流程（AwsAuthStatusManager），不管 Anthropic OAuth——按原判忽略
- 额度有独立的 `rate_limit_event`（限流状态变化时推送）——配额百分比不是钱，可进状态栏
- codex：`account/read` 实测 `{account: null, requiresOpenaiAuth: false}`（自定义 provider 免登录）；`account/login/start` 支持 apiKey/chatGPT 引导
- **落地建议**：升级原"健康行"方案——状态区直接显示账号摘要（claude 取 initialize.account，codex 取 account/read），未登录时给引导入口。可以做，成本低

## 4. fleet 管理（归档/删除）—— codex 已实测，claude 需自建语义

- codex：`thread/archive` / `thread/unarchive` / `thread/delete` 实测往返正常（archive 后从主列表消失、进 archived 列表、unarchive 回来）。直接可做
- claude：官方无归档概念，只能自己做：移动 jsonl 到 `~/.claude/projects/<slug>/archived/`（自定目录，官方不认识它，无冲突）或移到 cc-remote 自己的归档区。**风险**：官方 CLI 正在运行该会话时绝不能动（与改名同边界：仅离线会话）；删除 = 物理删除 jsonl（建议先进回收站目录）
- UI：SessionList 行长按/右键菜单（归档/删除），codex 会话有 archived 分组

## 顺带的发现（非第二梯队，但值得知道）

- codex `thread/read` 无 itemsView 参数，历史投影就是 summary；reasoning 不落 rollout 已确认（我们的侧车方案是对的）
- claude `--enable-auth-status` 的 auth_status 只在 initialize 握手后发出（print.ts:4505）——我们 spawn 时已经发 initialize，所以这个 flag 是免费的
- claude user 消息支持 `uuid` 字段用于幂等去重（print.ts:4064-4100）——以后做多端同步/重发安全时可以带上
- **file-history-snapshot 可用于 rewind 预览**：jsonl 行 `{type:'file-history-snapshot', messageId, snapshot:{trackedFileBackups: Record<path, {backupFileName|null, version, backupTime}>}}`——RewindPicker 选中某条消息时可以展示"该检查点包含哪些文件"（backupFileName 为 null = 当时不存在）

