# Codex 子代理投递：本地 A/B 与上游拓扑（2026-09-13）

- 日期：2026-09-13
- 状态：本地 A/B 完成；[#37197](https://github.com/openai/codex/issues/37197) 评论已发（@OneCuriousLearner，2026-09-12 17:09 UTC）；[#36586](https://github.com/openai/codex/issues/36586) 评论已起草、待发
- 二进制：本地 `codex-rs/target/debug/codex.exe`（不用 PATH 上的官方 0.149.0）
- 门控：`CODEX_INTER_AGENT_PLAINTEXT_DELIVERY`（默认保持官方加密信封；`payload` = A，`user` = B）
- 前序：[2026-08-31-codex-subagent-task-payload-bug.md](./2026-08-31-codex-subagent-task-payload-bug.md)

## 结论

**方案 B 成立，且不是新发现。** 非 OpenAI 父、`encrypted_content` 不是 Fernet 时，必须改发普通 `user`/`message`。只把明文填回 `agent_message.Payload`（方案 A，也是 #36586 **正文**的建议修法）不够。

[#36586](https://github.com/openai/codex/issues/36586) 上 @CCanxue 在 2026-08-03 已用 0.146.0 + DeepSeek 线级抓包得到同一结论，补丁仓库 [CCanxue/codex-deepseek-subagent-fix](https://github.com/CCanxue/codex-deepseek-subagent-fix)。我们在比 0.149 / 0.154 新的 HEAD debug CLI 上独立复现：A 落盘对了，模型仍说没任务；B 3 秒原样回标记。

两格不要混：

| 拓扑 | 主场 issue | 能做什么 |
|---|---|---|
| 非 OA → 非 OA（假密文） | #36586、#37237 | 投递层改写成 `user` message。不动 reserved `collaboration` schema |
| OA → 非 OA（真 `gAAAA` Fernet） | #37197、#34833、#36376 | 客户端无钥匙，不能拆。需要父侧明文策略；否则 fail-closed |
| OA → OA | #26210 | 保持加密信封 |

B 是兼容回退，不是「官方加密没必要」。

## 本地 A/B（DeepSeek 父 = 子，v2，`fork_turns=none`）

### 基线（未改写）

父 `spawn_agent.message` 完整。子会话落盘：

```
type=agent_message
Payload:          ← 空行
encrypted_content = 明文任务（不是 gAAAA Fernet）
```

子代理推理只看到环境/团队设置，连 `NEW_TASK` 信封都没有。标记 `VERIFY-LIVE-PAYLOAD-7F3A` 未回传。

- 父：`~\.codex\sessions\2026\09\13\rollout-2026-09-13T00-08-50-01a09660-eff3-7071-aa22-8fd605f07cd4.jsonl`
- 子：`~\.codex\sessions\2026\09\13\rollout-2026-09-13T00-08-58-01a09661-105c-7511-8a6b-36446bde3c47.jsonl`

### A：`CODEX_INTER_AGENT_PLAINTEXT_DELIVERY=payload`

落盘已改对：同一条 `agent_message` 的 `Payload:` 后面跟上全文，不再有 `encrypted_content` 项。子代理仍说 “No task text arrived”，去扫工作区。约 7 分钟后打断。

- 子：`~\.codex\sessions\2026\09\13\rollout-2026-09-13T00-24-06-01a0966e-e94b-77e1-9cf9-805f68550957.jsonl`（ordinal 9 已含 `VERIFY-LIVE-A-PAYLOAD-7F3A`）

含义：DeepSeek 丢掉的是整个 `agent_message` 类型。这正是 #36586 正文建议、后来 @HaoYue1027 仍在催的 `build_responses_request` fold。

### B：`CODEX_INTER_AGENT_PLAINTEXT_DELIVERY=user`

落盘改为 `type=message role=user`，正文是完整 NEW_TASK 信封。子代理 3 秒内只回 `VERIFY-LIVE-B-USERMSG-7F3A`。父最终答复确认 token 到达。

child → parent 的 `FINAL_ANSWER` 仍走 `agent_message`。父侧多半是靠 `wait_agent` 工具输出看到标记，不能据此认为 DeepSeek 能解析 `agent_message`。

- 父：`~\.codex\sessions\2026\09\13\rollout-2026-09-13T00-31-34-01a09675-c02d-7202-97fb-f0c76af58738.jsonl`
- 子：`~\.codex\sessions\2026\09\13\rollout-2026-09-13T00-31-38-01a09675-ce57-7171-83c7-f82afcee889e.jsonl`

## 官方为什么要加密（#26210 原文，不是传闻）

[PR #26210](https://github.com/openai/codex/pull/26210)：任务明文不要进 Codex history/rollout；不要当普通 `assistant` JSON 交给子代理；密文由 Responses 发出、CLI 只转发、Responses 在子模型侧解密。`message` 标了 `.with_encrypted()`。这是 **服务端 Fernet**，客户端没有密钥。

| 说法 | 实际对应 |
|---|---|
| 防历史/提示注入 | **控制面隔离**：`agent_message` + `author`/`recipient` 是特权通道。密文还让后续 parent turn、compaction、`fork_turns=all` 看不到任务正文 |
| 防第三方捕捉/蒸馏 | **信任边界**：OA 任务明文只存在于 Responses 内部和目标子模型上下文。CLI、代理、自定义 provider 不应看到 |

非 OA 父会忽略 `.with_encrypted()`，`message` 本来就是明文 tool arg。「防蒸馏」已经不成立；再塞进 `encrypted_content` 只是假装加密。

## 给官方 brief 的决策表

| 拓扑 | 保密 | 控制面 | 做法 |
|---|---|---|---|
| OpenAI → OpenAI | 做得到 | 做得到 | 保持加密信封，不动 reserved `collaboration` schema |
| 非 OA → 非 OA（非 `gAAAA`） | 父 tool arg 已是明文 | DeepSeek 丢掉整个 `agent_message` | 渲染成普通 `user` `message`（兼容回退） |
| OpenAI → 非 OA（真 Fernet） | 客户端拆开会泄漏 | 无法在非 OA 侧还原控制面 | fail-closed，不要在客户端拆 |

## 上游 issue 现状（2026-09-13）

没有官方 maintainer 拍板。主仓多条 open issue 是同一症状换封面，不必通读。

### #36586 — 非 OA→非 OA 主场（DeepSeek）

- 楼主建议 A（`client.rs` fold）。9 条评论，最后一条 2026-08-29，无官方回复。
- @CCanxue（8/3、8/6）：A 不够；B（`UserInput`）才稳；`spawn_agent → PONG`，`followup_task → PONG2`。
- @trillox9：DeepSeek Responses 兼容表只认 `message` / `function_call` / `function_call_output` / `reasoning` / `web_search_call`，其他 input type **直接忽略**。`fork_turns=all` 会从继承历史重放父的 `spawn_agent`，形成递归派发。
- @TOV1C / @CCanxue：切 `multi_agent_version: v1` **还得** `supports_search_tool: false`，否则 V1 工具藏在 `tool_search` 后（#36382），deepseek-v4-flash 不调它。代价是丢掉 V2 工具面。
- @HaoYue1027（Desktop Win + CLI 0.149.0，8/22）仍催 A，说明正文错误建议还在误导。
- 我们的跟帖已起草：确认 CCanxue；A 在更新 CLI 上仍失败；B 成功；OA 父请看 #37197。待发。

### #37197 — OA→非 OA 主场

- 2026-08-06 @YukiagoTpf：#35845 只修了接收路径；OA 父仍 `.with_encrypted()`；改 reserved schema 会被 OA API 拒。楼主要 opt-in 明文 + 非 reserved namespace + 真密文则 fail-closed。
- 2026-08-13 @NOirBRight：Gateway 适配不了真 Fernet。
- 2026-09-12 @OneCuriousLearner：补非 OA→非 OA 的 A/B，明确 B 不解 OA 父那格。
- 交叉引用：#34833、#35845、#35932、#36321、#36376、#36387、#36586、#37237、#26210；fork 见下。

### 可跳过的重复单

`#34833` `#35932` `#36321` `#36376` `#36387` `#37237` `#37858`，以及 `NOirBRight/CodexHub#395`。都是空 Payload / 第三方吃不了加密块，没有新拓扑。

## 社区三层 workaround（不要写进官方 brief 当推荐实现）

| 层 | 谁 | 管哪一格 |
|---|---|---|
| Codex 投递渲染 | CCanxue 补丁；我们的 B | 非 OA→非 OA（假密文） |
| 父侧 schema / 工具别名 | #37197 楼主；[opencodex#2495](https://github.com/lidge-jun/opencodex/issues/2495) | OA→非 OA：请求前换非 reserved 名并去掉 `encrypted: true`，回来再还原成 `collaboration` + `encrypted_function_args: []`。只去标记不够，ChatGPT 仍吐 `gAAAA`；三个工具名也要 alias。PR 因绑未文档化上游行为被挂起 |
| 事后拿 OA 回放恢复 | [opencodex#1540](https://github.com/lidge-jun/opencodex/pull/1540)（已合） | 用用户 ChatGPT 凭证把 Fernet 打回官方 Responses 逼出明文。opt-in、有配额和信任边界。`#92` 已关成 upstream tracker。**官方 brief 不要提这条** |

[opencodex#92](https://github.com/lidge-jun/opencodex/issues/92) 已关：根因在 Codex 客户端，代理拆不开 Fernet；可靠绕路是异构子代理用 V1。

## 未测 / 开放问题

- 只实机跑了 `spawn_agent` + `fork_turns=none`。`followup_task` / `send_message` 走同一条 `communication_from_tool_message`（CCanxue 已测 PONG2）。
- 只测了 `role=user`，没测 `developer`。
- 非 OA 自动按「非 Fernet」改写，还是跟 #37197 楼主一样 opt-in：倾向非 OA 自动（当前就是坏的），OA 父必须 opt-in。
- 本地实验是 env 门控，不是给上游的补丁形状。发 GitHub 时不贴路径、会话 id、key、env 代码。
