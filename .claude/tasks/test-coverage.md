# 任务：为测试覆盖率不足的区域补测试

分析 anyplane 仓库的测试覆盖情况并补齐短板：

1. 先 `bun install`，然后在工作区根目录运行 `bun test` 确认基线全绿。
2. 找出覆盖率最低或完全没有测试的核心逻辑模块（可用 `bun test --coverage` 辅助定位，不要凭感觉挑）。优先 server/src 与 web/src 下的纯逻辑（协议解析、blocks 归并、翻译层、hub 状态管理等）；已有 e2e 脚本覆盖的真实 CLI 链路不要重复造单元测试。
3. 选出 3 个最值得补的模块，为每个编写有意义的 `*.test.ts`：覆盖边界情况与错误路径，禁止同义反复式断言（assert true 式假测试、只测 mock 自身的测试）。
4. 每完成一个模块运行一次 `bun test`，确认全绿后再继续；绝不提交红测试。
5. 每个模块的测试单独 commit。

遵循仓库测试约定：文件命名 `*.test.ts`、按被测模块所在目录分布、使用 Bun Test。

## 跨平台与 CI 纪律

CI 在 ubuntu + windows 双平台各跑四道：`bun run typecheck` → `bun run lint` → `bun test` → `bun run build`。**测试文件同样在 tsc 与 biome 范围内**（含依赖红线 noRestrictedImports）——提交前必须本地跑过 typecheck 与 lint，只跑 `bun test` 不算绿。

- **顺序无关性（跨平台 CI 的主要炸点）**：`bun test` 单进程跨文件共享模块实例，文件枚举顺序各平台不同——依赖"本用例先于其他文件执行、全局单态尚未被触碰"的测试会本地绿而 CI 红。凡涉及全局单态（sink / 计数器 / 持久化存储）的用例，开头必须显式调用被测模块的复位口（仓库先例：`resetInboxSinkForTest`、`setStoreFileForTest`、`setContextWindowStoreForTest`），严禁依赖执行顺序。
- 被测模块没有复位口时，**新增复位口属于允许的最小源码改动**（不受"不改源码"约束），与测试分开单独 commit 并说明原因。
- **Windows 敏感点**：mtime 缓存类测试重写文件后必须 `utimesSync` 显式推进 mtime（Windows 的 mtime 粒度与缓存键行为不同）；`bun -e` 等子进程测试需要传路径时从 `process.env` 读，绝不把绝对路径用字符串拼接进脚本字面量（反斜杠会被吞）。

## 执行环境

- 你在 anyplane 仓库的一个 git worktree 中工作，当前分支是脚本为此任务新建的（基于 origin/master）。
- 本项目仅使用 Bun（版本门槛见 AGENTS.md），绝不要用 npm / npx / yarn / pnpm。

## 提交与 PR 规范

- 每个模块的测试一个 commit，消息说明覆盖该模块的哪些行为（遵循仓库既有 commit 风格）。
- 精确实现任务要求——除上述复位口外不要顺手改被测源码（除非测试暴露出明确 bug，此时单独 commit 说明）。
- 全部完成后：`git push -u origin <当前分支>`，然后用 `gh pr create` 创建一个以 master 为 base 的 PR，正文说明：补了哪些模块的测试、各覆盖什么行为、测试总数从多少到多少。
- 最后输出一段总结：模块清单、每个模块的测试要点、commit 列表、PR 链接。
