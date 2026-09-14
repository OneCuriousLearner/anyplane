# 域名访问（80/443 网关）

开发态 Vite 仍在 `:5173`、生产态服务端仍在 `:7480`，默认都只绑 `127.0.0.1`。需要用域名从外部访问、且不写端口（或只走 80/443）时，另开网关：

```bash
bun run gateway --insecure   # 仅授信内网；有 authToken 则可去掉 --insecure
# npm 包安装：bunx anyplane gateway [--insecure]
```

| 怎么进 | 落到哪 |
|---|---|
| `http://anyplane.example.com/` | 生产 `:7480`（默认，无角标） |
| `http://anyplane.example.com/?mode=dev` | 开发 `:5173`，左下角 **DEV**（点击新开生产标签） |
| `http://anyplane.example.com/?mode=prod` | 显式生产 `:7480` |
| `http://anyplane-dev.example.com/` | 永远开发（需再挂一个域名，并配置 `gateway.devHost` 指向它） |
| `https://…` 同样规则 | 自签证书；若平台在边缘终结 TLS，浏览器 HTTPS 实际打到容器明文 80，也能分流 |

`127.0.0.1:5173` / `127.0.0.1:7480` 不受影响。80 上若收到 SSH 握手，会转到本机 `:36000`。状态页：`/__gateway`。

## 部署到远程容器

仓库根目录的 `Dockerfile` 是单阶段 all-in-one 镜像（Bun + claude/codex 双 CLI，构建期完成 `bun install` 与前端构建）：

```bash
docker build -t anyplane .
docker run -d --name anyplane -p 7480:7480 \
  -e ANYPLANE_TOKEN=<至少32位随机串> \
  -v anyplane-data:/root/.anyplane \
  -v anyplane-claude:/root/.claude \
  -v anyplane-codex:/root/.codex \
  -v "$HOME/projects:/root/projects" \
  anyplane
```

- 镜像默认 `ANYPLANE_HOST=0.0.0.0`，因此 **`ANYPLANE_TOKEN` 必填**——不配则服务端拒绝启动（fail-closed，与裸机「非回环必须 token」同一守卫）。
- `~/.anyplane` 存 AnyPlane 运行数据。
- **凭证目录两种挂法（择一）**：① 命名卷（推荐，隔离），首次启动后 `docker exec -it anyplane claude auth login` / `codex login` 登录一次（claude 用 API key 则 `-e ANTHROPIC_API_KEY=...` 即可，无需挂卷）；② 直挂宿主 `~/.claude` / `~/.codex` 共享登录态——但容器 CLI 对这些目录可写，版本比宿主新时可能把宿主配置/状态向前迁移（codex 带版本 sqlite 状态尤其敏感），拖累宿主旧 CLI，走这条建议 `--build-arg` 钉到与宿主一致的版本。
- **会话工作目录只能是容器内可见路径**：要管哪个项目就把哪个目录挂进来（上例 `/root/projects`），新会话目录选择器看到的是容器内路径。
- Windows 用 Docker Desktop 跑此 Linux 镜像即可；PowerShell 挂卷语法：`-v "$env:USERPROFILE\.claude:/root/.claude"`。
- 版本可复现：`--build-arg BUN_VERSION=1.x.y --build-arg CLAUDE_CODE_VERSION=x.y.z --build-arg CODEX_VERSION=a.b.c`。
- 手工容器部署（不用 Dockerfile）：容器内 `bun install && bun run build && bun run start`，同样要求配置 token 后绑非回环。

## 跨网段访问

AnyPlane 不自建公网穿透。三套免 VPS 配方（Tailscale funnel / Cloudflare Tunnel / 家宽 IPv6+DDNS）见 [public-access.md](public-access.md)，含安全红线与手机蜂窝网络验收清单；三配方的一键封装为 `bun run public-access <funnel|cf-quick|caddy>`（未配 authToken 拒绝执行）。
