# CF Pages「关闭 Preview 仍产生墓碑部署」实测（2026-09-17）

## 结论

Pages 项目把 **Preview branches 设为 None 后，非生产分支的 push 仍会各创建一条 preview 部署记录**，
只是该记录 `is_skipped: true, skip_reason: "preview_deployments_disabled"`——构建被跳过，
不产生构建消耗，但**部署记录照建、照留、照计入 100 个部署的项目删除上限**（错误码 8000076）。

即：设置生效，但 CF 为每次 push 留下一条「墓碑」。dashboard 上墓碑与普通部署无视觉区分，
表现为「关了 preview 又凭空多了几个 Preview Pages」。

## 对照实验

- 前置：`preview_deployment_setting: "none"` 已保存（经 API 读项目配置确认服务端存储正确）。
- 操作：从 master 新开 `cf/preview-test` 分支，推一个空提交（`4fe7820`），无代码变更。
- 结果：push 后 5 秒内创建 preview 部署，环境为墓碑（skipped）。
- 旁证：当天 `feat/capacitor-shell` / `feat/pages-deploy-cleanup` / `fix/pages-cleanup-empty-env`
  的全部 7 个 preview 部署均为墓碑——设置保存后无一真实构建。

## 影响与对策

- **堆积主驱动换人**：preview 关闭后，部署数增长 = 全部分支 push 次数（开发期一天数个），
  不再只是 master 合并节奏。8000076 风险反而上升，必须靠定时清理兜底。
- **缓解**：`pages-cleanup.yml`（见 `.github/workflows/`）每周清理，墓碑与普通部署同路径删除，
  无特殊处理。复核预期见 issue #38。
- `KEEP_PREVIEW` 保留 3 的默认值对纯墓碑无意义，暂不改（墓碑反正周日被清，
  留几个便于排查时对照）。

## 复查方法

```bash
# 看项目实际存储的 preview 设置
curl "https://api.cloudflare.com/client/v4/accounts/$CF_ACCOUNT_ID/pages/projects/anyplane" \
  -H "Authorization: Bearer $CF_TOKEN" | jq '.result.source.config.preview_deployment_setting'

# 看 preview 部署是不是墓碑
curl "https://api.cloudflare.com/client/v4/accounts/$CF_ACCOUNT_ID/pages/projects/anyplane/deployments" \
  -H "Authorization: Bearer $CF_TOKEN" \
  | jq '.result[] | select(.environment=="preview") | {branch: .deployment_trigger.metadata.branch, is_skipped, skip_reason}'
```
