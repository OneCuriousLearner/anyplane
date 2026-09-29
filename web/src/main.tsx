import { createRoot } from 'react-dom/client'
import App from './App'
import { applyAnyPlaneFavicon } from './components/AnyPlaneMark'
import './index.css'

applyAnyPlaneFavicon()

// PWA：最小 service worker（可安装到主屏；不做离线缓存）
// updateViaCache:'none'：sw.js 脚本自身的更新永远绕开 HTTP 缓存——自家 server 虽给 no-cache，
// 但将来若部署到第三方静态托管/反代，缓存头不再受我们控制（浏览器对 SW 脚本最多认 24h HTTP 缓存）
if ('serviceWorker' in navigator) {
  void navigator.serviceWorker.register('/sw.js', { updateViaCache: 'none' }).catch(() => {})
}

createRoot(document.getElementById('root')!).render(<App />)
