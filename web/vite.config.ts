import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    // 5173 被占时报错退出而不是静默顺延到 5174——gateway 的 devTarget 写死 5173，
    // 换端口会让网关把 dev 流量代理到残留旧实例且无任何报错。
    strictPort: true,
    // 经自定义域名网关反代到 127.0.0.1:5173 时，必须放行对应 Host，否则 Vite 6 会 403。
    // 用 ANYPLANE_VITE_ALLOWED_HOSTS 按机器注入（逗号分隔，如 ".example.com,.lan"），不入库。
    allowedHosts: [
      'localhost',
      ...(process.env.ANYPLANE_VITE_ALLOWED_HOSTS?.split(',').map((h) => h.trim()).filter(Boolean) ?? []),
    ],
    proxy: {
      '/api': 'http://localhost:7480',
      '/ws': { target: 'ws://localhost:7480', ws: true },
    },
  },
  build: { outDir: 'dist' },
})
