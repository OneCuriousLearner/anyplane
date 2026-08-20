# 第二梯队方案侦察报告（2026-08-20）

> 每条都经过源码分析 + 实际测试确认，标注了证据。讨论后再落地。

## 1. 图片/附件输入 —— 可行，两个后端路径都已实测通过

| 后端 | 可用路径 | 实测 |
|---|---|---|
| claude | stream-json user 消息 `content: [{type:'image', source:{type:'base64', media_type, data}}, {type:'text', ...}]`（Anthropic API 原生形状） | ✅ 直接 spawn 实测：模型正确答出测试图颜色（"红"）。浏览器 base64 直传，无需落盘 |
| codex | `turn/start` input 加 `{type:'localImage', path}` | ✅ 实测通过（模型答"红"）。注意：`{type:'image', url:'data:...'}` 在 DeepSeek provider 下模型声称看不到图（供应商/通道不支持），**codex 侧一律走 localImage**：浏览器上传 → 服务端写临时文件 → 传路径 |

实现要点：
- WS `user` 消息扩展 `attachments: [{name, mediaType, dataBase64}]`；claude 直接并进 content blocks；codex 服务端写 `~/.config/cc-remote/uploads/<uuid>.<ext>` 后用 localImage，引用计数/定期清理
- 前端：输入区加附件按钮（手机相册/拍照），消息块渲染图片缩略（HistoryBlock 加 image 类型；历史里 claude 有 base64 原文、codex 只有路径——缩略图渲染要分别处理，v1 历史里显示 `[图片]` 占位即可）
- 模型能力检测：codex `model/list` 的 `inputModalities` 有 image 时才显示按钮（deepseek-v4-flash 标称支持但 dataURL 实测失效，localImage 兜底）

## 2. 协议漂移防护 —— 推荐做，两件小事

**claude 侧**：写 `scripts/check-claude-protocol.ts`，从快照仓库（/data/workspace/claude-code，或后续刷新）grep 出：
- `controlSchemas.ts` 的 control_request subtype 清单（当前 20 个：initialize/interrupt/can_use_tool/set_permission_mode/set_model/set_max_thinking_tokens/mcp_status/get_context_usage/hook_callback/mcp_message/rewind_files/cancel_async_message/seed_read_state/mcp_set_servers/reload_plugins/mcp_reconnect/mcp_toggle/stop_task/apply_flag_settings/get_settings）
- `coreSchemas.ts` 的 stdout type/subtype 清单
与本仓库 `protocol.ts` 的已知集合 diff，新增项打印出来人工评估。CLI 升级后跑一次。

**codex 侧**：`codex app-server generate-ts --experimental` 输出与入库的基线 diff（我们已经实测撞上两次 wire 枚举漂移：sandbox kebab/camel 双轨、0.147 vs 快照差异）。版本升级先跑 diff 再放量。

**回放 harness**：`scripts/replay-fixture.ts` 把录制的 NDJSON（如 handoff-lab 的 claude-turn1.jsonl）喂给 ClaudeSession 的假 stdout，断言 translate/busy/审批状态机输出——把单测从"必须真起 CLI"解耦。

## 3. 双后端登录状态页 —— 可行，但价值有限

- codex：`account/read` 实测返回 `{account: null, requiresOpenaiAuth: false}`（自定义 provider 不需要 OpenAI 登录）；`account/login/start` 支持 apiKey/chatGPT。可做"未登录引导"
- claude：`--enable-auth-status` + initialize 握手后发出 `auth_status` 消息（实测字段 `{isAuthenticating, output, error}`）——只反映 CLI 自己管理面（Bedrock 等）的状态， OAuth 主链路不在里面
- **判断**：两者都只能给出弱信号。建议先做一个轻的"后端健康行"（app-server 握手成功/claude 可执行），不做完整登录引导。优先级往后放

## 4. fleet 管理（归档/删除）—— codex 已实测，claude 需自建语义

- codex：`thread/archive` / `thread/unarchive` / `thread/delete` 实测往返正常（archive 后从主列表消失、进 archived 列表、unarchive 回来）。直接可做
- claude：官方无归档概念，只能自己做：移动 jsonl 到 `~/.claude/projects/<slug>/archived/`（自定目录，官方不认识它，无冲突）或移到 cc-remote 自己的归档区。**风险**：官方 CLI 正在运行该会话时绝不能动（与改名同边界：仅离线会话）；删除 = 物理删除 jsonl（建议先进回收站目录）
- UI：SessionList 行长按/右键菜单（归档/删除），codex 会话有 archived 分组

## 顺带的发现（非第二梯队，但值得知道）

- codex `thread/read` 无 itemsView 参数，历史投影就是 summary；reasoning 不落 rollout 已确认（我们的侧车方案是对的）
- claude `--enable-auth-status` 的 auth_status 只在 initialize 握手后发出（print.ts:4505）——我们 spawn 时已经发 initialize，所以这个 flag 是免费的
- claude user 消息支持 `uuid` 字段用于幂等去重（print.ts:4064-4100）——以后做多端同步/重发安全时可以带上
