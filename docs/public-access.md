# 公网接入配方（不自购云服务器）

> 目标：手机在蜂窝网络下经公网 URL 使用 cc-remote（含锁屏推送与通知直接审批）。
> 三套方案都不需要自购 VPS；共同前提是**必须配置 `authToken`**——服务端只绑回环时它不强制，
> 但暴露发生在反代/隧道层，token 是公网上的唯一防线（另见文末「安全红线」）。

cc-remote 是单端口服务（7480 同时托管静态前端 + REST + WebSocket），三套方案都只是把
`127.0.0.1:7480` 安全地暴露出去，服务端本身零改动。

## 先懂两条路：为什么"通知到了、按钮却点不动"

推送链路和审批回执是**两条方向相反、互不相干的路径**：

```
通知投递：cc-remote →（出方向）→ 推送服务（ntfy.sh/FCM/APNs/微信）→ 手机
审批回执：手机 →（入方向）→ publicUrl 上的 cc-remote → /api/approval-action
```

通知能不能**收到**，只取决于服务器出方向能否到达推送服务——这部分在任何网络下都成立。
而通知上的**允许/拒绝按钮**（ntfy action、Web Push SW 回 POST、Bark/Server酱 确认页）是手机
直接请求 `publicUrl`——所以 `publicUrl` 必须是**手机当前网络也能到达**的地址。

典型症状与根因：公司内网 PaaS 分配的域名只在办公网可达，内网 Wi-Fi 下一切正常，
切到蜂窝网络后"能收到通知、点按钮超时"——缺的不是推送配置，而是本文档的公网接入。

## 方案一：Tailscale funnel（推荐，一条命令）

前提：机器已加入 tailnet（`tailscale up`），且**有 `/dev/net/tun`**（`ls /dev/net/tun` 确认）——
无特权的云容器/沙箱环境通常没有 TUN 设备，Tailscale 整套方案（serve/funnel）都用不了，
直接看方案二。funnel 在多数 tailnet 默认可用，少数需要在 ACL 里开 nodeAttrs `funnel`。

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

cloudflared 是**纯用户态二进制、出站连接**，无 TUN 的容器/沙箱里也能跑——
这类环境下它是唯一可行方案。

**临时地址**（零账号、零费用、无需域名，每次重启变域名，适合验证与临时演示）：

```bash
cloudflared tunnel --url http://localhost:7480
# 输出 https://<随机>.trycloudflare.com
```

**命名隧道**（稳定域名，需一个接入 Cloudflare 的域名——域名本身要付费；
没有支付渠道可尝试 eu.org / pp.ua 等免费二级域名，历史上可接入 CF 免费 DNS 托管）：

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
  同理，公网模式下 `bun run gateway` 不要带 `--insecure`（那是纯内网的用法）。
- 知道你在暴露什么：`GET /api/fs/list` 会给出本机目录结构，「任意目录起会话 ≈ 任意命令执行」。
  cc-remote 的控制面权限等于本机 shell，token 泄露 = 机器失守。
- 不要绕过 TLS：不要 `host: 0.0.0.0` + 裸 HTTP 直接暴露 7480。上面每套方案都有 TLS 终止层。
- 推送能力 URL（`/api/approval-action` / `/api/approval-page`）按设计绕开 authToken——
  它只经端到端加密推送或你配置的 webhook 渠道投递，且仅对 pending 中的 requestId 有效。
  泄露途径 = 推送渠道被窃听（见 README webhook 通道的凭证告诫）。
- 第二层防线按需叠加：CF Access（方案二自带）、Tailscale ACL（方案一）、Caddy basicauth（方案三）。

## 换公网地址后的两件琐事

- **Web Push 订阅是按 origin 的**：换了公网地址（含临时隧道域名轮换）后，手机要在**新地址**上
  重新打开铃铛面板订阅一次，否则新 origin 的通知按钮回 POST 仍打到旧地址。
  旧 origin 的订阅在旧网络里依然有效，两边会同时收到推送，按需退订。
- **旧通知的链接随之失效**：`publicUrl` 变更前发出的通知，其按钮/深链仍指向旧地址，点不动属正常。

## 故障排查

| 症状 | 根因方向 |
|---|---|
| 通知完全收不到 | 出方向：服务器 → 推送服务不通（curl 推送服务地址验证），或 webhook 配置未生效（铃铛面板看通道数） |
| 通知到了、按钮点不动/超时 | 入方向：`publicUrl` 不是手机当前网络可达的地址（见「先懂两条路」） |
| 按钮点了显示"已处理或不存在" | 审批已被裁决（其他端先点了），属正常 |
| 蜂窝下页面能开但推送订阅失败 | Web Push 需 HTTPS（iOS 还需先加到主屏幕从主屏图标打开）；ntfy/webhook 不受此限 |

## 验收清单（手机蜂窝网络，非 Wi-Fi）

1. 打开公网 URL → 输入 token → 会话列表正常加载（静态壳 + /api + WS 全通）。
2. 起一个会话发消息，触发一次审批 → 手机上出现审批卡 → 批准 → turn 正常完成。
3. 锁屏等推送：Web Push 在 HTTPS 下订阅成功（iOS 需先加到主屏幕），审批通知的
   **允许/拒绝按钮**直接裁决，不打开页面。
4. 配了 webhook 通道的话，ntfy/Bark/微信收到同一份通知，ntfy 按钮一键审批 /
   Bark/Server酱 链接进确认页裁决。
5. 点击通知深链直达对应会话页（`#s=<key>`）。
