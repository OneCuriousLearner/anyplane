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
  server: {
    // 服务器地址运行时由用户填（任意 host），静态配置只能放通配——否则壳内跳转
    // 会被 WebViewClient 甩给系统浏览器（Bridge.launchIntent 的默认行为）。
    // 实际白名单由 AnyPlaneBridgePlugin.shouldOverrideLoad 强制执行（本地源+已配置
    // 服务器源，其余外链甩外部浏览器）；此处的 ['*'] 只是插件放行后的兜底。
    allowNavigation: ['*'],
  },
};

export default config;
