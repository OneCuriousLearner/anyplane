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

在容器内 `bun run build && bun run start`，配置 `authToken` 后把 7480 端口通过你的域名暴露即可（未配置 token 时严禁绑定非回环地址——服务端会拒绝启动）。

## 跨网段访问

AnyPlane 不自建公网穿透。三套免 VPS 配方（Tailscale funnel / Cloudflare Tunnel / 家宽 IPv6+DDNS）见 [public-access.md](public-access.md)，含安全红线与手机蜂窝网络验收清单。
