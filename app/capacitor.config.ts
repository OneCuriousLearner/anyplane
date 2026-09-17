import type { CapacitorConfig } from '@capacitor/cli';

// hosted 模式（2026-09-16 定，替代 ROADMAP 方向二草稿里的 webDir: web/dist 打包模式）：
// 壳内不打包业务前端，WebView 直连用户自托管的 AnyPlane 服务端。
//   - /api 与 /ws 相对页面源不变，web/ 零改动；
//   - 前端版本永远与服务端匹配，前端修复不再需要发 app 版；
//   - server.url 是构建期静态值，运行时目标由 www 引导页读 localStorage 后跳转。
// 远端页面同样获得注入的 Capacitor 桥（hosted web app 模式），
// web/ 里的推送接入代码只在 window.Capacitor.isNativePlatform() 时激活。
const config: CapacitorConfig = {
  appId: 'run.anyplane',
  appName: 'AnyPlane',
  webDir: 'www',
};

export default config;
