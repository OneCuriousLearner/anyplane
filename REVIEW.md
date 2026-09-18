# REVIEW.md——提交 PR 前的自查清单

本清单整理自各 PR merge 前"审查轮"提交（如 PR#33、#41、#42、#49 的 review 补修）中反复出现的共性问题。
**这里不放新规则**：每条只给症状、自查动作与指针——判定标准在 AGENTS.md，机械执行交给 `bun run verify` 与 CI。

用法：提交 PR 前按 0→6 顺序过一遍；reviewer 也可拿它对照 diff。

## 0. 动笔前的查证阶梯

凡是要断言"上游/平台会这样行为"的，按序降级查证，查不到再降一级：

1. **协议正本**：Claude stream-json 看 `@anthropic-ai/claude-agent-sdk` 的 `sdk.d.ts`；Codex 看 `codex app-server generate-ts --experimental`（`check-*.ts` 脚本即以此为漂移基线）。
2. **本地文档镜像**：`docs/claude-code/`、`docs/codex/`（`bun run docs:claude|docs:codex` 拉取，见各 `llms.txt`）。
3. **上游源码与官方文档**：GitHub 上两家 CLI 的官方源码仓库与文档站点；联网搜索官方 issue/文档，不采信二手博客结论。
4. **实测反推**：以上都查不到才做实验，结论写入 `docs/research/` 并按版本标注——笔记会腐烂，正本才是终审。

> 教训：research 笔记里对 `Uri.encode` 的误判活到审查轮才被实测推翻（PR#42）；对端行为的断言引用了上游源码的具体文件行才一锤定音（PR#33 的 `list.rs`/`session_index.rs`）。

## 1. 全局闸：同一 PR 自相不一致

最常见的被抓模式：**本 PR 刚立的原则，PR 内另一处没跟上**。

- 对 diff 里每个**新建导出**（类型/词表/助手函数），grep 同形结构：是否已有等价物可复用/派生？
- 对 diff 里每处**删除**（shim/兼容层/兜底表），grep 是否还有同款漏网？
- 先例：本 PR 刚建的 `CliRingSlot` 隔壁又手写同形（PR#41）；同 PR 删了一处 re-export shim 漏了另一处（PR#41）；三个互不相识的 `SessionStatus` 联合（PR#41）。

## 2. 正本化自查（最高频，约占审查轮发现六成）

- 新增形状/词表/常量：该进 `@anyplane/protocol` 正本，还是 vendor 在后端内部？前端出现后端名键控的表/分支，一律改走 capabilities 声明消费（先例：前端能力兜底表被删，PR#49）。
- 同一决策口径被计算第二次时：派生正本而非拷贝（先例：审批摘要三处 `JSON.stringify` 收敛为服务端 detail 唯一口径，PR#42；`HandoffDetail` 三份拷贝归一，PR#41）。
- 构造 key/描述 key：走 `portFor(key)` / `backendPort(name)` 注册表，不自造（先例：handoff 与 routes 两处，PR#49）。

## 3. 测试断言自查

每条红线的完整表述在 AGENTS.md 测试纪律节，此处是提交前动作：

- **断言可能恒真吗**？"等到任意事件即过""超时也算过"都是（先例：补发断言被 live 广播喂成重言式、TIMEOUT 算过，PR#49/#48）。mock 挂起期间状态假稳会让断言抖动（busy 恒真，2/5 抖动）。
- **行为变了，断言同步改了吗**？（先例：幂等语义变更后旧断言还活着，靠 tail 截断掩盖失败计数，PR#41——收尾必须看完整 pass/fail 行，`bun run verify` 强制。）
- **用例名与构造一致吗**？名不副实与逐字节重复的用例都会被审出来（先例：PR#46）。
- 改 mock 链路时：超时/失败的诊断信息（事件骨架 dump）要够 CI 定位（PR#49 的正面做法）。

## 4. 生命周期切换点清单

对 diff 触及的每个切换点自问：**迟到事件去哪了？旧快照是整体替换还是增量打补丁？**

切换点枚举：socket 重建 / 断连重连、会话 key 切换、凭据或服务器重配、进程回收与重拉、页面导航。

- 迟到回调不得再驱动已切换后的状态（先例：旧 socket 回调武装重连的自激循环，PR#42）。
- 快照类状态以权威全集整体替换，增量修补会让断连期间的陈账复活（先例：pendings 快照，PR#42）。
- 会话 key 切换必须清态：不按 key 重挂载的组件会把上一会话状态带进新会话首包窗口（先例：`useSessionSocket` 重置，PR#49）。
- 瞬态空值不得覆盖持久凭据/配置（先例：configure 空写冲掉 SSO 会话，PR#42）。

## 5. 能力把关单源

- 全仓 grep `isCodex`、`'claude' | 'codex'` 字面量：新增能力时把关只认 `capabilities` 声明一个口径，方法缺失 fail fast（非空断言），不查"方法是否存在"（先例：三种把关口径并存，PR#49）。
- UI 入口按能力隐藏时，把关的兜底（不可信客户端直发）与服务端用同一声明，拒绝文案给可操作的替代路径。
- 声明了能力的方法必须在适配器真实实现——声明即契约。

## 6. 平台行为必实测

凡是"我以为平台会这样"的跨平台断言，先走第 0 节查证，再实测：

- Windows：子进程 argv 引号渲染、`.cmd`/`.bat` 解析（本项目只信 Bun ≥1.4 的原生处理，不手工包装，AGENTS.md Windows 节）；**路径含空格**是引号 bug 的照妖镜。
- Android：API 级别守卫（minSdk 与目标 API 的 newer API 调用要判版本）、URL 编码差异（`URLSearchParams` 的 `'+'` 不还原）、Intent/PendingIntent 溢出、scheme/host/port 白名单要全等。
- iOS：系统弹窗/权限时序、通知中心与前台的送达差异。
- 实测结论进 `docs/research/` 按版本标注，别留在 PR 描述里腐烂。

## 附：分层归属备忘

| 内容 | 归属 |
|---|---|
| 判定标准与红线（测试纪律、能力声明即契约等） | AGENTS.md |
| 一键机械验证（tsc + biome + test 全量与汇总行） | `bun run verify` / CI |
| 上游行为实测结论 | `docs/research/`（按版本标注） |
| 本清单 | 提交前的操作顺序与自查问题 |
