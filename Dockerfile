# syntax=docker/dockerfile:1

# AnyPlane all-in-one 镜像：Bun 运行时 + 官方 claude / codex CLI（单阶段，见 docs/ROADMAP.md 方向十一）。
#
# 构建:  docker build -t anyplane .
# 运行:  docker run -d --name anyplane -p 7480:7480 \
#          -e ANYPLANE_TOKEN=<至少32位随机串> \
#          -v anyplane-data:/root/.anyplane \
#          -v anyplane-claude:/root/.claude \
#          -v anyplane-codex:/root/.codex \
#          -v "$HOME/projects:/root/projects" \
#          anyplane
#
# 凭证目录两种挂法（择一，上面示例是推荐的第一种）：
#   ① 命名卷（隔离）：首次启动后在容器内登录一次——docker exec -it anyplane claude auth login /
#      codex login（claude 走 API key 时更省事：-e ANTHROPIC_API_KEY=... 即可，无需挂卷）。
#   ② 直挂宿主目录（"$HOME/.claude" / "$HOME/.codex"）：共享宿主登录态，但容器 CLI 对这些目录
#      可写——容器 CLI 比宿主机新时可能把宿主配置/状态文件向前迁移（codex 的带版本 sqlite
#      状态尤其敏感），反过来弄坏宿主机上较旧的 CLI。走这条建议 --build-arg 把容器 CLI
#      钉到与宿主一致的版本。
#
# ANYPLANE_HOST 默认 0.0.0.0（容器内回环外部不可达）；服务端启动守卫要求绑非回环必须配
# authToken，因此不配 ANYPLANE_TOKEN 会拒绝启动——这是刻意的 fail-closed。
# 会话的工作目录只能是容器内可见的路径：把宿主机项目目录挂进来（上例 /root/projects），
# 再在 Web 的新会话目录选择器里选对应容器路径。
# Windows（Docker Desktop）跑 Linux 容器即可，无需 Windows 原生镜像；
# PowerShell 挂卷语法：-v "$env:USERPROFILE\.claude:/root/.claude"

FROM node:22-bookworm-slim

# 全局工具版本锚点。
# 双 CLI 默认钉在「当前 master 端到端验证过」的版本（2026-09-14 容器实测：auth status /
# account/read / 会话驱动全通）——AnyPlane 驱动的是两家 CLI 的 headless 协议，latest 随时可能
# 引入未验证的协议漂移；protocol-drift CI 每周检查 latest，检查通过后把 pin 前移到该版本
# （一行 PR）。想要最新可用 --build-arg CLAUDE_CODE_VERSION=latest 显式覆盖。
# bun 锁 minor 吃 patch（仓库门槛 >=1.4.0，见 AGENTS.md Windows 说明；patch 级漂移风险低）。
ARG BUN_VERSION=1.4
ARG CLAUDE_CODE_VERSION=2.1.270
ARG CODEX_VERSION=0.154.0

# git：claude/codex 会话内的 git 操作依赖它（slim 镜像不带）。
# bun 与双 CLI 全部走 npm 官方分发：codex 的 bin 是 node 启动脚本，必须随镜像带 Node；
# claude-code npm 包自带预编译二进制，postinstall 需网络下载（构建期失败即报错，不会静默漏装）。
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && npm install -g \
      "bun@${BUN_VERSION}" \
      "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
      "@openai/codex@${CODEX_VERSION}" \
 && npm cache clean --force \
 && bun --version && claude --version && codex --version

WORKDIR /app

# 依赖层：仅清单文件，吃满构建缓存（bun.lock 变动才重装）
COPY package.json bun.lock ./
COPY server/package.json server/
COPY web/package.json web/
RUN bun install --frozen-lockfile

# 源码层 + 前端构建（产物 web/dist 由服务端静态托管）
COPY . .
RUN bun run build

ENV NODE_ENV=production \
    ANYPLANE_HOST=0.0.0.0

EXPOSE 7480
# 声明凭证/数据挂载点：未显式 -v 时 docker 会用匿名卷兜底，凭证不会写进镜像层
VOLUME ["/root/.anyplane", "/root/.claude", "/root/.codex"]

# 静态壳不鉴权，token 模式下 / 依然 200，探活不需要凭据
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD bun -e "fetch('http://127.0.0.1:'+(process.env.ANYPLANE_PORT??'7480')+'/').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# 直接以 bun 跑 TS 入口（不经 cli/anyplane.mjs 的 node 包装层）：容器内 PID 1 即服务进程，
# docker stop 的 SIGTERM 直达 installProcessHandlers 的优雅关闭（server.stop + 子进程树清理）。
ENTRYPOINT ["bun", "cli/anyplane.ts"]
CMD ["start"]
