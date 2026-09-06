# Codex BUG: 子代理任务消息投递为空（spawn_agent / followup_task Payload 丢失）

- 存档日期：2026-08-31
- 状态：官方已知问题，openai/codex 仓库多个 issue 未关闭
- 影响范围：所有依赖多代理协作（spawn_agent / followup_task）的工作流

## 现象

- `spawn_agent` / `followup_task` 调用本身成功，子代理被创建并触发一整轮运行。
- 但子代理收到的 `NEW_TASK` 信封中 `Payload` 为空，于是回复 "no task has come through yet" / "I'm ready when you are"。
- 子代理仍然能使用工具、甚至递归再派子代理，但完全看不到任务文本；`fork_turns="all"` 时只能从继承的父线程历史里"猜"任务。
- 间歇性触发。本环境实测（CLI 0.148.0，2026-08-31）：连续两次失败，第三次（带上下文重试）成功。

## 根因（来自 issue 排查证据）

- 父侧调用日志里消息完整，但投递时正文被写入 `encrypted_content` 字段，明文 `content` 为空。
- 子代理端读取的是明文 `content`，因此任务文本丢失。
- 仅 parent → child 方向受影响；child → parent 的 `FINAL_ANSWER` 正常送达。

## 相关 issue / 参考

- [openai/codex#36493](https://github.com/openai/codex/issues/36493)：0.146.0-alpha.9.2 + Windows Desktop，根因证据最全（含会话日志与 sqlite 证据）。
- [openai/codex#36321](https://github.com/openai/codex/issues/36321)：macOS + multi-agent v2，含子代理会话日志证据。
- [openai/codex#37822](https://github.com/openai/codex/issues/37822)：确认仅 root → sub-agent 方向失败。
- [openai/codex#40069](https://github.com/openai/codex/issues/40069)：2026-08-21 桌面版 26.818.3698.0 仍复现，说明最新版本尚未修复。
- 官方期望行为：<https://developers.openai.com/codex/subagents>（子代理应收到任务文本并执行）。

## 规避方案

1. 投递验证：任务消息里放唯一标记（如 `VERIFY-xxxx`），要求子代理原样复述，确认消息真的到达后再依赖其输出。
2. 优先 `fork_turns="all"`：子代理继承父线程历史，即使任务文本丢失也能从上下文推断意图。
3. 失败重试：观察到重试/换一个子代理常可成功。
4. 关键子任务不要假设首次投递一定成功，做好结果校验。
