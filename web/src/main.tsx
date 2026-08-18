import { createRoot } from 'react-dom/client'
import App from './App'
import './index.css'

// PWA：最小 service worker（可安装到主屏；不做离线缓存）
if ('serviceWorker' in navigator) {
  void navigator.serviceWorker.register('/sw.js').catch(() => {})
}

createRoot(document.getElementById('root')!).render(<App />)
