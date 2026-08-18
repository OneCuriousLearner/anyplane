// 最小 service worker：满足 PWA 可安装性（add to home screen）。
// 不做离线缓存——数据面全部走网络，缓存陈旧数据只会误导。
self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()))
self.addEventListener('fetch', () => {})
