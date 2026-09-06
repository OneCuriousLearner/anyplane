# docs 文档地图

本目录收录用户向参考文档与长文本文档（审计报告/调研记录/规划），AGENTS.md 只保留最关键结论并引用此处路径。

## 现在时（持续维护，改动需同步相关引用）

| 文档 | 角色 |
|---|---|
| [configuration.md](configuration.md) | 配置全集：配置项、审批规则引擎、推送 webhook、日志、平台注意事项（README 只保留常用项） |
| [gateway.md](gateway.md) | 域名访问（80/443 网关）与远程容器部署 |
| [public-access.md](public-access.md) | 公网接入三套免 VPS 配方（Tailscale funnel / CF Tunnel / IPv6+DDNS）与安全红线 |
| [releasing.md](releasing.md) | 发版流程与 npm 发布权限模型 |
| [ROADMAP.md](ROADMAP.md) | 已讨论定论、待排期的方向与决策依据 |

## 规划（[plans/](plans/)）

实施计划，**是否完成以文档头部状态标注为准**——已完成的 PLAN 即历史档案，不再更新，留存只为追溯决策。

## 调研与审计（[research/](research/)、[audits/](audits/)）

一次成文的侦察报告、实验记录、外部 bug 存档与全景审计，文件名统一 `YYYY-MM-DD-主题.md`（首次提交日期）。内容反映成文当时的事实，后续演进以代码与 ROADMAP 为准。

## 入库规范

- **不在入库文档中描述本地仓库路径、密钥位置等机器相关信息**；确有需要写进 `*.local.md`（gitignore）。
- 同主题文档归入对应子目录，不平铺根目录；新增长文本先对照本地图选位。
- `media/` 为 README/文档引用的静态资源。
