# syntax=docker/dockerfile:1

# AnyPlane all-in-one 镜像：Bun 运行时 + 官方 claude / codex CLI（单阶段，见 docs/ROADMAP.md 方向十一）。
#
# 构建:  docker build -t anyplane .
# 运行:  docker run -d --name anyplane -p 7480:7480 \
#          -e ANYPLANE_TOKEN=<至少32位随机串> \
#          -v anyplane-data:/root/.anyplane \
#          -v "$HOME/.claude:/root/.claude" \
#          -v "$HOME/.codex:/root/.codex" \
#          -v "$HOME/projects:/root/projects" \
#          anyplane
#
# ANYPLANE_HOST 默认 0.0.0.0（容器内回环外部不可达）；服务端启动守卫要求绑非回环必须配
# authToken，因此不配 ANYPLANE_TOKEN 会拒绝启动——这是刻意的 fail-closed。
# 会话的工作目录只能是容器内可见的路径：把宿主机项目目录挂进来（上例 /root/projects），
# 再在 Web 的新会话目录选择器里选对应容器路径。

FROM node:22-bookworm-slim

# 全局工具的版本锚点：bun 锁 minor 吃 patch（仓库门槛 >=1.4.0，见 AGENTS.md Windows 说明）；
# 双 CLI 默认 latest，协议漂移由 protocol-drift CI 盯梢，需要可复现构建时经 --build-arg 钉死。
ARG BUN_VERSION=1.4
ARG CLAUDE_CODE_VERSION=latest
ARG CODEX_VERSION=latest

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
