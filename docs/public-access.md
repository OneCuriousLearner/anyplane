# 公网接入配方（不自购云服务器）

> 目标：手机在蜂窝网络下经公网 URL 使用 cc-remote（含锁屏推送与通知直接审批）。
> 三套方案都不需要自购 VPS；共同前提是**必须配置 `authToken`**——服务端只绑回环时它不强制，
> 但暴露发生在反代/隧道层，token 是公网上的唯一防线（另见文末「安全红线」）。

cc-remote 是单端口服务（7480 同时托管静态前端 + REST + WebSocket），三套方案都只是把
`127.0.0.1:7480` 安全地暴露出去，服务端本身零改动。

## 方案一：Tailscale funnel（推荐，一条命令）

前提：机器已加入 tailnet（`tailscale up`）。funnel 在多数 tailnet 默认可用，
少数需要在 ACL 里开 nodeAttrs `funnel`。

```bash
tailscale funnel --bg 7480
```

完成。公网地址是 `https://<机器名>.<tailnet名>.ts.net`（TLS 证书自动签发、**在本机终止**，
边缘节点只转发加密 TCP；WebSocket 正常透传）。

- 仅想 tailnet 内访问（不公开）用 `tailscale serve --bg 7480`，funnel 才是真公网。
- 只暴露 443；`tailscale funnel --bg 8443:7480` 之类的写法不需要。
- 查看/撤销：`tailscale funnel status`；`tailscale funnel --bg 7480 off` 关闭（或 `tailscale serve reset` 全清）。
- 加固可选：tailnet ACL 之外没有第二层访问控制，token 要够强（≥32 随机字符）。

## 方案二：Cloudflare Tunnel（要稳定域名 + Access 认证层时选）

**临时地址**（零配置、每次重启变域名，适合临时演示）：

```bash
cloudflared tunnel --url http://localhost:7480
# 输出 https://<随机>.trycloudflare.com
```

**命名隧道**（稳定域名，需域名已接入 Cloudflare）：

```bash
cloudflared tunnel login
cloudflared tunnel create cc-remote
# ~/.cloudflared/<tunnel-id>.json 凭据 + 下面 config.yml
cat > ~/.cloudflared/config.yml <<'EOF'
tunnel: <tunnel-id>
credentials-file: /root/.cloudflared/<tunnel-id>.json
ingress:
  - hostname: cc-remote.example.com
    service: http://localhost:7480
  - service: http_status:404
EOF
cloudflared tunnel route dns cc-remote cc-remote.example.com
cloudflared tunnel run cc-remote   # 或装成系统服务：cloudflared service install
```

- TLS 在 **CF 边缘终止**（CF 可见明文）——换来 Access（身份感知代理，比 token 多一层登录）、
  WAF、稳定域名。介意明文经过 CF 就用方案一。
- WebSocket 由 CF 免费档正常透传。
- 国内访问 CF 边缘节点速度看运营商，晚高峰可能一般；自建 ntfy/Server酱 等 webhook
  推送通道不受此影响（那是服务端出方向连接）。

## 方案三：家宽 IPv6 + DDNS（零第三方）

国内家宽普遍有公网 IPv6（/60 或 /64），IPv4 基本没有。形状：

```
手机(蜂窝 v6) → DDNS 域名 → 家宽 v6 → Caddy(:8443, 自动证书) → 127.0.0.1:7480
```

1. **确认有公网 v6**：`ip -6 addr` 出现非 `fe80::`/ULA 段，且与 https://test-ipv6.com 显示一致。
2. **放行入站**：光猫桥接或路由器防火墙放行本机 v6 的 8443（注意：家宽 80/443 入站常被
   运营商过滤，所以用 8443 这类非常规端口）；本机防火墙同步放行。
3. **DDNS**：ddns-go（支持 DNSPod/阿里/CF，检测到 v6 变化自动改记录）指向 `cc-remote.example.com`。
4. **Caddy 反代 + 自动证书**（Let's Encrypt 的 HTTP-01/TLS-ALPN-01 都支持 v6）：

   ```
   # Caddyfile
   cc-remote.example.com:8443 {
     reverse_proxy 127.0.0.1:7480
   }
   ```

   若 8443 证书申请被运营商拦截卡住，改用 DNS-01 挑战（Caddy 装对应 DNS 插件即可）。

服务端继续绑 `127.0.0.1`（Caddy 同机），暴露面只在 Caddy 的 8443。

## 安全红线（公网暴露前必读）

- **`authToken` 必须配置且够强**（≥32 随机字符）。三套方案里服务端都可以继续绑回环，
  「非回环绑定强制 token」的启动检查帮不到你——暴露发生在隧道/反代层，token 全靠自觉。
- 知道你在暴露什么：`GET /api/fs/list` 会给出本机目录结构，「任意目录起会话 ≈ 任意命令执行」。
  cc-remote 的控制面权限等于本机 shell，token 泄露 = 机器失守。
- 不要绕过 TLS：不要 `host: 0.0.0.0` + 裸 HTTP 直接暴露 7480。上面每套方案都有 TLS 终止层。
- 推送能力 URL（`/api/approval-action` / `/api/approval-page`）按设计绕开 authToken——
  它只经端到端加密推送或你配置的 webhook 渠道投递，且仅对 pending 中的 requestId 有效。
  泄露途径 = 推送渠道被窃听（见 README webhook 通道的凭证告诫）。
- 第二层防线按需叠加：CF Access（方案二自带）、Tailscale ACL（方案一）、Caddy basicauth（方案三）。

## 验收清单（手机蜂窝网络，非 Wi-Fi）

1. 打开公网 URL → 输入 token → 会话列表正常加载（静态壳 + /api + WS 全通）。
2. 起一个会话发消息，触发一次审批 → 手机上出现审批卡 → 批准 → turn 正常完成。
3. 锁屏等推送：Web Push 在 HTTPS 下订阅成功（iOS 需先加到主屏幕），审批通知的
   **允许/拒绝按钮**直接裁决，不打开页面。
4. 配了 webhook 通道的话，ntfy/Bark/微信收到同一份通知，ntfy 按钮一键审批 /
   Bark/Server酱 链接进确认页裁决。
5. 点击通知深链直达对应会话页（`#s=<key>`）。
