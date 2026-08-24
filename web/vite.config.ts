import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    // 网关把 *.devcloud.woa.com 反代到 127.0.0.1:5173，必须放行 Host，否则 Vite 6 会 403。
    allowedHosts: ['.devcloud.woa.com', 'localhost'],
    proxy: {
      '/api': 'http://localhost:7480',
      '/ws': { target: 'ws://localhost:7480', ws: true },
    },
  },
  build: { outDir: 'dist' },
})
