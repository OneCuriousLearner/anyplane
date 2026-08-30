# 发布流程（Releasing）

本文记录每次发 npm 版本的关键事项与信任模型。AGENTS.md 只放指针，细节以此文为准。

## 发版四步（唯一入口）

```bash
# 1. 改根 package.json 的 version（0.x 阶段：功能 = minor，修复 = patch）
# 2. git commit
git tag v<x.y.z>
git push origin v<x.y.z>
```

tag 推送触发 `.github/workflows/release.yml`：`bun install --frozen-lockfile` → `bun test` → `bun run build` → **校验 tag 与 package.json 版本一致** → `npm publish`（Trusted Publishing，OIDC）。

**绝不绕过 CI 手动 `npm publish`**——除非 CI 本身坏了（此时先修 CI）。

## 谁能发布：默认只有仓库 owner

npm 包 `anyplane` 的发布入口只有两个，外人默认都走不通：

1. **npm 账号/Org 成员手动 publish**——npm 侧强制 2FA（账号绑了通行密钥）。
2. **GitHub Actions Trusted Publishing**——在 npmjs.com 包设置里绑定了
   `repository = OneCuriousLearner/anyplane` + `workflow = release.yml`。
   CI 里的 OIDC token 由 GitHub 现场签发，npm 校验这两个 claim 完全匹配才放行。

推论：

- **能推 tag 的人 = 能发布的人** = GitHub 仓库写权限持有者（默认仅 owner）。
- **fork 无法冒名发布**：fork 的 Actions 里 OIDC token 的 `repository` claim 是 fork 名，npm 直接拒绝。
- **仓库里没有任何 npm token**（无 `NPM_TOKEN` secret），泄露面收敛为 GitHub 写权限本身。
- master 分支保护要求 PR 合并；owner（admin）可 bypass，所以 owner 直推有效，协作者不行。

若要多人共管，两个维度都要加人：GitHub collaborator（推 tag）+ npm org member（手动 publish 兜底）。
可选再加一道闸：给 release job 配 GitHub Environment（required reviewers），发布前需人工批准。

## 已踩过的坑

- **v0.1.1 首发失败**：tag 与 `package.json` 版本不一致，被 CI 强校验拦下。处理 = 改版本号提交 →
  `git tag -d` + `git push origin :refs/tags/v<x>` 删旧 tag → 重打重推。npm 未收到任何发布，重名 tag 无残留风险。
- **不要给 setup-bun 钉 `bun-version`**：曾钉 1.3.15 导致 CI 404（该稳定版从未发布，Bun 由 1.3.14 直跳 1.4.0）。
  现在版本来源于 `package.json` 的 `engines.bun`（`>=1.3.13`），setup-bun 自动解析为满足条件的最新稳定版。
- **撤版**：`npm unpublish` 仅限发布后 72h 且有依赖检查；优先用 `npm deprecate <pkg>@<version> "<原因>"` 加发一个 patch 版本顶掉。

## 版本史备注

- `0.0.1` / `0.0.2`：改名期占位包（仅 README + package.json），历史遗留，勿再引用。
- `0.1.0`：首个真包（CLI + 服务端 + 预构建前端），发布链路落成。
- `0.1.1`：E2 液态玻璃视觉语言全量落地；首次走完"四步发版"全流程。
